import { randomUUID } from "node:crypto";
import {
  classifyAction,
  clampWakeupDelay,
  dynamicLoopDirective,
  evaluateGoal,
  LOOP_MAX_ITERATIONS,
  SCHEDULE_WAKEUP_TOOL,
  type LoopSpec,
} from "./autonomy.js";
import { lastUserTask, maybeCompact } from "./context.js";
import {
  beginTurn,
  createFileHistory,
  dropTurnsAfter,
  restoreToTurn,
  trackBeforeWrite,
  type FileHistoryState,
} from "./file-history.js";
import { connectMcp, type McpConnection } from "./mcp.js";
import { buildMemoryPromptSection, executeMemory, recallMemories } from "./memory.js";
import { checkPermission, WRITE_TOOLS } from "./permissions.js";
import { buildStaticSystemPrompt } from "./prompt.js";
import { activateSkill } from "./skills.js";
import { runSubAgent } from "./subagent.js";
import { CONCURRENCY_SAFE_TOOLS, executeTool, getActiveToolDefinitions } from "./tools.js";
import type {
  AgentMode,
  LlmClient,
  Message,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
  Usage,
} from "./types.js";

function currentModel(): string {
  return process.env.MINI_MODEL || "grok-4.6";
}

const MAX_TURNS = 20;
const FILE_WRITE_TOOLS = new Set(["write_file", "edit_file"]);
const INPUT_USD_PER_M = 3;
const OUTPUT_USD_PER_M = 15;

export type ConfirmFn = (message: string) => Promise<boolean>;

export type UserTurn = { id: string; text: string };

export class Agent {
  private readonly messages: Message[] = [];
  private userTurns: UserTurn[] = [];
  private fileHistory: FileHistoryState = createFileHistory();
  private currentTurnId: string | null = null;
  private mcp: McpConnection | null = null;
  private readonly mtimes = new Map<string, number>();
  private usage: Usage = { input_tokens: 0, output_tokens: 0 };
  private confirmFn: ConfirmFn | null = null;
  private wakeup: { delaySeconds: number; prompt: string; reason: string } | null = null;
  private looping = false;
  mode: AgentMode = "default";
  maxCostUsd = 0;
  maxTurnsBudget = 0;

  constructor(private readonly client: LlmClient) {}

  setConfirm(fn: ConfirmFn | null): void {
    this.confirmFn = fn;
  }

  usageSummary(): string {
    const cost =
      (this.usage.input_tokens / 1_000_000) * INPUT_USD_PER_M +
      (this.usage.output_tokens / 1_000_000) * OUTPUT_USD_PER_M;
    return `tokens in=${this.usage.input_tokens} out=${this.usage.output_tokens}  est. $${cost.toFixed(4)}`;
  }

  history(): Message[] {
    return this.messages;
  }

  rewindPoints(): UserTurn[] {
    return [...this.userTurns];
  }

  snapshot(): { messages: Message[]; userTurns: UserTurn[]; fileHistory: FileHistoryState } {
    return {
      messages: this.messages,
      userTurns: this.userTurns,
      fileHistory: this.fileHistory,
    };
  }

  loadHistory(messages: Message[]): void {
    this.messages.splice(0, this.messages.length, ...messages);
  }

  loadSnapshot(snapshot: {
    messages: Message[];
    userTurns?: UserTurn[];
    fileHistory?: FileHistoryState;
  }): void {
    this.messages.splice(0, this.messages.length, ...snapshot.messages);
    this.userTurns = snapshot.userTurns ? [...snapshot.userTurns] : [];
    this.fileHistory = snapshot.fileHistory ?? createFileHistory();
  }

  clearHistory(): void {
    this.messages.length = 0;
    this.userTurns = [];
    this.fileHistory = createFileHistory();
    this.currentTurnId = null;
    this.mtimes.clear();
  }

