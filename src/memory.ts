import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatFrontmatter, parseFrontmatter } from "./frontmatter.js";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export type MemoryEntry = {
  filename: string;
  name: string;
  description: string;
  type: MemoryType;
  content: string;
};

const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25_000;
const MAX_RECALL = 3;

function memoryDir(): string {
  return join(process.cwd(), ".mini-memory");
}

function indexPath(): string {
  return join(memoryDir(), "MEMORY.md");
}

function ensureDir(): string {
  const dir = memoryDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function listMemoryEntries(): MemoryEntry[] {
  const dir = memoryDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md") && file !== "MEMORY.md")
    .map((file) => readEntry(file))
    .filter((entry): entry is MemoryEntry => entry !== null);
}

export function listMemories(): string[] {
  return listMemoryEntries().map((entry) => `${entry.filename} (${entry.type}) — ${entry.description}`);
}

export function saveMemory(input: {
  name: string;
  description: string;
  type?: string;
  content: string;
}): string {
  const type = normalizeType(input.type);
  const name = input.name.trim() || "note";
  const filename = `${type}_${slugify(name)}.md`;
  writeFileSync(
    join(ensureDir(), filename),
    formatFrontmatter(
      { name, description: input.description.trim() || name, type },
      input.content.trim(),
    ),
  );
  updateMemoryIndex();
  return filename;
}

export function getMemory(nameOrFile: string): MemoryEntry | undefined {
  const want = nameOrFile.trim();
  return listMemoryEntries().find(
    (entry) => entry.filename === want || entry.name === want || entry.filename === `${want}.md`,
  );
}

export function executeMemory(input: Record<string, unknown>): string {
  const action = String(input.action || "list");
  if (action === "list") {
    const entries = listMemoryEntries();
    if (entries.length === 0) return "No memories saved.";
    return entries.map((e) => `- ${e.filename} [${e.type}] ${e.name}: ${e.description}`).join("\n");
  }
  if (action === "get") {
    const entry = getMemory(String(input.name || input.filename || ""));
    if (!entry) return `Unknown memory: ${String(input.name || input.filename || "")}`;
    return formatEntry(entry);
  }
  if (action === "save") {
    const filename = saveMemory({
      name: String(input.name || ""),
      description: String(input.description || ""),
      type: String(input.type || "project"),
      content: String(input.content || ""),
    });
    return `Saved memory ${filename}`;
  }
  return `Unknown memory action: ${action}. Use save, list, or get.`;
}

export function loadMemoryIndex(): string {
  updateMemoryIndex();
  if (!existsSync(indexPath())) return "";
  let content = readFileSync(indexPath(), "utf-8");
  const lines = content.split("\n");
  if (lines.length > MAX_INDEX_LINES) {
    content = `${lines.slice(0, MAX_INDEX_LINES).join("\n")}\n\n[... truncated, too many memory entries ...]`;
  }
  if (Buffer.byteLength(content) > MAX_INDEX_BYTES) {
    content = `${content.slice(0, MAX_INDEX_BYTES)}\n\n[... truncated, index too large ...]`;
  }
  return content;
}

export function buildMemoryPromptSection(): string {
  const index = loadMemoryIndex();
  const dir = memoryDir();
  return `

# Memory
Persistent file memory lives in \`${dir}\`. Types: user (identity/prefs), feedback (how to behave), project (repo facts), reference (urls/docs).
- MEMORY.md is the index only. Do not assume it contains full notes.
- To read a note, call memory with action=get and name/filename.
- When the user says 记住/remember, or you learn a durable fact, call memory action=save.
- Do not invent memories that are not in the index or get results.

${index ? `## MEMORY.md\n${index}` : "No memories saved yet."}`;
}

export function recallMemories(query: string): string {
  const entries = listMemoryEntries();
  if (entries.length === 0) return "";
  const queryWords = words(query);
  const scored = entries
    .map((entry) => ({
      entry,
      score: overlap(queryWords, words(`${entry.name} ${entry.description} ${entry.content}`)),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RECALL);
  if (scored.length === 0) return "";
  const blocks = scored.map((row) => formatEntry(row.entry)).join("\n\n");
  return `\n\n# Recalled memory (relevant to this turn)\n${blocks}`;
}

function updateMemoryIndex(): void {
  if (!existsSync(memoryDir()) && listMemoryEntries().length === 0) return;
  const lines = ["# Memory Index", ""];
  for (const entry of listMemoryEntries()) {
    lines.push(`- **[${entry.name}](${entry.filename})** (${entry.type}) — ${entry.description}`);
  }
  if (lines.length === 2) lines.push("(empty)");
  writeFileSync(join(ensureDir(), "MEMORY.md"), `${lines.join("\n")}\n`);
}

function readEntry(filename: string): MemoryEntry | null {
  try {
    const raw = readFileSync(join(memoryDir(), filename), "utf-8");
    const parsed = parseFrontmatter(raw);
    const body = parsed.body || raw.trim();
    return {
      filename,
      name: parsed.meta.name || filename.replace(/\.md$/, ""),
      description: parsed.meta.description || firstLine(body),
      type: normalizeType(parsed.meta.type),
      content: body,
    };
  } catch {
    return null;
  }
}

function formatEntry(entry: MemoryEntry): string {
  return `### ${entry.name} (${entry.type}, ${entry.filename})\n${entry.content}`;
}

function normalizeType(value: string | undefined): MemoryType {
  return MEMORY_TYPES.includes(value as MemoryType) ? (value as MemoryType) : "project";
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return slug || "note";
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
}

function overlap(query: Set<string>, hay: Set<string>): number {
  let score = 0;
  for (const word of query) if (hay.has(word)) score++;
  return score;
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim())?.trim() ?? "";
}
