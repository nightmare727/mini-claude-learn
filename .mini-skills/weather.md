---
name: weather
description: Look up live weather for a city. Use ONLY when the user explicitly asks 天气/气温/下雨/weather. Not for 新闻/热点/资讯.
---
本仓库没有天气工具。查天气时必须用 run_shell 访问公网，禁止凭记忆编温度。

步骤：
1. 从用户话里取出城市；没写城市就问一句，或默认杭州。
2. 调用 run_shell，命令类似：
   curl -sS --max-time 12 "https://wttr.in/<City>?lang=zh&format=3"
3. 失败则改短参数再试一次，例如 format=3。
4. 只根据 tool_result 里的文本总结：天气现象、温度、是否带伞。
5. 若 curl 仍失败，明说查不到，不要编造。
