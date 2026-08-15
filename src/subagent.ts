import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { executeTool, getActiveToolDefinitions, toolDefinitions } from "./tools.js";
import type { LlmClient, Message, ToolDefinition, ToolResultBlock, ToolUseBlock } from "./types.js";

export type SubAgentType = string;

const READ_ONLY = new Set(["read_file", "list_files", "grep_search", "web_fetch"]);

const PROMPTS: Record<string, string> = {
  explore:
    "You are a read-only explore sub-agent. Search and report. Do not write, edit, or run shell that changes state.",
  plan:
    "You are a read-only plan sub-agent. Inspect the repo and return a structured implementation plan. Do not modify files.",
  general:
    "You are a general sub-agent. Complete the task and return a concise report. Prefer editing existing files.",
};

function readOnlyTools(): ToolDefinition[] {
  return getActiveToolDefinitions().filter((tool) => READ_ONLY.has(tool.name));
}

function discoverCustom(): Map<string, { prompt: string; tools?: string[] }> {
  const found = new Map<string, { prompt: string; tools?: string[] }>();
  for (const dir of [join(homedir(), ".claude", "agents"), join(process.cwd(), ".claude", "agents"), join(process.cwd(), ".mini-agents")]) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      try {
        const parsed = parseFrontmatter(readFileSync(join(dir, file), "utf-8"));
        const name = parsed.meta.name || file.slice(0, -3);
        const allowed = parsed.meta["allowed-tools"]?.split(",").map((part) => part.trim());
        found.set(name, { prompt: parsed.body.trim() || PROMPTS.general, tools: allowed });
      } catch {
        // skip
      }
    }
  }
  return found;
}

export function getSubAgentConfig(type: SubAgentType): { systemPrompt: string; tools: ToolDefinition[] } {
  const custom = discoverCustom().get(type);
  if (custom) {
    const tools = custom.tools
      ? toolDefinitions.filter((tool) => custom.tools!.includes(tool.name) && tool.name !== "agent")
      : toolDefinitions.filter((tool) => tool.name !== "agent");
    return { systemPrompt: custom.prompt, tools };
  }
  if (type === "explore" || type === "plan") {
    return { systemPrompt: PROMPTS[type], tools: readOnlyTools() };
  }
  return {
    systemPrompt: PROMPTS.general,
    tools: getActiveToolDefinitions().filter((tool) => tool.name !== "agent"),
  };
}

export function buildAgentDescriptions(): string {
  const extras = [...discoverCustom().entries()].map(([name, def]) => `- ${name}: ${def.prompt.split("\n")[0]}`);
  if (!extras.length) return "";
  return `\n# Custom Agent Types\n${extras.join("\n")}`;
}

export async function runSubAgent(task: string, client: LlmClient, model: string, type = "explore"): Promise<string> {
  const config = getSubAgentConfig(type);
  const messages: Message[] = [{ role: "user", content: task }];
  const tools = config.tools;

  for (let turn = 0; turn < 8; turn++) {
    const reply = await client.messages.create({
      model,
      max_tokens: 4096,
      system: config.systemPrompt,
      tools,
      messages,
    });
    messages.push({ role: "assistant", content: reply.content });

    const toolUses = reply.content.filter((block): block is ToolUseBlock => block.type === "tool_use");
    if (toolUses.length === 0) {
      return reply.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
    }

    const results: ToolResultBlock[] = [];
    for (const tu of toolUses) {
      const allowed = tools.some((tool) => tool.name === tu.name);
      const output = allowed ? await executeTool(tu.name, tu.input) : "Denied: the sub-agent may not use this tool.";
      results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }
  return "Sub-agent stopped after 8 turns without a final summary.";
}
