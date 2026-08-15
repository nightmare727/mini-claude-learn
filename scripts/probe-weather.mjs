import { loadDotEnv } from "../dist/env.js";
import { resolveLlm } from "../dist/llm.js";
import { Agent } from "../dist/agent.js";

loadDotEnv();
const model = process.argv[2];
if (!model) {
  console.error("usage: node scripts/probe-weather.mjs <model>");
  process.exit(2);
}
process.env.MINI_MODEL = model;

const resolved = resolveLlm();
console.log(`\n======== ${resolved.label} ========`);
const agent = new Agent(resolved.client);
const started = Date.now();
try {
  await agent.chat("今天杭州天气");
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
}
const ms = Date.now() - started;

const tools = [];
let lastText = "";
for (const message of agent.history()) {
  if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
  for (const block of message.content) {
    if (block.type === "tool_use") tools.push({ name: block.name, input: block.input });
    if (block.type === "text" && block.text.trim()) lastText = block.text.trim();
  }
}

const usedShell = tools.some((t) => t.name === "run_shell");
const usedCurl = tools.some(
  (t) => t.name === "run_shell" && /curl|wttr|weather/i.test(JSON.stringify(t.input)),
);
console.log("---- result ----");
console.log(`model=${model}`);
console.log(`elapsed_ms=${ms}`);
console.log(`tool_calls=${tools.length}`);
console.log(`used_run_shell=${usedShell}`);
console.log(`used_curl_or_wttr=${usedCurl}`);
console.log("tools=", JSON.stringify(tools, null, 2));
console.log("final=", lastText.slice(0, 400));
agent.close();
