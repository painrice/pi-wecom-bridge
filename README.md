# pi-wecom-bridge

企业微信 Bot 桥接服务，通过 WebSocket 长连接接收消息，使用 Pi Agent SDK + LongCat-2.0 生成 AI 回复。

## 架构

```
企业微信用户 ──消息──→ 企业微信服务器 ──WebSocket──→ pi-wecom-bridge ──Pi SDK──→ LongCat-2.0
                                      ←──流式回复──                        ←──AI回复──
```

## 功能特性

- WebSocket 长连接实时接收企业微信消息
- 通过 Pi Agent SDK 调用 LongCat-2.0 模型
- 支持流式回复
- 自动重连：断线后自动重连
- 心跳保活机制
- 群聊 @消息处理

## 安装

```bash
git clone https://github.com/painrice/pi-wecom-bridge.git
cd pi-wecom-bridge
npm install
```

## 配置

### 环境变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `WECOM_BOT_ID` | 企业微信 Bot ID | `aibcMQUriVizDpQlh_mz1...` |
| `WECOM_BOT_SECRET` | 企业微信 Bot 密钥 | `bqH8pUXLJwmvW6q1SIjj...` |
| `PI_API_URL` | Pi/LongCat API 地址 | `https://api.longcat.chat/openai` |
| `PI_API_KEY` | LongCat API Key | `ak_2Kw8jv4Km5Sd3SO...` |
| `PI_MODEL` | 模型名称 | `LongCat-2.0` |
| `NODE_ENV` | 运行环境 | `production` |

### 配置方式

**方式一：PM2 ecosystem（推荐）**

```javascript
module.exports = {
  apps: [{
    name: "pi-wecom",
    script: "src/index.cjs",
    cwd: "/path/to/pi-wecom-bridge",
    env: {
      WECOM_BOT_ID: "your_bot_id",
      WECOM_BOT_SECRET: "your_bot_secret",
      PI_API_URL: "https://api.longcat.chat/openai",
      PI_API_KEY: "your_api_key",
      PI_MODEL: "LongCat-2.0",
    }
  }]
};
```

**方式二：.env 文件**

```bash
cp .env.example .env
# 编辑 .env 填写实际值
```

## 部署

### 直接运行

```bash
node src/index.cjs
```

### 使用 PM2（推荐）

```bash
# 启动
pm2 start ecosystem.config.cjs

# 查看日志
pm2 logs pi-wecom

# 设置开机自启
pm2 save
pm2 startup
```

### 查看运行状态

```bash
pm2 status
pm2 describe pi-wecom
```

## 依赖

| 包名 | 说明 |
|------|------|
| `@wecom/aibot-node-sdk` | 企业微信 Bot WebSocket SDK |
| `@mariozechner/pi-ai` | Pi AI SDK |
| `@mariozechner/pi-coding-agent` | Pi Coding Agent SDK |

## 目录结构

```
pi-wecom-bridge/
├── src/
│   └── index.cjs          # 主程序入口
├── ecosystem.config.cjs   # PM2 配置（需自行创建）
├── .env.example           # 环境变量模板
├── package.json           # 依赖配置
└── README.md              # 本文件
```

## License

MIT
