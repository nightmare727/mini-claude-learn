# Mini Claude Learn

对照教程：[claude-code-from-scratch](https://github.com/Windy3f3f3f3f/claude-code-from-scratch) 的 **TypeScript 框架**，自己手写的最小 Claude Code。

这不是 50 万行的官方产品，是框架里那套可跑的 TS 教学实现：Agent Loop + 工具 + prompt + 会话 + 流式 + 权限 + 压缩 + 记忆 + 技能 + Plan + 子 Agent + MCP + 自治 + 项目指令 / web_fetch / todo /loop。

教程原文在 `../claude-code-from-scratch`。

## 框架完成情况

| 章 | 内容 | 状态 |
|---|---|---|
| 1 | Agent Loop | 完成 `src/agent.ts` |
| 2 | 6 核心工具 + `web_fetch` / `todo_write` / `agent` | 完成 `src/tools.ts` |
| 3 | System Prompt + CLAUDE.md / MINI.md / AGENTS.md | 完成 `src/prompt.ts` |
| 4 | CLI / 会话 `--resume` `/clear` `/rewind` `/compact` `/cost` + JSONL 审计 | 完成 `src/session.ts` `src/file-history.ts` |
| 5 | 流式输出 | mock `stream` 分片写 stdout |
| 6 | 权限：default / plan / acceptEdits / bypass / dontAsk / auto + 确认 | 完成 `src/permissions.ts` |
| 7 | 上下文：按字符阈值压缩（默认 48KB）+ `/compact` + cache_control | 完成 `src/context.ts` |
| 8 | 记忆：四类 + MEMORY.md 索引常驻 + 正文按需召回 + `memory` 工具 | 完成 `src/memory.ts` |
| 9 | 技能渐进：目录只注入 name/description，`skill` 工具或 `/name` 再展开正文 | 完成 `src/skills.ts` |
| 10 | Plan Mode 只读 + `enter_plan_mode` / `exit_plan_mode`（延迟加载） | `agent.setMode("plan")` |
| 11 | Sub-Agent：explore / plan / general | 完成 `src/subagent.ts` |
| 12 | MCP stdio JSON-RPC | 完成 `src/mcp.ts` |
| 13 | 架构对照 | 见下表（文档章） |
| 15 | `/goal` + `/loop` + Auto 分类器 | 完成 `src/autonomy.ts` |

第 14 章是教程仓的手工测试清单。本仓库用 `npm run check` 覆盖对应离线场景。

## 故意没做的（教程也标明了）

Hooks、Coordinator/Swarm、LSP、Bash AST、66 个工具、7 层权限、Ink TUI、插件市场。那些不是这套最小框架的地基。

## 怎么跑

本机默认走本地 CLIProxyAPI（`127.0.0.1:8317`）上的 **grok-4.6**。先确认代理在跑：`lsof -nP -iTCP:8317 | grep LISTEN`。

```bash
cd ~/IdeaProjects/mini-claude-learn
cp .env.example .env   # 填 CLIProxyAPI 的 API Key（~/.cli-proxy-api/install-notes.txt）
npm start              # 接 grok-4.6
npm start -- --mock    # 强制本地假模型
npm run check          # 离线场景，不打真实模型
npm run demo           # 第 2 章 write_file（mock）
```
npm start -- --plan "Create a file report.txt with the plan."
npm start -- --goal "done.txt exists" "Create done.txt with ok."
```

MCP 演示：

```bash
MINI_MCP_SERVER="node ./scripts/mcp-demo-server.mjs" npm start -- "Use the add tool to compute 17 + 25."
```

默认走本地 mock，不需要 API key。

## IDEA 里按模块看

1. `src/agent.ts` — 循环，把后面各章接进去
2. `src/tools.ts` — 工具表
3. `src/prompt.ts` / `permissions.ts` / `context.ts` / `memory.ts` / `skills.ts`
4. `src/subagent.ts` / `src/mcp.ts` / `src/autonomy.ts`
5. `src/check-framework.ts` — 每章一条可跑的验收

## 和真实 Claude Code

| 这里 | Claude Code |
|---|---|
| 一层 while，有 tool_use 就继续；只读工具可并行 | QueryEngine + queryLoop，约 7 种继续条件 |
| 核心文件/壳/搜 + web_fetch + todo + skill + agent | 66+ |
| 6 种权限模式 + 规则文件 + 确认；正则拦危险命令 | 7 层权限 + AST |
| 按字符阈值压缩 + 手动 `/compact` | 4 级 token 流水线 |
| 关键词重叠召回 | 语义召回 |
| explore / plan / general 子 Agent | Sub-Agent + Coordinator + Swarm |
| `/goal` `/loop` Auto | Goal + KAIROS 常驻 + YOLO 分类器 |
