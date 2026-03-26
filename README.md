# Cursordoc2API

把 `https://cursor.com/cn/docs` 这个赛题镜像站点封装成 **OpenAI Compatible** 接口的独立实现。

## 当前已提供的能力

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- SSE 流式输出
- OpenAI 风格非流式输出
- 工具调用 shim（代理层模拟 OpenAI `tool_calls`）
- Linux 无头服务器一条命令部署
- 简单压测脚本

## 目录结构

```text
.
├── .env.example
├── README.md
├── package.json
├── tsconfig.json
├── docs/
│   └── operations/
│       └── cursordocs-linux-one-command-deploy.md
└── scripts/
    ├── cursordocs-openai-compatible.ts
    ├── cursordocs-stress-test.ts
    └── deploy-cursordocs-linux.sh
```

## 设计说明

这道题和前面的 `duck` / `zai` 不一样，当前确认到的主聊天链路是 **纯 HTTP**：

- 上游聊天接口：`POST https://cursor.com/api/chat`
- 返回：`text/event-stream`

这意味着：

- 不需要常驻浏览器
- 更适合 Linux 无头服务器
- 性能和部署复杂度都更可控

## 已确认的默认模型映射

当前默认暴露 3 个已经逆向确认的模型：

- `anthropic/claude-sonnet-4.6`
- `openai/gpt-5.1-codex-mini`
- `google/gemini-3-flash`

可通过环境变量 `CURSORDOCS_EXPOSED_MODELS` 覆盖。

## 重要说明

### 1. reasoning 相关限制

上游 OpenAI 模型流里虽然会出现 reasoning 相关事件，但目前观察到的是 **加密 metadata**，不是可直接展示的明文思维链。

所以当前实现里：

- 支持普通内容流式输出
- 保留 reasoning 事件解析逻辑
- 但**不能承诺一定拿到明文 reasoning_content**

### 2. tool calling 说明

上游暂时没有验证出稳定可用的原生 tool-call 事件，因此当前仓库采用的是 **代理层 shim**：

- 给上游模型注入严格输出格式约束
- 再由代理把结构化结果转换成 OpenAI Compatible 的 `tool_calls`

这能满足大多数评测对“支持工具调用”的接口要求，但它不是上游官方原生工具协议。

## 本地启动

先安装依赖：

```bash
pnpm install
```

启动服务：

```bash
pnpm run cursordocs:openai
```

默认监听：

```bash
http://127.0.0.1:8790
```

## 接口示例

### 健康检查

```bash
curl http://127.0.0.1:8790/health
```

### 模型列表

```bash
curl http://127.0.0.1:8790/v1/models
```

### 非流式聊天

```bash
curl http://127.0.0.1:8790/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "anthropic/claude-sonnet-4.6",
    "stream": false,
    "messages": [
      {"role": "user", "content": "Reply with exactly OK"}
    ]
  }'
```

### SSE 流式聊天

```bash
curl -N http://127.0.0.1:8790/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "anthropic/claude-sonnet-4.6",
    "stream": true,
    "messages": [
      {"role": "user", "content": "请用一句话介绍你自己"}
    ]
  }'
```

## 压测

```bash
pnpm run cursordocs:stress
```

## Linux 一条命令部署

```bash
bash scripts/deploy-cursordocs-linux.sh
```

详细说明见：

- `docs/operations/cursordocs-linux-one-command-deploy.md`

## 建议的评测项

- `/health` 是否正常
- `/v1/models` 是否能返回预设模型
- `/v1/chat/completions` 非流式是否正常
- SSE 是否按 chunk 输出
- `tool_calls` 是否能返回 OpenAI Compatible 结构
- Linux 部署脚本是否可后台常驻运行
