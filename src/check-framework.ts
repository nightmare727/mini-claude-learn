import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Agent } from "./agent.js";
import { parseLoopInput } from "./autonomy.js";
import { firstUserTask, maybeCompact, shouldCompact } from "./context.js";
import { executeMemory, getMemory, loadMemoryIndex } from "./memory.js";
import { createMockClient } from "./mock-client.js";
import { checkPermission, resetPermissionCache } from "./permissions.js";
import { loadSession, saveSession } from "./session.js";
import { activateSkill, resolveSkill } from "./skills.js";
import { getSubAgentConfig } from "./subagent.js";
import { getActiveToolDefinitions, resetActivatedTools, resetTodos } from "./tools.js";
import type { Message } from "./types.js";

const failures: string[] = [];
const MCP_SERVER = `node ${resolve(import.meta.dirname, "../scripts/mcp-demo-server.mjs")}`;

function expect(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
    return;
  }
  failures.push(name);
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

async function inSandbox(fn: () => Promise<void>): Promise<void> {
  const prevCwd = process.cwd();
  const prevMcp = process.env.MINI_MCP_SERVER;
  const prevCompact = process.env.MINI_COMPACT_CHARS;
  const dir = mkdtempSync(join(tmpdir(), "mini-claude-fw-"));
  try {
    process.chdir(dir);
    delete process.env.MINI_MCP_SERVER;
    resetActivatedTools();
    resetTodos();
    resetPermissionCache();
    await fn();
  } finally {
    process.chdir(prevCwd);
    if (prevMcp === undefined) delete process.env.MINI_MCP_SERVER;
    else process.env.MINI_MCP_SERVER = prevMcp;
    if (prevCompact === undefined) delete process.env.MINI_COMPACT_CHARS;
    else process.env.MINI_COMPACT_CHARS = prevCompact;
    rmSync(dir, { recursive: true, force: true });
  }
}

function write(path: string, content: string): void {
  if (path.includes("/")) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

console.log("repl chat — no default greeting.txt");
await inSandbox(async () => {
  const mock = createMockClient();
  const agent = new Agent(mock);
  await agent.chat("你是什么模型");
  const dump = JSON.stringify(agent.history());
  expect("identity question has no tool_use", !dump.includes("tool_use"));
  expect("identity names mock", dump.includes("mock"));
  const hi = new Agent(createMockClient());
  await hi.chat("hi");
  expect("hi has no tool_use", !JSON.stringify(hi.history()).includes("tool_use"));
});

console.log("chapter 3 — system prompt");
await inSandbox(async () => {
  write("greeting.txt", "hello from step one.\n");
  const mock = createMockClient();
  await new Agent(mock).chat("Read the file greeting.txt and tell me what it says.");
  expect("static core injected", mock.lastSystem.includes("Do not propose changes to code you haven't read"));
  expect("cwd injected", mock.lastSystem.includes(process.cwd()));
});

console.log("chapter 4 — session");
await inSandbox(async () => {
  const mock = createMockClient({
    tracks: {
      main: {
        turns: [{ text: "Got it — your favorite color is blue." }, { text: "Your favorite color is blue." }],
      },
    },
  });
  const first = new Agent(mock);
  await first.chat("Remember that my favorite color is blue.");
  saveSession(first.snapshot());
  const second = new Agent(mock);
  const saved = loadSession();
  expect("session file written", saved !== null && saved.messages.length >= 2);
  if (saved) second.loadSnapshot(saved);
  await second.chat("What is my favorite color?");
  const firstUser = second.history().find((m) => m.role === "user" && typeof m.content === "string");
  expect("resume keeps earlier user turn", String(firstUser?.content).includes("favorite color is blue"));
});

console.log("rewind");
await inSandbox(async () => {
  write("keep.txt", "old");
  const mock = createMockClient({
    tracks: {
      main: {
        turns: [
          { tools: [{ name: "write_file", input: { file_path: "keep.txt", content: "new" } }] },
          { text: "Wrote keep.txt." },
          { tools: [{ name: "write_file", input: { file_path: "extra.txt", content: "bonus" } }] },
          { text: "Wrote extra.txt." },
          { text: "Done." },
          { text: "Done." },
        ],
      },
      compact: {
        match: "Summarize the conversation",
        turns: [{ text: "Earlier the user asked to overwrite keep.txt." }, { text: "Then extra.txt was created." }],
      },
    },
  });
  const agent = new Agent(mock);
  await agent.chat("overwrite keep.txt");
  await agent.chat("create extra.txt");
  expect("files after two turns", existsSync("keep.txt") && existsSync("extra.txt"));
  expect("keep.txt is new", readFileSync("keep.txt", "utf-8") === "new");
  const result = agent.rewindTo(1);
  expect("rewound prompt", result.prompt === "overwrite keep.txt");
  expect("keep.txt restored", readFileSync("keep.txt", "utf-8") === "old");
  expect("extra.txt deleted", !existsSync("extra.txt"));
  expect("later user turn dropped", !JSON.stringify(agent.history()).includes("create extra.txt"));
  expect("one rewind point left", agent.rewindPoints().length === 0);
});

console.log("chapter 6 — permissions");
await inSandbox(async () => {
  const mock = createMockClient();
  const agent = new Agent(mock);
  await agent.chat("Delete everything in /tmp/demo with rm -rf.");
  expect("rm -rf denied", JSON.stringify(agent.history()).includes("Denied"));
});

console.log("chapter 7 — compact");
expect("short history does not compact", !shouldCompact(Array.from({ length: 8 }, (_, i) => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: i % 2 === 0 ? `msg ${i}` : [{ type: "text", text: `ok ${i}` }],
})) as Message[]));

