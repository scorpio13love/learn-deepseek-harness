# AI Coding Lab

本地 TypeScript 编码题 + 真实 DeepSeek agent。需要 `node site/serve.mjs` 提供 API。

打开：

```text
http://127.0.0.1:4173/site/#/coding
```

配置 Key 有两种方式：

```sh
DEEPSEEK_API_KEY=sk-... node site/serve.mjs
# 或使用已有的 s01 .env
node --env-file=course/lessons/s01-agent-loop/.env site/serve.mjs
```

也可以直接在页面「配置 Key」里填；Key 只存在当前浏览器 session，并通过 localhost 请求头发送给本地服务，不写入仓库。

题目：

- tool-call / tool-result 配对
- surface append + replace
- compaction 阈值
- parallel / exclusive 批次
- workspace 路径边界
- 日志脱敏

运行测试使用本地 Node 24 的 TypeScript strip-types，不需要浏览器内编译器。
