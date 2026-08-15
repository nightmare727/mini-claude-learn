import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnv } from "../dist/env.js";
import { resolveLlm } from "../dist/llm.js";
import { Agent } from "../dist/agent.js";
import { listMemoryEntries, loadMemoryIndex } from "../dist/memory.js";

loadDotEnv();
const sandbox = mkdtempSync(join(tmpdir(), "mini-memory-"));
const prev = process.cwd();
process.chdir(sandbox);

const resolved = resolveLlm();
console.log(`llm: ${resolved.label}`);
console.log(`cwd: ${sandbox}\n`);
const agent = new Agent(resolved.client);

try {
  console.log("—— turn 1: ask it to remember ——");
  await agent.chat("请记住：我们的测试环境部署地址是 https://staging.example.com ，写进 project 记忆。");

  console.log("\n—— disk after save ——");
  console.log(loadMemoryIndex() || "(no index)");
  for (const entry of listMemoryEntries()) {
    console.log(`file=${entry.filename} type=${entry.type}`);
    console.log(entry.content.slice(0, 200));
  }

  console.log("\n—— turn 2: ask where to deploy (same process) ——");
  await agent.chat("测试环境应该部署到哪里？只回答地址。");

  const fresh = new Agent(resolved.client);
  console.log("\n—— turn 3: new Agent, no session history ——");
  await fresh.chat("测试环境部署到哪个 URL？只回答地址。");
  fresh.close();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  agent.close();
  process.chdir(prev);
  if (existsSync(join(sandbox, ".mini-memory"))) {
    console.log("\nMEMORY.md:\n" + readFileSync(join(sandbox, ".mini-memory/MEMORY.md"), "utf-8"));
  }
  rmSync(sandbox, { recursive: true, force: true });
}
