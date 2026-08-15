import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { formatSkillCatalog } from "./skills.js";
import { getDeferredToolNames } from "./tools.js";

const STATIC_CORE = `You are Mini Claude Code, a small coding assistant CLI.
You help with software engineering tasks using the tools available to you.

# Doing tasks
 - Do not propose changes to code you haven't read. Read files first.
 - Do not create files unless necessary. Prefer editing existing files.
 - Avoid over-engineering. Only make changes that were requested.

# Executing actions with care
 - Prefer reversible actions. For risky or destructive ones (rm -rf, git push,
   dropping tables), confirm with the user before proceeding.

# Using your tools
 - Use read_file / edit_file / list_files / grep_search instead of shell cat,
   sed, ls, grep. Reserve run_shell for actual shell operations.
 - File tools and shell filesystem paths stay inside the current workspace.
   Never list_files / grep / ls / find $HOME, /Users, ~/.claude, or other repos
   looking for skills. Skills exist only in the Skills catalog below.
 - If several tool calls are independent, make them in parallel.

# Tone and style
 - Keep responses short and concise. Lead with the answer.
 - Reference code as file_path:line_number.`;

function buildEnvironmentContext(): string {
  let git = "";
  try {
    const opts = { encoding: "utf-8" as const, timeout: 3000, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
    const branch = execSync("git rev-parse --abbrev-ref HEAD", opts).trim();
    git = `\nGit branch: ${branch}`;
  } catch {
    // not a git repo
  }
  return `# Environment
Working directory: ${process.cwd()}
Platform: ${os.platform()} ${os.arch()}
Shell: ${process.env.SHELL || "/bin/sh"}${git}`;
}

export function loadProjectInstructions(): string {
  const names = ["CLAUDE.md", "MINI.md", "AGENTS.md"];
  const parts: string[] = [];
  let dir = process.cwd();
  while (true) {
    for (const name of names) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      try {
        const body = readFileSync(file, "utf-8").trim();
        if (body) parts.push(`# Project instructions (${name} from ${dir})\n${resolveIncludes(body, dir)}`);
      } catch {
        // skip unreadable
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    if (parts.length) break;
  }
  const rules = loadRulesDir(process.cwd());
  if (rules) parts.push(rules);
  return parts.join("\n\n");
}

function resolveIncludes(content: string, basePath: string, visited = new Set<string>(), depth = 0): string {
  if (depth >= 5) return content;
  return content.replace(/^@(\.\/[^\s]+|~\/[^\s]+|\/[^\s]+)$/gm, (_match, raw: string) => {
    const resolved = raw.startsWith("~/")
      ? join(os.homedir(), raw.slice(2))
      : raw.startsWith("/")
        ? raw
        : resolve(basePath, raw);
    if (visited.has(resolved) || !existsSync(resolved)) return `<!-- skip ${raw} -->`;
    visited.add(resolved);
    try {
      return resolveIncludes(readFileSync(resolved, "utf-8"), dirname(resolved), visited, depth + 1);
    } catch {
      return `<!-- error ${raw} -->`;
    }
  });
}

function loadRulesDir(root: string): string {
  const dir = join(root, ".claude", "rules");
  if (!existsSync(dir)) return "";
  const files = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
  if (!files.length) return "";
  const bodies = files.map((file) => {
    try {
      return `<!-- rule: ${file} -->\n${readFileSync(join(dir, file), "utf-8")}`;
    } catch {
      return "";
    }
  }).filter(Boolean);
  return bodies.length ? `## Rules\n${bodies.join("\n\n")}` : "";
}

export function buildStaticSystemPrompt(): string {
  const project = loadProjectInstructions();
  const deferred = getDeferredToolNames();
  const deferredNote = deferred.length
    ? `\n\n# Deferred tools\nThese exist but are not loaded yet. Call tool_search with a name to activate them:\n${deferred.map((name) => `- ${name}`).join("\n")}`
    : "";
  return `${STATIC_CORE}\n\n${buildEnvironmentContext()}${formatSkillCatalog()}${project ? `\n\n${project}` : ""}${deferredNote}`;
}

export function buildSystemPrompt(): string {
  return buildStaticSystemPrompt();
}