await inSandbox(async () => {
  process.env.MINI_COMPACT_CHARS = "80";
  write("a.txt", "alpha");
  write("b.txt", "beta");
  write("c.txt", "gamma");
  const mock = createMockClient({
    tracks: {
      main: {
        turns: [
          { tools: [{ name: "read_file", input: { file_path: "a.txt" } }] },
          { tools: [{ name: "read_file", input: { file_path: "b.txt" } }] },
          { tools: [{ name: "read_file", input: { file_path: "c.txt" } }] },
          { text: "All three read: alpha, beta, gamma." },
        ],
      },
      compact: {
        match: "Summarize the conversation",
        turns: [
          { text: "So far the user asked to read a.txt and b.txt; both were read." },
          { text: "Then c.txt was read." },
          { text: "All three files were read." },
        ],
      },
    },
  });
  const agent = new Agent(mock);
  await agent.chat("Read a.txt, then b.txt, then c.txt, then summarize.");
  expect("compact track used", mock.tracksUsed.includes("compact"));
  expect(
    "original task pinned after compact",
    firstUserTask(agent.history()) === "Read a.txt, then b.txt, then c.txt, then summarize.",
  );
});

{
  process.env.MINI_COMPACT_CHARS = "80";
  const longHistory: Message[] = [
    { role: "user", content: "根据项目生成流程图给我" },
    { role: "assistant", content: [{ type: "tool_use", id: "1", name: "read_file", input: { file_path: "src/agent.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "export class Agent { async chat() { while (true) {} } }" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "2", name: "read_file", input: { file_path: "src/cli.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "2", content: "export async function runCli() {}" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "3", name: "read_file", input: { file_path: "src/tools.ts" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "3", content: "export async function executeTool() {}" }] },
  ];
  const mock = createMockClient({
    tracks: {
      compact: {
        match: "Summarize the conversation",
        turns: [{ text: "User asked for a project flowchart. Agent.ts, cli.ts, tools.ts were read." }],
      },
    },
  });
  const compacted = await maybeCompact(longHistory, mock, "grok-4.6");
  expect("compact prompt keeps original task", mock.lastFirstUser.includes("根据项目生成流程图给我"));
  expect("compact prompt keeps tool results", mock.lastFirstUser.includes("export class Agent"));
  expect("compact prompt is not a placeholder", !mock.lastFirstUser.includes("[tool call / result]"));
  expect("compacted history still starts with original task", firstUserTask(compacted) === "根据项目生成流程图给我");
  delete process.env.MINI_COMPACT_CHARS;
}

{
  process.env.MINI_COMPACT_CHARS = "80";
  const polluted: Message[] = [
    { role: "user", content: "本仓库没有天气工具。查天气\n\n北京" },
    { role: "assistant", content: [{ type: "text", text: "查了北京天气" }] },
    { role: "user", content: "今日热点资讯" },
    { role: "assistant", content: [{ type: "tool_use", id: "1", name: "run_shell", input: { command: "curl weibo" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "hot list json" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "2", name: "run_shell", input: { command: "curl zhihu" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "2", content: "zhihu json" }] },
  ];
  const mock = createMockClient({
    tracks: {
      compact: {
        match: "Summarize the conversation",
        turns: [{ text: "User previously asked weather then hot news." }],
      },
    },
  });
  const compacted = await maybeCompact(polluted, mock, "grok-4.6", "今日热点资讯");
  expect("compact pins this turn not old weather", mock.lastFirstUser.includes("今日热点资讯"));
  expect("compact current request is hot news", JSON.stringify(compacted).includes("Current user request: 今日热点资讯"));
  delete process.env.MINI_COMPACT_CHARS;
}

console.log("chapter 8 — memory");
await inSandbox(async () => {
  write(".mini-memory/deploy.md", "The staging deploy target is https://staging.example.com");
  const mock = createMockClient({
    tracks: { main: { turns: [{ text: "Deploy to https://staging.example.com (staging)." }] } },
  });
  await new Agent(mock).chat("Where should I deploy my changes to test them?");
  expect("relevant body recalled", mock.lastSystem.includes("staging.example.com"));
  expect("index lives in system", mock.lastSystem.includes("MEMORY.md"));
  expect("model is told how to save", mock.lastSystem.includes("action=save"));

  const saved = executeMemory({
    action: "save",
    name: "no trailing summary",
    description: "User dislikes recap paragraphs",
    type: "feedback",
    content: "Do not end replies with a summary.",
  });
  expect("save writes typed file", saved.includes("feedback_"));
  expect("get returns body", getMemory("no trailing summary")?.content.includes("Do not end replies") === true);
  expect("index lists new entry", loadMemoryIndex().includes("no trailing summary"));

  const listed = executeMemory({ action: "list" });
  expect("list includes types", listed.includes("[feedback]") && listed.includes("[project]"));
});

console.log("chapter 9 — skills");
await inSandbox(async () => {
  write(
    ".mini-skills/commit.md",
    [
      "---",
      "name: commit",
      "description: Write a commit message from the git diff.",
      "---",
      "Read the git diff and write a concise commit message.",
    ].join("\n"),
  );
  const expanded = resolveSkill("/commit");
  expect("slash loads full body", expanded?.includes("Read the git diff") === true);

  const mock = createMockClient({
    tracks: {
      main: {
        turns: [
          { tools: [{ name: "skill", input: { skill_name: "commit" } }] },
          { text: "feat: add the new thing" },
        ],
      },
    },
  });
  const agent = new Agent(mock);
  await agent.chat("帮我提交代码");
  expect("catalog lists description only", mock.lastSystem.includes("Write a commit message from the git diff."));
  expect("catalog hides playbook body", !mock.lastSystem.includes("Read the git diff"));
  expect("catalog forbids inventing skill names", mock.lastSystem.includes("Never invent names"));
  expect("catalog does not mark hot-news as fake", !mock.lastSystem.includes("Never invent names (hot-news"));
  expect("bundled hot-news still listed in empty-ish cwd", mock.lastSystem.includes("hot-news:"));
  expect("catalog forbids disk skill hunt", mock.lastSystem.includes("Never list_files"));
  expect("skill tool expands body", JSON.stringify(agent.history()).includes("Read the git diff"));
  expect("activateSkill helper", activateSkill("commit").includes("[Skill \"commit\" activated]"));
  expect(
    "unknown skill lists available and stops hunt",
    activateSkill("not-a-real-skill").includes("Available") &&
      activateSkill("not-a-real-skill").includes("do not search the disk"),
  );
  expect("news alias loads hot-news", activateSkill("news").includes('[Skill "hot-news" activated]'));
});

console.log("skills — bundled catalog without cwd .mini-skills");
await inSandbox(async () => {
  const mock = createMockClient({
    tracks: { main: { turns: [{ text: "ok" }] } },
  });
  await new Agent(mock).chat("今日热点资讯");
  expect("empty cwd still catalogs bundled hot-news", mock.lastSystem.includes("hot-news:"));
  expect("empty cwd does not invite disk hunt", mock.lastSystem.includes("The catalog is complete"));
});

console.log("chapter 10 — plan mode");
await inSandbox(async () => {
  const mock = createMockClient({
    tracks: {
      main: {
        turns: [
          {
            text: "I'll write the plan.",
            tools: [{ name: "write_file", input: { file_path: "report.txt", content: "the plan" } }],
          },
          { text: "That was blocked because we're in plan (read-only) mode." },
        ],
      },
    },
  });
  const agent = new Agent(mock);
  agent.setMode("plan");
  await agent.chat("Create a file report.txt with the plan.");
  expect("plan blocks write", JSON.stringify(agent.history()).includes("plan mode"));
  expect("report.txt absent", !existsSync("report.txt"));
});

console.log("chapter 11 — sub-agent");
await inSandbox(async () => {
  write("greeting.txt", "hello from the subagent demo");
  const mock = createMockClient({
    tracks: {
      main: {
        turns: [
          { tools: [{ name: "agent", input: { task: "Read greeting.txt and report its contents." } }] },
          { text: "The sub-agent reports greeting.txt says: hello from the subagent demo." },
        ],
      },
      subagent: {
        match: "explore sub-agent",
        turns: [
          { tools: [{ name: "read_file", input: { file_path: "greeting.txt" } }] },
          { text: "greeting.txt contains: hello from the subagent demo" },
        ],
      },
    },
  });
  const agent = new Agent(mock);
  await agent.chat("Use a sub-agent to find out what greeting.txt says.");
  expect("sub-agent track used", mock.tracksUsed.includes("subagent"));
  expect("sub-agent read file", JSON.stringify(agent.history()).includes("hello from the subagent demo"));
});

console.log("chapter 12 — MCP");
await inSandbox(async () => {
  process.env.MINI_MCP_SERVER = MCP_SERVER;
  const mock = createMockClient({
    tracks: {
      main: {
        turns: [
          { tools: [{ name: "mcp__demo__add", input: { a: 17, b: 25 } }] },
          { text: "17 + 25 = 42." },
        ],
      },
    },
  });
  const agent = new Agent(mock);
  try {
    await agent.chat("Use the add tool to compute 17 + 25.");
    expect("mcp result is 42", JSON.stringify(agent.history()).includes("42"));
  } finally {
    agent.close();
  }
});

console.log("chapter 15 — auto + goal");
await inSandbox(async () => {
  const mock = createMockClient({
    tracks: {
      main: {
        turns: [
          { tools: [{ name: "write_file", input: { file_path: "secret.txt", content: "creds" } }] },
          { text: "That write was blocked by the auto-mode monitor." },
        ],
      },
      classifier: {
        match: "security monitor",
        turns: [{ text: "BLOCK: writing credentials to disk is unsafe unattended" }],
      },
    },
  });
  const agent = new Agent(mock);
  agent.setMode("auto");
  await agent.chat("Create secret.txt with credentials.");
  expect("auto blocks write", JSON.stringify(agent.history()).includes("Blocked by auto-mode monitor"));
  expect("secret.txt absent", !existsSync("secret.txt"));
});

await inSandbox(async () => {
  const mock = createMockClient({
    tracks: {
      main: {
        turns: [
          { text: "Working on it." },
          { tools: [{ name: "write_file", input: { file_path: "done.txt", content: "ok" } }] },
          { text: "Created done.txt." },
        ],
      },
      goal: {
        match: "goal evaluator",
        turns: [{ text: "NOT_MET: done.txt has not been created yet." }, { text: "MET" }],
      },
    },
  });
  const agent = new Agent(mock);
  await agent.pursueGoal("done.txt exists", "Create done.txt with ok.");
  expect("goal track used twice", mock.tracksUsed.includes("goal"));
  expect("done.txt written", existsSync("done.txt") && readFileSync("done.txt", "utf-8") === "ok");
});

console.log("core gaps — project md, loop parse, deferred tools, sub-agent types");
await inSandbox(async () => {
  write("CLAUDE.md", "Always use tabs in this repo.");
  const mock = createMockClient({ tracks: { main: { turns: [{ text: "ok" }] } } });
  await new Agent(mock).chat("hi");
  expect("CLAUDE.md injected", mock.lastSystem.includes("Always use tabs in this repo."));
});

{
  const interval = parseLoopInput("5m ping the health check");
  expect("loop leading interval", !("error" in interval) && interval.mode === "interval" && interval.intervalSeconds === 300);
  const every = parseLoopInput("scan inbox every 2h");
  expect("loop trailing every", !("error" in every) && every.mode === "interval" && every.intervalSeconds === 7200);
  const dynamic = parseLoopInput("keep polishing the README");
  expect("loop dynamic", !("error" in dynamic) && dynamic.mode === "dynamic");
}

{
  expect("plan tools start deferred", getActiveToolDefinitions().every((tool) => tool.name !== "enter_plan_mode"));
  const mock = createMockClient({
    tracks: {
      main: {
        turns: [
          { tools: [{ name: "tool_search", input: { query: "plan" } }] },
          { text: "loaded" },
        ],
      },
    },
  });
  await new Agent(mock).chat("search plan tools");
  expect("tool_search activates enter_plan_mode", getActiveToolDefinitions().some((tool) => tool.name === "enter_plan_mode"));
}

{
  const explore = getSubAgentConfig("explore");
  expect("explore is read-only", explore.tools.every((tool) => ["read_file", "list_files", "grep_search", "web_fetch"].includes(tool.name)));
  const general = getSubAgentConfig("general");
  expect("general has write_file", general.tools.some((tool) => tool.name === "write_file"));
}

{
  const denied = checkPermission("run_shell", { command: "rm -rf /tmp/demo" }, "dontAsk");
  expect("dontAsk denies dangerous shell", denied.action === "deny");
  const confirm = checkPermission("run_shell", { command: "rm -rf /tmp/demo" }, "default");
  expect("default confirms dangerous shell", confirm.action === "confirm");
  const yolo = checkPermission("run_shell", { command: "rm -rf /tmp/demo" }, "bypass");
  expect("bypass allows dangerous shell", yolo.action === "allow");
}

if (failures.length) {
  console.error(`\n${failures.length} framework check(s) failed`);
  process.exit(1);
}
console.log("\nall framework chapters passed");
