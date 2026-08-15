import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../dist/agent.js";
import { maybeCompact, shouldCompact } from "../dist/context.js";
import { createMockClient } from "../dist/mock-client.js";
import { loadDotEnv } from "../dist/env.js";
import { resolveLlm } from "../dist/llm.js";

const fail = (name, detail = "") => {
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
};
const ok = (name) => console.log(`OK   ${name}`);

const fakeNews = "x".repeat(2500);
const newsHistory = [
  { role: "user", content: "今日热点资讯" },
  { role: "assistant", content: [{ type: "text", text: "去公网拉今日热点" }, { type: "tool_use", id: "1", name: "run_shell", input: { command: "curl weibo hotSearch" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: fakeNews }] },
  { role: "assistant", content: [{ type: "tool_use", id: "2", name: "run_shell", input: { command: "curl zhihu hot" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "2", content: fakeNews }] },
  { role: "assistant", content: [{ type: "tool_use", id: "3", name: "run_shell", input: { command: "curl baidu news" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "3", content: fakeNews }] },
];

console.log("—— 1) 热点三连 curl 体量（约 7.5KB）默认不应压缩 ——");
const chars = JSON.stringify(newsHistory).length;
console.log(`history chars≈${chars} threshold=${process.env.MINI_COMPACT_CHARS || 48000}`);
!shouldCompact(newsHistory) ? ok("no compact on typical hot-news loop") : fail("no compact on typical hot-news loop");

console.log("\n—— 2) 旧天气会话之后再问热点，压缩须钉住热点 ——");
const polluted = [
  { role: "user", content: "本仓库没有天气工具。查天气\n\n北京" },
  { role: "assistant", content: [{ type: "text", text: "北京小雨" }] },
  ...newsHistory,
];
process.env.MINI_COMPACT_CHARS = "80";
const mock = createMockClient({
  tracks: {
    compact: {
      match: "Summarize the conversation",
      turns: [{ text: "User asked for hot news after an earlier weather turn." }],
    },
  },
});
const compacted = await maybeCompact(polluted, mock, "grok-4.6", "今日热点资讯");
delete process.env.MINI_COMPACT_CHARS;
const blob = JSON.stringify(compacted);
mock.lastFirstUser.includes("今日热点资讯") ? ok("compact prompt keeps 今日热点资讯") : fail("compact prompt keeps 今日热点资讯");
blob.includes("Current user request: 今日热点资讯") ? ok("compacted history pins hot news") : fail("compacted history pins hot news");
!blob.includes("Current user request: 本仓库没有天气工具") ? ok("does not pin old weather playbook") : fail("does not pin old weather playbook");

console.log("\n—— 3) 真模型 grok-4.6：今日热点资讯 ——");
loadDotEnv();
const sandbox = mkdtempSync(join(tmpdir(), "mini-hot-"));
const prev = process.cwd();
process.chdir(sandbox);
writeFileSync(".env", "");
const logs = [];
const origLog = console.log;
console.log = (...args) => {
  logs.push(args.map(String).join(" "));
  origLog(...args);
};
const agent = new Agent(resolveLlm().client);
try {
  await agent.chat("今日热点资讯");
} catch (error) {
  origLog(`live error: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  console.log = origLog;
  agent.close();
  process.chdir(prev);
  rmSync(sandbox, { recursive: true, force: true });
}

const history = JSON.stringify(agent.history());
const joined = logs.join("\n") + "\n" + history;
const compactedLive = logs.some((line) => line.includes("compacted"));
const scannedHome = /list_files[\s\S]{0,200}\/Users\/gaofei|find ~|ls \/Users\/gaofei|ls \$HOME/.test(joined);
const usedWeather = /wttr\.in|查北京天气|查杭州天气|format=3/.test(joined);
const usedNews = /weibo|zhihu|hotSearch|热点|news\.baidu|sina|toutiao|163\.com/i.test(joined);
!compactedLive ? ok("live run did not compact") : fail("live run did not compact", "saw compacted log");
!scannedHome ? ok("live run did not list $HOME") : fail("live run did not list $HOME", "saw home-dir scan");
!usedWeather ? ok("live run did not switch to weather") : fail("live run did not switch to weather");
usedNews ? ok("live run fetched news-like URL or talked 热点") : fail("live run fetched news-like URL or talked 热点");