  async compactNow(): Promise<void> {
    const prev = process.env.MINI_COMPACT_CHARS;
    process.env.MINI_COMPACT_CHARS = "1";
    try {
      const last = lastUserTask(this.messages);
      this.messages.splice(
        0,
        this.messages.length,
        ...(await maybeCompact(this.messages, this.client, currentModel(), last)),
      );
    } finally {
      if (prev === undefined) delete process.env.MINI_COMPACT_CHARS;
      else process.env.MINI_COMPACT_CHARS = prev;
    }
  }

  rewindTo(turnIdOrIndex: string | number): { prompt: string; files: { restored: string[]; deleted: string[] } } {
    const turn = this.resolveTurn(turnIdOrIndex);
    if (!turn) throw new Error(`No rewind point: ${String(turnIdOrIndex)}`);
    const index = this.userTurns.indexOf(turn);
    const files = restoreToTurn(this.fileHistory, turn.id);
    const keep = new Set(this.userTurns.slice(0, index + 1).map((item) => item.id));
    dropTurnsAfter(this.fileHistory, keep);
    const cut = findUserTurnIndex(this.messages, index);
    if (cut >= 0) this.messages.splice(cut);
    this.userTurns = this.userTurns.slice(0, index);
    this.currentTurnId = this.userTurns.at(-1)?.id ?? null;
    return { prompt: turn.text, files };
  }

  setMode(mode: AgentMode): void {
    this.mode = mode;
  }

  transcriptText(): string {
    return this.messages
      .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : "[tool call / result]"}`)
      .join("\n");
  }

  async chat(userText: string): Promise<void> {
    const turnId = randomUUID();
    const previous = this.userTurns.at(-1)?.id;
    beginTurn(this.fileHistory, turnId, previous);
    this.currentTurnId = turnId;
    this.userTurns.push({ id: turnId, text: userText });
    this.messages.push({ role: "user", content: userText });
    await this.ensureMcp();

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      this.messages.splice(
        0,
        this.messages.length,
        ...(await maybeCompact(this.messages, this.client, currentModel(), userText)),
      );

      const staticSystem = buildStaticSystemPrompt();
      const dynamicSystem =
        `${buildMemoryPromptSection()}${recallMemories(userText)}` +
        `\n\n# Current user request\n${userText}\nStay on this request. Do not switch to weather, another skill, or a different topic unless the user asked for it.`;

      if (this.maxTurnsBudget > 0 && turn + 1 > this.maxTurnsBudget) {
        console.log(`  (stopped: max-turns ${this.maxTurnsBudget})`);
        return;
      }
      if (this.maxCostUsd > 0 && this.estimatedCost() >= this.maxCostUsd) {
        console.log(`  (stopped: max-cost $${this.maxCostUsd})`);
        return;
      }

      const mcpTools: ToolDefinition[] = (this.mcp?.tools || []).map((t) => ({
        name: `mcp__demo__${t.name}`,
        description: t.description,
        input_schema: (t.input_schema as Record<string, unknown>) ?? { type: "object", properties: {} },
      }));
      const tools = [...getActiveToolDefinitions(), ...mcpTools];
      if (this.looping) tools.push(SCHEDULE_WAKEUP_TOOL);
      if (tools.length > 0) tools[tools.length - 1].cache_control = { type: "ephemeral" };

      const request = {
        model: currentModel(),
        max_tokens: 4096,
        system: [
          { type: "text" as const, text: staticSystem, cache_control: { type: "ephemeral" as const } },
          { type: "text" as const, text: dynamicSystem },
        ],
        tools,
        messages: this.messages,
      };

      const streamed = Boolean(this.client.messages.stream);
      const reply = await withRetry(() =>
        streamed
          ? this.client.messages.stream!(request, (t) => process.stdout.write(t))
          : this.client.messages.create(request),
      );
      this.addUsage(reply.usage);
      if (!streamed) {
        for (const block of reply.content) {
          if (block.type === "text") process.stdout.write(block.text);
        }
      }
      process.stdout.write("\n");

      this.messages.push({ role: "assistant", content: reply.content });

