---
name: flowchart
description: Draw a mermaid flowchart from this repo's source. Use when the user asks 流程图 or architecture diagram.
---
根据当前工作目录里的真实代码画流程图，不要编造别的项目。

步骤：
1. 先读 README.md 和 src/ 下的入口文件。
2. 只根据读到的函数/模块画 mermaid flowchart。
3. 禁止画游戏、关卡、Boss、子弹等与源码无关的图。
4. 图里的节点名必须能在源码里找到（如 runCli、resolveLlm、Agent.chat、maybeCompact、runOneTool）。
5. 若上下文被压缩，仍以用户这句话为准：给「这个仓库」画架构/主循环图。
