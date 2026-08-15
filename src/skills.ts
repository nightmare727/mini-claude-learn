import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./frontmatter.js";

const RESERVED = new Set(["clear", "memory", "skills", "compact", "cost", "rewind"]);

const PACKAGE_SKILLS = resolve(dirname(fileURLToPath(import.meta.url)), "../.mini-skills");

const ALIASES: Record<string, string> = {
  news: "hot-news",
  "hot-news": "hot-news",
  toutiao: "hot-news",
  weibo: "hot-news",
  "weibo-hot": "hot-news",
  热点: "hot-news",
  资讯: "hot-news",
  weather: "weather",
  天气: "weather",
};

export type SkillDefinition = {
  name: string;
  description: string;
  promptTemplate: string;
  userInvocable: boolean;
};

function skillRoots(): string[] {
  const roots = [PACKAGE_SKILLS, join(homedir(), ".mini-skills"), join(process.cwd(), ".mini-skills")];
  const seen = new Set<string>();
  return roots.filter((dir) => {
    const abs = resolve(dir);
    if (seen.has(abs) || !existsSync(abs)) return false;
    seen.add(abs);
    return true;
  });
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/_/g, "-");
}

export function listSkillDefinitions(): SkillDefinition[] {
  const byName = new Map<string, SkillDefinition>();
  for (const dir of skillRoots()) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      const skill = loadSkill(file.slice(0, -3), readFileSync(join(dir, file), "utf-8"));
      if (RESERVED.has(skill.name)) continue;
      byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function listSkills(): string[] {
  return listSkillDefinitions().map((skill) => skill.name);
}

export function getSkill(name: string): SkillDefinition | undefined {
  const skills = listSkillDefinitions();
  const exact = skills.find((skill) => skill.name === name);
  if (exact) return exact;
  const aliased = ALIASES[normalizeName(name)];
  if (aliased) return skills.find((skill) => skill.name === aliased);
  const norm = normalizeName(name);
  return skills.find((skill) => normalizeName(skill.name) === norm);
}

export function formatSkillCatalog(): string {
  const skills = listSkillDefinitions();
  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}`);
  const list = skills.length ? lines.join("\n") : "(none installed — do the task with tools; do not hunt for skill files)";
  return `

# Skills
This list is the only valid skill_name set.
- Call skill ONLY with a name from this list. Never invent names that are not listed.
- If no skill fits, do the task with run_shell / read_file.
- Never list_files, grep, or ls $HOME / other repos looking for skills. The catalog is complete.

${list}`;
}

export function availableSkillNames(): string {
  const names = listSkills();
  return names.length ? names.join(", ") : "(none)";
}

export function activateSkill(name: string, args = ""): string {
  const skill = getSkill(name);
  if (!skill) {
    return (
      `Unknown skill: ${name}. Available: ${availableSkillNames()}. ` +
      "Do not guess another name and do not search the disk — do the task with run_shell / read_file."
    );
  }
  const prompt = applyArgs(skill.promptTemplate, args);
  return `[Skill "${skill.name}" activated]\n\n${prompt}`;
}

export function resolveSkill(input: string): string | null {
  if (!input.startsWith("/")) return null;
  const [name, ...rest] = input.slice(1).split(" ");
  if (RESERVED.has(name)) return null;
  const skill = getSkill(name);
  if (!skill || !skill.userInvocable) return null;
  return applyArgs(skill.promptTemplate, rest.join(" ").trim());
}

function applyArgs(template: string, args: string): string {
  const replaced = template.replace(/\$ARGUMENTS|\$\{ARGUMENTS\}/g, args);
  return args && !/\$ARGUMENTS|\$\{ARGUMENTS\}/.test(template) ? `${replaced}\n\n${args}` : replaced;
}

function loadSkill(fileName: string, raw: string): SkillDefinition {
  const parsed = parseFrontmatter(raw);
  const body = parsed.body.trim();
  return {
    name: parsed.meta.name || fileName,
    description: parsed.meta.description || firstLine(body) || fileName,
    promptTemplate: body || raw.trim(),
    userInvocable: parsed.meta["user-invocable"] !== "false",
  };
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim())?.trim() ?? "";
}
