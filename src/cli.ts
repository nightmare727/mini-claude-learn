import * as readline from "node:readline";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Agent } from "./agent.js";
import { parseLoopInput } from "./autonomy.js";
import { listMemories } from "./memory.js";
import { loadDotEnv } from "./env.js";
import { resolveLlm } from "./llm.js";
import { appendSessionJsonl, loadSession, saveSession } from "./session.js";
import { listSkillDefinitions, resolveSkill } from "./skills.js";
import { listTodos } from "./tools.js";
import type { AgentMode, LlmClient } from "./types.js";

const CHAPTER1_PROMPT = "Read the file greeting.txt and tell me what it says.";
const CHAPTER2_PROMPT = "Create a file notes.txt containing the text remember-this.";

export async function runCli(argv: string[] = process.argv.slice(2), client?: LlmClient): Promise<void> {
  loadDotEnv();
  const forceMock = argv.includes("--mock");
  argv = argv.filter((a) => a !== "--mock");
  const demoIndex = argv.indexOf("--demo");
  const demo = demoIndex >= 0;
  const chapter = demo ? Number(argv[demoIndex + 1] || "2") : undefined;
  argv = argv.filter((arg, i) => arg !== "--demo" && !(demo && i === demoIndex + 1 && /^\d+$/.test(arg)));

  if (demo && chapter === 1) process.chdir(resolve(import.meta.dirname, "../fixtures"));
  if (demo && chapter === 2) {
    const sandbox = resolve(import.meta.dirname, "../.sandbox");
    rmSync(sandbox, { recursive: true, force: true });
    mkdirSync(sandbox, { recursive: true });
    process.chdir(sandbox);
  }

  const resume = argv.includes("--resume");
  argv = argv.filter((a) => a !== "--resume");
  let mode: AgentMode = "default";
  let maxCost = 0;
  let maxTurns = 0;
  if (argv.includes("--plan")) {
    mode = "plan";
    argv = argv.filter((a) => a !== "--plan");
  }
  if (argv.includes("--auto")) {
    mode = "auto";
    argv = argv.filter((a) => a !== "--auto");
  }
  if (argv.includes("--yolo") || argv.includes("-y")) {
    mode = "bypass";
    argv = argv.filter((a) => a !== "--yolo" && a !== "-y");
  }
  if (argv.includes("--accept-edits")) {
    mode = "acceptEdits";
    argv = argv.filter((a) => a !== "--accept-edits");
  }
  if (argv.includes("--dont-ask")) {
    mode = "dontAsk";
    argv = argv.filter((a) => a !== "--dont-ask");
  }
  const costIdx = argv.indexOf("--max-cost");
  if (costIdx >= 0) {
    maxCost = Number(argv[costIdx + 1]) || 0;
    argv = [...argv.slice(0, costIdx), ...argv.slice(costIdx + 2)];
  }
  const turnsIdx = argv.indexOf("--max-turns");
  if (turnsIdx >= 0) {
    maxTurns = Number(argv[turnsIdx + 1]) || 0;
    argv = [...argv.slice(0, turnsIdx), ...argv.slice(turnsIdx + 2)];
  }

  const goalIdx = argv.indexOf("--goal");
  const goal = goalIdx >= 0 ? argv[goalIdx + 1] : undefined;
  if (goalIdx >= 0) argv = [...argv.slice(0, goalIdx), ...argv.slice(goalIdx + 2)];

  const resolved = resolveLlm(forceMock || demo);
  const llm = client ?? resolved.client;
  const agent = new Agent(llm);
  if (!client) console.log(`llm: ${resolved.label}`);
  agent.setMode(mode);
  agent.maxCostUsd = maxCost;
  agent.maxTurnsBudget = maxTurns;
  if (resume) {
    const saved = loadSession();
    if (saved) {
      agent.loadSnapshot(saved);
      console.log(`(resumed ${saved.messages.length} messages)`);
    }
  }
  if (mode === "plan") console.log("(plan mode: read-only)");
  if (mode === "auto") console.log("(auto mode: a classifier gates each write)");

  if (demo) {
    const text = chapter === 1 ? CHAPTER1_PROMPT : CHAPTER2_PROMPT;
    console.log(`▶ chapter ${chapter} demo (local mock, no API key)`);
    console.log(`  you: ${text}\n`);
    await agent.chat(text);
    if (chapter === 2) {
      const ok = existsSync("notes.txt") && readFileSync("notes.txt", "utf-8").includes("remember-this");
      console.log(ok ? '\n  ✓ verified: notes.txt contains "remember-this"' : "\n  ✗ notes.txt missing or wrong");
      if (!ok) process.exitCode = 1;
    }
    return;
  }

  if (goal) {
    await agent.pursueGoal(goal, argv.join(" ").trim());
    saveSession(agent.snapshot());
    return;
  }

  const oneShot = argv.join(" ").trim();
  if (oneShot) {
    try {
      await agent.chat(resolveSkill(oneShot) ?? oneShot);
      saveSession(agent.snapshot());
      appendSessionJsonl({ type: "turn", text: oneShot });
    } catch (error) {
      console.error(`llm error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  agent.setConfirm(
    (message) =>
      new Promise((resolve) => {
        rl.question(`  allow? ${message} [y/N] `, (answer) => {
          resolve(/^(y|yes)$/i.test(answer.trim()));
        });
      }),
  );
  console.log("mini-claude — type a message, /help, or 'exit'.\n");
  await new Promise<void>((resolvePromise) => {
    const ask = () => {
      rl.question("you: ", async (line) => {
        const input = line.trim();
        if (input === "exit" || input === "quit") {
          rl.close();
          resolvePromise();
          return;
        }
        if (input === "/help") {
          console.log(
            [
              "  /clear /rewind [n] /compact /cost /plan /memory /skills /todos",
              "  /goal <condition>   /loop [5m] <prompt>",
              "  /<skill>            exit",
            ].join("\n"),
          );
          ask();
          return;
        }
        if (input === "/clear") {
          agent.clearHistory();
          saveSession(agent.snapshot());
          console.log("(history cleared)");
          ask();
          return;
        }
        if (input === "/compact") {
          await agent.compactNow();
          saveSession(agent.snapshot());
          console.log("(compacted)");
          ask();
          return;
        }
        if (input === "/cost") {
          console.log(agent.usageSummary());
          ask();
          return;
        }
        if (input === "/plan") {
          agent.setMode(agent.mode === "plan" ? "default" : "plan");
          console.log(agent.mode === "plan" ? "(plan mode: read-only)" : "(plan mode off)");
          ask();
          return;
        }
        if (input === "/todos") {
          const items = listTodos();
          console.log(items.map((item) => `- [${item.status}] ${item.id}: ${item.content}`).join("\n") || "(no todos)");
          ask();
          return;
        }
        if (input === "/loop" || input.startsWith("/loop ")) {
          const spec = parseLoopInput(input.slice("/loop".length).trim());
          if ("error" in spec) {
            console.log(spec.error);
            ask();
            return;
          }
          try {
            await agent.runLoop(spec);
            saveSession(agent.snapshot());
            appendSessionJsonl({ type: "loop", spec });
          } catch (error) {
            console.error(`llm error: ${error instanceof Error ? error.message : String(error)}`);
          }
          ask();
          return;
        }
        if (input.startsWith("/goal ")) {
          const condition = input.slice("/goal".length).trim();
          try {
            await agent.pursueGoal(condition, `Work until this is true: ${condition}`);
            saveSession(agent.snapshot());
          } catch (error) {
            console.error(`llm error: ${error instanceof Error ? error.message : String(error)}`);
          }
          ask();
          return;
        }
        if (input === "/rewind" || input.startsWith("/rewind ")) {
          const arg = input.slice("/rewind".length).trim();
          const points = agent.rewindPoints();
          if (!arg) {
            if (points.length === 0) console.log("(no rewind points)");
            else {
              points.forEach((turn, i) => {
                console.log(`  ${i + 1}. [${turn.id.slice(0, 8)}] ${turn.text.slice(0, 80)}`);
              });
              console.log("  /rewind <n>  back to just before that user turn");
            }
            ask();
            return;
          }
          try {
            const result = agent.rewindTo(arg);
            saveSession(agent.snapshot());
            console.log(
              `(rewound; restored ${result.files.restored.length}, deleted ${result.files.deleted.length})`,
            );
            console.log(`  prompt was: ${result.prompt}`);
          } catch (error) {
            console.log(`rewind failed: ${error instanceof Error ? error.message : error}`);
          }
          ask();
          return;
        }
        if (input === "/memory") {
          console.log(listMemories().join("\n") || "(no memories)");
          ask();
          return;
        }
        if (input === "/skills") {
          const listed = listSkillDefinitions();
          console.log(
            listed.map((s) => `/${s.name} — ${s.description}`).join("\n") || "(no skills)",
          );
          ask();
          return;
        }
        if (input) {
          try {
            await agent.chat(resolveSkill(input) ?? input);
            saveSession(agent.snapshot());
            appendSessionJsonl({ type: "turn", text: input });
          } catch (error) {
            console.error(`llm error: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        ask();
      });
    };
    ask();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
