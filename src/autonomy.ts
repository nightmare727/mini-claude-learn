import type { LlmClient, ToolDefinition } from "./types.js";

export async function evaluateGoal(
  condition: string,
  transcript: string,
  client: LlmClient,
  model: string,
): Promise<{ met: boolean; reason: string }> {
  const reply = await client.messages.create({
    model,
    max_tokens: 256,
    system:
      "You are a goal evaluator. Given a condition and a transcript, reply exactly 'MET' if the condition is satisfied, otherwise 'NOT_MET: <short reason>'.",
    messages: [{ role: "user", content: `Condition: ${condition}\n\nTranscript so far:\n${transcript}` }],
  });
  const text = reply.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (text.startsWith("MET")) return { met: true, reason: "" };
  return { met: false, reason: text.replace(/^NOT_MET:?\s*/, "") };
}

export async function classifyAction(
  toolName: string,
  input: unknown,
  transcript: string,
  client: LlmClient,
  model: string,
): Promise<{ allow: boolean; reason: string }> {
  const reply = await client.messages.create({
    model,
    max_tokens: 256,
    system:
      "You are a security monitor for an autonomous coding agent. Given the transcript and a tool call, reply exactly 'ALLOW' if it is safe to run unattended, otherwise 'BLOCK: <short reason>'. Err on the side of blocking.",
    messages: [
      {
        role: "user",
        content: `Transcript:\n${transcript}\n\nTool call: ${toolName}(${JSON.stringify(input)})`,
      },
    ],
  });
  const text = reply.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (text.startsWith("ALLOW")) return { allow: true, reason: "" };
  return { allow: false, reason: text.replace(/^BLOCK:?\s*/, "") };
}

export type LoopSpec = {
  mode: "interval" | "dynamic";
  prompt: string;
  intervalSeconds?: number;
  intervalLabel?: string;
};

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export function parseDurationToSeconds(token: string): number | null {
  const match = token.match(/^(\d+)([smhd])$/);
  if (!match) return null;
  return Number(match[1]) * UNIT_SECONDS[match[2]];
}

export function parseLoopInput(raw: string): LoopSpec | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "usage: /loop [interval] <prompt>" };
  const space = trimmed.indexOf(" ");
  const first = space > 0 ? trimmed.slice(0, space) : trimmed;
  const lead = parseDurationToSeconds(first);
  if (lead !== null) {
    const prompt = space > 0 ? trimmed.slice(space + 1).trim() : "";
    if (!prompt) return { error: "usage: /loop [interval] <prompt>" };
    return { mode: "interval", prompt, intervalSeconds: lead, intervalLabel: first };
  }
  const every = trimmed.match(/\bevery\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*$/i);
  if (every) {
    const secs = Number(every[1]) * UNIT_SECONDS[every[2][0].toLowerCase()];
    const prompt = trimmed.slice(0, every.index).trim();
    if (!prompt) return { error: "usage: /loop [interval] <prompt>" };
    return { mode: "interval", prompt, intervalSeconds: secs, intervalLabel: `${every[1]}${every[2][0]}` };
  }
  return { mode: "dynamic", prompt: trimmed };
}

export function clampWakeupDelay(seconds: number): number {
  if (!Number.isFinite(seconds)) return 60;
  return Math.max(60, Math.min(3600, Math.round(seconds)));
}

export function dynamicLoopDirective(prompt: string): string {
  return (
    `# Autonomous loop tick (dynamic pacing)\n\nDo this task:\n\n${prompt}\n\n` +
    "When done, call schedule_wakeup with delaySeconds and the same prompt to run again, or do not call it to end the loop."
  );
}

export const LOOP_MAX_ITERATIONS = 8;

export const SCHEDULE_WAKEUP_TOOL: ToolDefinition = {
  name: "schedule_wakeup",
  description:
    "In /loop dynamic mode, schedule the next run. Omit this tool to stop. delaySeconds is clamped to [60, 3600].",
  input_schema: {
    type: "object",
    properties: {
      delaySeconds: { type: "number" },
      reason: { type: "string" },
      prompt: { type: "string" },
    },
    required: ["delaySeconds", "reason", "prompt"],
  },
};
