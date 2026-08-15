import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { glob } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { ToolDefinition } from "./types.js";

export const CONCURRENCY_SAFE_TOOLS = new Set(["read_file", "list_files", "grep_search", "web_fetch"]);

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read the contents of a file. Returns the file content with line numbers.",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string", description: "The path to the file to read" } },
      required: ["file_path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file. Creates it if missing, overwrites if it exists.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The path to the file to write" },
        content: { type: "string", description: "The content to write" },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact string in a file with new content. old_string must match exactly and be unique.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The path to the file to edit" },
        old_string: { type: "string", description: "The exact string to find" },
        new_string: { type: "string", description: "The string to replace it with" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  {
    name: "list_files",
    description:
      'List files matching a glob pattern (e.g. "**/*.ts"). Workspace only — path must be inside cwd. Never pass $HOME or /Users.',
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern to match files" },
        path: { type: "string", description: "Base directory. Defaults to cwd." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep_search",
    description: "Search for a regex pattern in files. Returns matching lines with paths and line numbers.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The regex pattern to search for" },
        path: { type: "string", description: "Directory or file to search. Defaults to cwd." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "run_shell",
    description:
      "Execute a shell command and return its output. For tests, git, curl, package installs. Filesystem paths must stay inside cwd — ls/find of $HOME is denied.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string", description: "The shell command to execute" } },
      required: ["command"],
    },
  },
  {
    name: "skill",
    description:
      "Load a skill playbook by name. The system prompt lists only name + when-to-use; this tool returns the full instructions.",
    input_schema: {
      type: "object",
      properties: {
        skill_name: { type: "string", description: "Skill name from the Skills catalog" },
        args: { type: "string", description: "Optional arguments for the skill" },
      },
      required: ["skill_name"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch a URL and return readable text. Use for docs/pages/APIs instead of curling via run_shell.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "http(s) URL to fetch" },
        max_length: { type: "number", description: "Max characters (default 12000)" },
      },
      required: ["url"],
    },
  },
  {
    name: "todo_write",
    description:
      "Replace the in-session task list. Use for multi-step work. statuses: pending | in_progress | completed.",
    input_schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "Full replacement list",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: { type: "string" },
            },
          },
        },
      },
      required: ["todos"],
    },
  },
  {
    name: "enter_plan_mode",
    description: "Switch to read-only plan mode to design an approach before editing.",
    input_schema: { type: "object", properties: {} },
    deferred: true,
  },
  {
    name: "exit_plan_mode",
    description: "Leave plan mode after the plan is written so implementation can start.",
    input_schema: { type: "object", properties: {} },
    deferred: true,
  },
  {
    name: "tool_search",
    description: "Load a deferred tool's full schema by name or keyword (enter_plan_mode, exit_plan_mode).",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Tool name or keyword" } },
      required: ["query"],
    },
  },
  {
    name: "agent",
    description:
      "Delegate to a sub-agent. Types: explore (read-only search), plan (read-only design), general (full tools).",
    input_schema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The task for the sub-agent" },
        prompt: { type: "string", description: "Alias of task" },
        type: { type: "string", description: "explore | plan | general" },
      },
      required: ["task"],
    },
  },
  {
    name: "memory",
    description:
      "Persistent cross-session memory. action=save stores a note, list shows the index, get loads one file. Types: user, feedback, project, reference.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", description: "save | list | get" },
        name: { type: "string", description: "Short title (save/get)" },
        description: { type: "string", description: "One-line when-to-use (save)" },
        type: { type: "string", description: "user | feedback | project | reference" },
        content: { type: "string", description: "Full note body (save)" },
        filename: { type: "string", description: "File name for get, e.g. project_staging.md" },
      },
      required: ["action"],
    },
  },
];

const MAX_RESULT_CHARS = 16_000;
const MAX_LIST_FILES = 80;

const activatedTools = new Set<string>();

export function resetActivatedTools(): void {
  activatedTools.clear();
}

export function getActiveToolDefinitions(all = toolDefinitions): ToolDefinition[] {
  return all
    .filter((tool) => !tool.deferred || activatedTools.has(tool.name))
    .map(({ deferred: _deferred, ...rest }) => rest);
}

