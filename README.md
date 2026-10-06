# pi-wecom-bridge

企业微信 Bot 桥接服务，通过 WebSocket 长连接接收消息，使用 Pi Agent SDK + OpenRouter（默认 `nvidia/nemotron-3-ultra-550b-a55b:free`）生成 AI 回复。模型由 `.env` 的 `PI_PROVIDER` / `PI_MODEL` 驱动，可随时切换。

## 架构

```
企业微信用户 ──消息──→ 企业微信服务器 ──WebSocket──→ pi-wecom-bridge ──Pi SDK──→ OpenRouter/LongCat
                                      ←──流式回复──                        ←──AI回复──
```

## 功能特性

- WebSocket 长连接实时接收企业微信消息
- 通过 Pi Agent SDK 调用 LLM（provider/model 可配置）
- 支持流式回复（含 846608 流过期保护、40058 超长分块）
- **会话隔离**：私聊按 userId、群聊按 chatid 各自独立会话目录，跨人/跨群/私聊互不串上下文
- **并发排队**：同一会话的消息严格按序处理，排队时流上提示
- 自动重连 + 心跳保活 + 25 分钟任务硬超时兜底
- 群聊 @消息处理；图片消息明确提示暂不支持识图
- 用户命令：`/new`（重置会话）、`/status`、`/help`；长会话自动提醒 `/new`

## 用户命令

| 命令 | 说明 |
|------|------|
| `/new` | 清空当前会话记忆，重新开始（有任务处理中时会拒绝） |
| `/status` | 查看当前模型、会话模式、队列状态 |
| `/help` | 显示命令帮助 |

## 会话隔离说明

- 私聊：每个用户独立会话（`sessions/user_<userid>/`）
- 群聊：同群成员共享一个群会话（`sessions/group_<chatid>/`），跨群互不影响
- 旧版（v1.0.x）所有用户共用一个全局最近会话，存在上下文互串，已修复

## 安装

```bash
git clone https://github.com/painrice/pi-wecom-bridge.git
cd pi-wecom-bridge
npm install
```

## 配置

### 环境变量（.env）

| 变量 | 说明 | 示例 |
|------|------|------|
| `WECOM_BOT_ID` | 企业微信 Bot ID | `aibcMQUriVizDpQlh_mz1...` |
| `WECOM_BOT_SECRET` | 企业微信 Bot 密钥 | `bqH8pUXLJwmvW6q1SIjj...` |
| `PI_PROVIDER` | Pi 提供商 | `openrouter` |
| `PI_MODEL` | 模型名称 | `nvidia/nemotron-3-ultra-550b-a55b:free` |
| `PI_API_KEY` | 对应提供商 API Key | `sk-or-v1-...` |
| `AGENT_DIR` | Pi 会话存储目录 | `/root/.pi/bridge-agent` |
| `SESSION_MODE` | `persistent`（默认）/ `inmemory` | `persistent` |
| `CONTINUE_RECENT` | 是否继续最近会话 | `true` |
| `NODE_ENV` | 运行环境 | `production` |

### 配置方式

**方式一：.env 文件（推荐，程序内强加载，不受 PM2 旧环境变量污染）**

```bash
cp .env.example .env
# 编辑 .env 填写实际值
```

**方式二：PM2 ecosystem**

```javascript
module.exports = {
  apps: [{
    name: "pi-wecom",
    script: "src/index.cjs",
    cwd: "/path/to/pi-wecom-bridge",
  }]
};
```

## 部署

```bash
# 启动 / 重启
pm2 start src/index.cjs --name pi-wecom
pm2 restart pi-wecom

# 查看日志
pm2 logs pi-wecom

# 设置开机自启
pm2 save
pm2 startup
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
├── .env.example           # 环境变量模板
├── SHARED-MEMORY-GUIDE.md # 多 Agent 共享 AGENT_DIR 指南
├── package.json           # 依赖配置
└── README.md              # 本文件
```

## License

MIT