      const toolUses = reply.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) return;

      const results: ToolResultBlock[] = new Array(toolUses.length);
      const unsafe: number[] = [];
      const safeRuns: Promise<void>[] = [];
      for (let i = 0; i < toolUses.length; i++) {
        const tu = toolUses[i];
        console.log(`  → ${tu.name}(${JSON.stringify(tu.input)})`);
        if (CONCURRENCY_SAFE_TOOLS.has(tu.name)) {
          safeRuns.push(
            this.runOneTool(tu).then((output) => {
              results[i] = { type: "tool_result", tool_use_id: tu.id, content: output };
            }),
          );
        } else {
          unsafe.push(i);
        }
      }
      await Promise.all(safeRuns);
      for (const i of unsafe) {
        const tu = toolUses[i];
        const output = await this.runOneTool(tu);
        results[i] = { type: "tool_result", tool_use_id: tu.id, content: output };
      }
      this.messages.push({ role: "user", content: results });
    }
    console.log("  (stopped after max turns)");
  }

  async pursueGoal(condition: string, prompt: string): Promise<void> {
    await this.chat(prompt);
    for (let i = 0; i < 5; i++) {
      const verdict = await evaluateGoal(condition, this.transcriptText(), this.client, currentModel());
      if (verdict.met) {
        console.log(`✓ goal met: ${condition}`);
        return;
      }
      console.log(`  (goal not met — ${verdict.reason}; continuing)`);
      await this.chat(`The goal "${condition}" is not met yet: ${verdict.reason}. Keep working toward it.`);
    }
    console.log(`  (gave up after 5 iterations without meeting: ${condition})`);
  }

  async runLoop(spec: LoopSpec): Promise<void> {
    const max = Math.max(1, Number(process.env.MINI_LOOP_MAX || LOOP_MAX_ITERATIONS));
    const sleepMs = Number(process.env.MINI_LOOP_SLEEP_MS);
    this.looping = true;
    try {
      if (spec.mode === "interval") {
        for (let i = 0; i < max; i++) {
          console.log(`  (loop ${i + 1}/${max}${spec.intervalLabel ? ` every ${spec.intervalLabel}` : ""})`);
          await this.chat(spec.prompt);
          if (i + 1 >= max) break;
          const wait = Number.isFinite(sleepMs) ? sleepMs : (spec.intervalSeconds || 60) * 1000;
          if (wait > 0) await delay(wait);
        }
        return;
      }
      let prompt = dynamicLoopDirective(spec.prompt);
      for (let i = 0; i < max; i++) {
        this.wakeup = null;
        console.log(`  (loop dynamic ${i + 1}/${max})`);
        await this.chat(prompt);
        const scheduled = this.wakeup as {
          delaySeconds: number;
          prompt: string;
          reason: string;
        } | null;
        if (!scheduled) {
          console.log("  (loop ended: no schedule_wakeup)");
          return;
        }
        const wait = Number.isFinite(sleepMs) ? sleepMs : scheduled.delaySeconds * 1000;
        console.log(`  (wakeup in ${scheduled.delaySeconds}s — ${scheduled.reason})`);
        if (wait > 0) await delay(wait);
        prompt = scheduled.prompt;
      }
    } finally {
      this.looping = false;
    }
  }

  private estimatedCost(): number {
    return (
      (this.usage.input_tokens / 1_000_000) * INPUT_USD_PER_M +
      (this.usage.output_tokens / 1_000_000) * OUTPUT_USD_PER_M
    );
  }

  private addUsage(usage?: Usage): void {
    if (!usage) return;
    this.usage.input_tokens += usage.input_tokens || 0;
    this.usage.output_tokens += usage.output_tokens || 0;
  }

  private async runOneTool(tu: ToolUseBlock): Promise<string> {
    if (tu.name === "agent") {
      const task = String(tu.input.task || tu.input.prompt || "");
      const type = String(tu.input.type || "explore");
      return runSubAgent(task, this.client, currentModel(), type);
    }
    if (tu.name === "skill") {
      return activateSkill(String(tu.input.skill_name || ""), String(tu.input.args || ""));
    }
    if (tu.name === "enter_plan_mode") {
      this.setMode("plan");
      return "Entered plan mode. Read-only except planning. Call tool_search / exit_plan_mode when ready to implement.";
    }
    if (tu.name === "exit_plan_mode") {
      this.setMode("default");
      return "Exited plan mode. You may edit files and run shell again.";
    }
    if (tu.name === "schedule_wakeup") {
      this.wakeup = {
        delaySeconds: clampWakeupDelay(Number(tu.input.delaySeconds)),
        prompt: String(tu.input.prompt || ""),
        reason: String(tu.input.reason || ""),
      };
      return `Scheduled wakeup in ${this.wakeup.delaySeconds}s (${this.wakeup.reason})`;
    }
    if (tu.name === "memory") {
      if (this.mode === "plan" && String(tu.input.action || "") === "save") {
        return "Denied: memory save was blocked (plan mode).";
      }
      return executeMemory(tu.input);
    }
    if (tu.name.startsWith("mcp__")) {
      const toolName = tu.name.split("__").slice(2).join("__");
      return this.mcp ? this.mcp.callTool(toolName, tu.input) : "Denied: no MCP server connected.";
    }
    const permission = checkPermission(tu.name, tu.input, this.mode);
    if (permission.action === "deny") {
      return permission.message || `Denied: ${tu.name} was blocked by the permission system.`;
    }
    if (permission.action === "confirm") {
      if (this.mode === "auto" && WRITE_TOOLS.has(tu.name)) {
        const verdict = await classifyAction(tu.name, tu.input, this.transcriptText(), this.client, currentModel());
        if (!verdict.allow) return `Blocked by auto-mode monitor: ${verdict.reason}`;
      } else if (this.confirmFn) {
        const ok = await this.confirmFn(permission.message || tu.name);
        if (!ok) return `Denied: user rejected ${tu.name} (${permission.message || ""})`;
      } else {
        return permission.message
          ? `Denied: ${tu.name} was blocked by the permission system.`
          : `Denied: ${tu.name} was blocked by the permission system.`;
      }
    }
    if (this.mode === "auto" && WRITE_TOOLS.has(tu.name) && permission.action === "allow") {
      const verdict = await classifyAction(tu.name, tu.input, this.transcriptText(), this.client, currentModel());
      if (!verdict.allow) return `Blocked by auto-mode monitor: ${verdict.reason}`;
    }
    if (this.currentTurnId && FILE_WRITE_TOOLS.has(tu.name) && typeof tu.input.file_path === "string") {
      trackBeforeWrite(this.fileHistory, this.currentTurnId, tu.input.file_path);
    }
    return executeTool(tu.name, tu.input, this.mtimes);
  }

  private resolveTurn(turnIdOrIndex: string | number): UserTurn | undefined {
    if (typeof turnIdOrIndex === "number") return this.userTurns[turnIdOrIndex - 1];
    const asNumber = Number(turnIdOrIndex);
    if (/^\d+$/.test(turnIdOrIndex) && asNumber >= 1) return this.userTurns[asNumber - 1];
    return this.userTurns.find((turn) => turn.id === turnIdOrIndex || turn.id.startsWith(turnIdOrIndex));
  }

  close(): void {
    this.mcp?.close();
    this.mcp = null;
  }

  private async ensureMcp(): Promise<void> {
    if (this.mcp || !process.env.MINI_MCP_SERVER) return;
    const spec = process.env.MINI_MCP_SERVER;
    const [command, ...args] = spec.split(" ").filter(Boolean);
    this.mcp = await connectMcp(command, args);
  }
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const text = error instanceof Error ? error.message : String(error);
      if (!/429|503|529|ECONNRESET|ETIMEDOUT|overloaded/i.test(text) || i === attempts - 1) throw error;
      const delayMs = Math.min(1000 * 2 ** i, 8000);
      console.log(`  (retry ${i + 1}/${attempts} after ${delayMs}ms)`);
      await delay(delayMs);
    }
  }
  throw last;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findUserTurnIndex(messages: Message[], turnIndex: number): number {
  let seen = 0;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "user" || typeof message.content !== "string") continue;
    if (message.content.startsWith("[Summary of earlier conversation]")) continue;
    if (seen === turnIndex) return i;
    seen++;
  }
  return -1;
}