export function getDeferredToolNames(all = toolDefinitions): string[] {
  return all.filter((tool) => tool.deferred && !activatedTools.has(tool.name)).map((tool) => tool.name);
}

export type TodoItem = { id: string; content: string; status: string };

let todos: TodoItem[] = [];

export function listTodos(): TodoItem[] {
  return [...todos];
}

export function resetTodos(): void {
  todos = [];
}

const OUTSIDE_WORKSPACE =
  "Denied: stay inside the workspace. Do not scan $HOME for skills. " +
  "Call the skill tool with a catalog name, or do the task with run_shell (curl).";

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  mtimes?: Map<string, number>,
): Promise<string> {
  const blocked = denyOutsideWorkspace(name, input);
  if (blocked) return blocked;
  let result: string;
  switch (name) {
    case "read_file": {
      const filePath = String(input.file_path ?? "");
      result = readFile({ file_path: filePath });
      noteMtime(mtimes, filePath, result);
      break;
    }
    case "write_file": {
      const filePath = String(input.file_path ?? "");
      const stale = staleWrite(mtimes, filePath, "writing");
      if (stale) return stale;
      result = writeFile({ file_path: filePath, content: String(input.content ?? "") });
      noteMtime(mtimes, filePath, result);
      break;
    }
    case "edit_file": {
      const filePath = String(input.file_path ?? "");
      const stale = staleWrite(mtimes, filePath, "editing");
      if (stale) return stale;
      result = editFile({
        file_path: filePath,
        old_string: String(input.old_string ?? ""),
        new_string: String(input.new_string ?? ""),
      });
      noteMtime(mtimes, filePath, result);
      break;
    }
    case "list_files":
      result = await listFiles({
        pattern: String(input.pattern ?? ""),
        path: input.path === undefined ? undefined : String(input.path),
      });
      break;
    case "grep_search":
      result = grepSearch({
        pattern: String(input.pattern ?? ""),
        path: input.path === undefined ? undefined : String(input.path),
      });
      break;
    case "run_shell":
      result = runShell({ command: String(input.command ?? "") });
      break;
    case "web_fetch":
      result = await webFetch({
        url: String(input.url ?? ""),
        max_length: Number(input.max_length) || 12_000,
      });
      break;
    case "todo_write":
      result = writeTodos(input.todos);
      break;
    case "tool_search":
      result = searchDeferredTools(String(input.query ?? ""));
      break;
    default:
      result = `Unknown tool: ${name}`;
  }
  return truncateResult(result);
}

function noteMtime(mtimes: Map<string, number> | undefined, filePath: string, result: string): void {
  if (!mtimes || result.startsWith("Error") || result.startsWith("Denied")) return;
  try {
    const abs = resolve(process.cwd(), filePath);
    mtimes.set(abs, statSync(abs).mtimeMs);
  } catch {
    // missing file
  }
}

function staleWrite(mtimes: Map<string, number> | undefined, filePath: string, verb: string): string | null {
  if (!mtimes) return null;
  const abs = resolve(process.cwd(), filePath);
  if (!existsSync(abs)) return null;
  if (!mtimes.has(abs)) return null;
  try {
    if (statSync(abs).mtimeMs !== mtimes.get(abs)) {
      return `Warning: ${filePath} changed since last read. Read it again before ${verb}.`;
    }
  } catch {
    return null;
  }
  return null;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function webFetch(input: { url: string; max_length: number }): Promise<string> {
  if (!/^https?:\/\//i.test(input.url)) return "Error: url must be http(s)";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(input.url, {
      signal: controller.signal,
      headers: { "user-agent": "mini-claude-learn/1.0" },
    });
    if (!res.ok) return `HTTP error: ${res.status} ${res.statusText}`;
    const type = res.headers.get("content-type") || "";
    let text = await res.text();
    if (type.includes("html")) text = htmlToText(text);
    if (text.length > input.max_length) {
      text = `${text.slice(0, input.max_length)}\n\n[... truncated at ${input.max_length} characters]`;
    }
    return text || "(empty response)";
  } catch (error) {
    return `Error fetching ${input.url}: ${errorMessage(error)}`;
  } finally {
    clearTimeout(timer);
  }
}

