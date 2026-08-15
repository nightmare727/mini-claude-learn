import type { LlmClient, Message, ToolResultBlock } from "./types.js";

const DEFAULT_COMPACT_CHARS = 48_000;
const KEEP_RECENT = 4;
const SNIP = 800;

export function compactCharThreshold(): number {
  const raw = Number(process.env.MINI_COMPACT_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COMPACT_CHARS;
}

export function messageChars(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + JSON.stringify(message.content).length, 0);
}

export function shouldCompact(messages: Message[]): boolean {
  return messageChars(messages) > compactCharThreshold();
}

const COMPACT_SYSTEM =
  "Summarize the conversation so far in a few sentences, keeping key facts. " +
  "Repeat the user's original task verbatim first. Only mention files, tools, and facts " +
  "that appear in the transcript. Do not invent a different project, genre, or topic.";

export async function maybeCompact(
  messages: Message[],
  client: LlmClient,
  model: string,
  currentUserText?: string,
): Promise<Message[]> {
  if (!shouldCompact(messages)) return messages;

  const pinned = currentUserText?.trim() || lastUserTask(messages);
  const { older, recent } = splitKeepRecent(messages);
  if (older.length === 0) return messages;

  const taskLine = pinned ? `Current user request (do not replace): ${pinned}\n\n` : "";
  const transcript = taskLine + older.map(renderMessage).join("\n");

  const reply = await client.messages.create({
    model,
    max_tokens: 1024,
    system: COMPACT_SYSTEM,
    messages: [{ role: "user", content: transcript }],
  });
  const summary = reply.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  console.log(`  (compacted ${older.length} messages into a summary)`);

  const compacted: Message[] = [];
  if (pinned && !recentHasSameUserText(recent, pinned)) {
    compacted.push({ role: "user", content: pinned });
  }
  compacted.push({
    role: "user",
    content: `[Summary of earlier conversation]\nCurrent user request: ${pinned ?? "(unknown)"}\n${summary}`,
  });
  compacted.push(...recent);
  return compacted;
}

export function firstUserTask(messages: Message[]): string | undefined {
  return userTasks(messages)[0];
}

export function lastUserTask(messages: Message[]): string | undefined {
  const tasks = userTasks(messages);
  return tasks[tasks.length - 1];
}

function userTasks(messages: Message[]): string[] {
  const tasks: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content !== "string") continue;
    if (message.content.startsWith("[Summary of earlier conversation]")) continue;
    if (message.content.startsWith("[Skill \"")) continue;
    const text = message.content.trim();
    if (text) tasks.push(text);
  }
  return tasks;
}

function splitKeepRecent(messages: Message[]): { older: Message[]; recent: Message[] } {
  let cut = Math.max(0, messages.length - KEEP_RECENT);
  while (cut > 0 && isToolResultMessage(messages[cut]) && messages[cut - 1]?.role === "assistant") {
    cut--;
  }
  return { older: messages.slice(0, cut), recent: messages.slice(cut) };
}

function isToolResultMessage(message: Message | undefined): boolean {
  return Boolean(message && message.role === "user" && Array.isArray(message.content));
}

function recentHasSameUserText(recent: Message[], text: string): boolean {
  return recent.some((m) => m.role === "user" && m.content === text);
}

function renderMessage(message: Message): string {
  if (message.role === "user") {
    if (typeof message.content === "string") return `user: ${snip(message.content)}`;
    return message.content.map(renderToolResult).join("\n");
  }
  return message.content
    .map((block) => {
      if (block.type === "text") return `assistant: ${snip(block.text)}`;
      return `tool_use ${block.name}(${snip(JSON.stringify(block.input))})`;
    })
    .join("\n");
}

function renderToolResult(block: ToolResultBlock): string {
  return `tool_result ${block.tool_use_id}: ${snip(block.content)}`;
}

function snip(text: string): string {
  if (text.length <= SNIP) return text;
  const keep = Math.floor((SNIP - 20) / 2);
  return `${text.slice(0, keep)}\n…[${text.length - keep * 2} chars]…\n${text.slice(-keep)}`;
}
