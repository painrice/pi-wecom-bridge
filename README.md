# pi-wecom-bridge

企业微信 Bot 桥接服务，通过 Pi Agent SDK 调用 LongCat 模型自动回复企业微信消息。

## 功能

- 通过 WebSocket 长连接接收企业微信消息
- 使用 Pi Agent SDK + LongCat-2.0 生成回复
- 支持流式回复
- 自动重连机制

## 安装

```bash
npm install
```

## 配置

1. 复制 `.env.example` 为 `.env` 并填写配置
2. 或使用 PM2 的 `ecosystem.config.cjs` 配置环境变量

## 运行

```bash
# 直接运行
node src/index.cjs

# 使用 PM2
pm2 start ecosystem.config.cjs
```

## 依赖

- `@wecom/aibot-node-sdk` - 企业微信 Bot SDK
- `@mariozechner/pi-ai` - Pi AI SDK
- `@mariozechner/pi-coding-agent` - Pi Coding Agent