function writeTodos(raw: unknown): string {
  if (!Array.isArray(raw)) return "Error: todos must be an array";
  todos = raw.map((item, index) => {
    const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const status = String(row.status || "pending");
    return {
      id: String(row.id || index + 1),
      content: String(row.content || ""),
      status: ["pending", "in_progress", "completed"].includes(status) ? status : "pending",
    };
  });
  if (!todos.length) return "(no todos)";
  return todos.map((item) => `- [${item.status}] ${item.id}: ${item.content}`).join("\n");
}

function searchDeferredTools(query: string): string {
  const needle = query.toLowerCase();
  const matches = toolDefinitions.filter(
    (tool) =>
      tool.deferred &&
      (tool.name.toLowerCase().includes(needle) || (tool.description || "").toLowerCase().includes(needle)),
  );
  if (!matches.length) return "No matching deferred tools found.";
  for (const tool of matches) activatedTools.add(tool.name);
  return JSON.stringify(
    matches.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })),
    null,
    2,
  );
}

function workspaceRoot(): string {
  return resolve(process.cwd());
}

function isInsideWorkspace(absPath: string): boolean {
  const root = workspaceRoot();
  const abs = resolve(absPath);
  return abs === root || abs.startsWith(root + sep);
}

function workspacePath(inputPath: string): { ok: true; path: string } | { ok: false; error: string } {
  const abs = resolve(workspaceRoot(), inputPath);
  if (!isInsideWorkspace(abs)) {
    return { ok: false, error: `${OUTSIDE_WORKSPACE} Path ${inputPath} is outside ${workspaceRoot()}.` };
  }
  return { ok: true, path: abs };
}

function denyOutsideWorkspace(name: string, input: Record<string, unknown>): string | null {
  if (name === "read_file" || name === "write_file" || name === "edit_file") {
    const scoped = workspacePath(String(input.file_path ?? ""));
    return scoped.ok ? null : scoped.error;
  }
  if (name === "list_files" || name === "grep_search") {
    const scoped = workspacePath(input.path === undefined ? "." : String(input.path));
    return scoped.ok ? null : scoped.error;
  }
  if (name === "run_shell") {
    const escaped = shellEscapesWorkspace(String(input.command ?? ""));
    return escaped ? `${OUTSIDE_WORKSPACE} Command touched ${escaped}.` : null;
  }
  return null;
}

