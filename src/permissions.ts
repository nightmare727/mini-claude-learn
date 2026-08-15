import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PermissionMode } from "./types.js";

export const READ_TOOLS = new Set(["read_file", "list_files", "grep_search", "web_fetch", "tool_search"]);
export const EDIT_TOOLS = new Set(["write_file", "edit_file"]);
export const WRITE_TOOLS = new Set(["write_file", "edit_file", "run_shell"]);

const DANGEROUS = [
  /\brm\s+-rf\b/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bsudo\b/,
  /\bmkfs\b/,
  />\s*\/dev\//,
  /\bpkill\b/,
  /\breboot\b/,
];

export type PermissionVerdict = { action: "allow" | "deny" | "confirm"; message?: string };

type ParsedRule = { tool: string; pattern: string | null };

let cachedRules: { allow: ParsedRule[]; deny: ParsedRule[] } | null = null;

export function isDangerous(command: string): boolean {
  return DANGEROUS.some((re) => re.test(command));
}

export function resetPermissionCache(): void {
  cachedRules = null;
}

function parseRule(rule: string): ParsedRule {
  const match = rule.match(/^([a-z_]+)\((.+)\)$/);
  return match ? { tool: match[1], pattern: match[2] } : { tool: rule, pattern: null };
}

function loadJson(path: string): { permissions?: { allow?: string[]; deny?: string[] } } | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as { permissions?: { allow?: string[]; deny?: string[] } };
  } catch {
    return null;
  }
}

function loadRules(): { allow: ParsedRule[]; deny: ParsedRule[] } {
  if (cachedRules) return cachedRules;
  const allow: ParsedRule[] = [];
  const deny: ParsedRule[] = [];
  const files = [
    join(homedir(), ".claude", "settings.json"),
    join(homedir(), ".mini-claude", "settings.json"),
    join(process.cwd(), ".claude", "settings.json"),
    join(process.cwd(), ".mini-claude", "settings.json"),
  ];
  for (const file of files) {
    const settings = loadJson(file);
    for (const rule of settings?.permissions?.allow || []) allow.push(parseRule(rule));
    for (const rule of settings?.permissions?.deny || []) deny.push(parseRule(rule));
  }
  cachedRules = { allow, deny };
  return cachedRules;
}

function matchesRule(rule: ParsedRule, toolName: string, input: Record<string, unknown>): boolean {
  if (rule.tool !== toolName) return false;
  if (!rule.pattern) return true;
  const value =
    toolName === "run_shell" ? String(input.command || "") : String(input.file_path || input.path || "");
  if (rule.pattern.endsWith("*")) return value.startsWith(rule.pattern.slice(0, -1));
  return value === rule.pattern;
}

function ruleHit(toolName: string, input: Record<string, unknown>): "allow" | "deny" | null {
  const rules = loadRules();
  if (rules.deny.some((rule) => matchesRule(rule, toolName, input))) return "deny";
  if (rules.allow.some((rule) => matchesRule(rule, toolName, input))) return "allow";
  return null;
}

export function checkPermission(
  name: string,
  input: Record<string, unknown>,
  mode: PermissionMode = "default",
): PermissionVerdict {
  const ruled = ruleHit(name, input);
  if (ruled === "deny") return { action: "deny", message: `Denied by permission rule for ${name}` };

  if (mode === "plan") {
    if (EDIT_TOOLS.has(name) || name === "run_shell") {
      return { action: "deny", message: `Denied: ${name} was blocked (plan mode).` };
    }
  }

  if (mode === "bypass") return { action: "allow" };
  if (ruled === "allow") return { action: "allow" };
  if (READ_TOOLS.has(name)) return { action: "allow" };
  if (name === "enter_plan_mode" || name === "exit_plan_mode" || name === "todo_write") {
    return { action: "allow" };
  }
  if (mode === "acceptEdits" && EDIT_TOOLS.has(name)) return { action: "allow" };

  let confirmMessage = "";
  if (name === "run_shell" && isDangerous(String(input.command || ""))) {
    confirmMessage = String(input.command);
  }

  if (!confirmMessage) return { action: "allow" };
  if (mode === "dontAsk") {
    return { action: "deny", message: `Denied: ${name} was blocked by the permission system.` };
  }
  return { action: "confirm", message: confirmMessage };
}
