---
name: hot-news
description: Fetch today's trending news via public HTTP APIs. Use when the user asks 热点/热搜/资讯/trending news.
---
没有单独的新闻 API 工具。用 run_shell 拉公开榜单，禁止编标题，禁止在磁盘上找 skill。

步骤：
1. 直接 curl 1～2 个公开接口，例如：
   curl -sS --max-time 12 -A "Mozilla/5.0" "https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc" | head -c 6000
   curl -sS --max-time 12 -A "Mozilla/5.0" "https://top.baidu.com/api/board?platform=wise&tab=realtime" | head -c 6000
2. 不要 list_files / grep $HOME、~/.claude 或其他仓库。
3. 不要再调用 skill 猜 hot-news / weibo-hot 等名字。
4. 只根据 tool_result 整理 8～15 条标题；失败就说查不到。