function expandHome(text: string): string {
  const home = resolve(homedir());
  return text.replace(/\$HOME\b/g, home).replace(/(^|[\s="'()])~(?=\/|\s|$)/g, `$1${home}`);
}

function shellEscapesWorkspace(command: string): string | null {
  const expanded = expandHome(command);
  const matches = expanded.match(/(?:^|[\s"'=(])((?:\/(?:Users|home)\/|\/Users\/)[^\s"';|&)]+)/g);
  if (!matches) return null;
  for (const raw of matches) {
    const path = raw.trim().replace(/^['"=(]+/, "");
    if (!isInsideWorkspace(path)) return path;
  }
  return null;
}

function readFile(input: { file_path: string }): string {
  const scoped = workspacePath(input.file_path);
  if (!scoped.ok) return scoped.error;
  try {
    const lines = readFileSync(scoped.path, "utf-8").split("\n");
    return lines.map((line, i) => `${String(i + 1).padStart(4)} | ${line}`).join("\n");
  } catch (error) {
    return `Error reading file: ${errorMessage(error)}`;
  }
}

function writeFile(input: { file_path: string; content: string }): string {
  const scoped = workspacePath(input.file_path);
  if (!scoped.ok) return scoped.error;
  try {
    const dir = dirname(scoped.path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(scoped.path, input.content);
    const n = input.content.split("\n").length;
    return `Successfully wrote to ${input.file_path} (${n} lines)`;
  } catch (error) {
    return `Error writing file: ${errorMessage(error)}`;
  }
}

function normalizeQuotes(text: string): string {
  return text.replace(/[\u2018\u2019\u2032]/g, "'").replace(/[\u201C\u201D\u2033]/g, '"');
}

function findActualString(content: string, search: string): string | null {
  if (content.includes(search)) return search;
  const idx = normalizeQuotes(content).indexOf(normalizeQuotes(search));
  if (idx === -1) return null;
  return content.slice(idx, idx + search.length);
}

function editFile(input: {
  file_path: string;
  old_string: string;
  new_string: string;
}): string {
  const scoped = workspacePath(input.file_path);
  if (!scoped.ok) return scoped.error;
  try {
    const content = readFileSync(scoped.path, "utf-8");
    const actual = findActualString(content, input.old_string);
    if (!actual) return `Error: old_string not found in ${input.file_path}`;
    const count = content.split(actual).length - 1;
    if (count > 1) {
      return `Error: old_string found ${count} times in ${input.file_path}. Must be unique.`;
    }
    const updated = content.split(actual).join(input.new_string);
    writeFileSync(scoped.path, updated);
    const line = content.slice(0, content.indexOf(actual)).split("\n").length;
    const quoteNote = actual !== input.old_string ? " (matched via quote normalization)" : "";
    const diff = [
      `@@ -${line},${actual.split("\n").length} +${line},${input.new_string.split("\n").length} @@`,
      ...actual.split("\n").map((row) => `- ${row}`),
      ...input.new_string.split("\n").map((row) => `+ ${row}`),
    ].join("\n");
    return `Successfully edited ${input.file_path}${quoteNote}\n\n${diff}`;
  } catch (error) {
    return `Error editing file: ${errorMessage(error)}`;
  }
}

async function listFiles(input: { pattern: string; path?: string }): Promise<string> {
  const scoped = workspacePath(input.path || ".");
  if (!scoped.ok) return scoped.error;
  try {
    const files: string[] = [];
    for await (const file of glob(input.pattern, { cwd: scoped.path })) {
      if (file.includes("node_modules") || file.includes(".git/")) continue;
      files.push(file);
      if (files.length >= MAX_LIST_FILES) break;
    }
    if (!files.length) return "No files found matching the pattern.";
    const extra = files.length >= MAX_LIST_FILES ? `\n(truncated to ${MAX_LIST_FILES} files)` : "";
    return files.join("\n") + extra;
  } catch (error) {
    return `Error listing files: ${errorMessage(error)}`;
  }
}

function grepSearch(input: { pattern: string; path?: string }): string {
  const scoped = workspacePath(input.path || ".");
  if (!scoped.ok) return scoped.error;
  try {
    const out = execFileSync(
      "grep",
      ["--line-number", "--color=never", "-r", "--", input.pattern, scoped.path],
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 10000 },
    );
    return out.split("\n").filter(Boolean).slice(0, 100).join("\n") || "No matches found.";
  } catch (error) {
    if (isExecError(error) && error.status === 1) return "No matches found.";
    return grepJs(input.pattern, scoped.path);
  }
}

function grepJs(pattern: string, dir: string): string {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (error) {
    return `Error: invalid regex: ${errorMessage(error)}`;
  }
  const matches: string[] = [];
  const walk = (current: string) => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(current, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        readFileSync(full, "utf-8")
          .split("\n")
          .forEach((line, i) => {
            if (re.test(line) && matches.length < 100) matches.push(`${full}:${i + 1}:${line}`);
          });
      } catch {
        // skip binary / unreadable files
      }
    }
  };
  walk(dir);
  return matches.length ? matches.join("\n") : "No matches found.";
}

function runShell(input: { command: string }): string {
  try {
    return (
      execSync(input.command, {
        encoding: "utf-8",
        maxBuffer: 5 * 1024 * 1024,
        timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"],
        shell: "/bin/sh",
      }) || "(no output)"
    );
  } catch (error) {
    if (!isExecError(error)) return `Error: ${errorMessage(error)}`;
    const stdout = error.stdout ? `\nStdout: ${error.stdout}` : "";
    const stderr = error.stderr ? `\nStderr: ${error.stderr}` : "";
    return `Command failed (exit ${error.status})${stdout}${stderr}`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateResult(result: string): string {
  if (result.length <= MAX_RESULT_CHARS) return result;
  const keep = Math.floor((MAX_RESULT_CHARS - 80) / 2);
  return (
    `${result.slice(0, keep)}\n\n[... truncated ${result.length - keep * 2} chars ...]\n\n${result.slice(-keep)}`
  );
}

function isExecError(
  error: unknown,
): error is Error & { status?: number; stdout?: string; stderr?: string } {
  return typeof error === "object" && error !== null;
}
