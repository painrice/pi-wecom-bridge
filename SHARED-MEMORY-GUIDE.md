# 多 Agent 共享记忆配置指南

## 问题

grok-wecom 默认使用 `SessionManager.inMemory()`，导致：
1. 重启后对话历史丢失
2. 多个 Agent (grok-wecom, qwenpaw, hermes) 之间无法共享上下文

## 解决方案

通过 `SHARED_AGENT_DIR` 环境变量让多个 Agent 共享同一个持久化目录。

---

## 快速配置

### 1. grok-wecom (当前已配置)

```javascript
// ecosystem.config.cjs
env: {
  SHARED_AGENT_DIR: "/root/.pi/shared-agent",  // 共享目录
  SESSION_MODE: "persistent",                   // 持久化模式
  CONTINUE_RECENT: "true",                      // 继续最近会话
}
```

### 2. qwenpaw

创建或修改 `~/.pi/qwenpaw/config.cjs`（或对应的配置文件）：

```javascript
module.exports = {
  // ... 其他配置 ...
  env: {
    SHARED_AGENT_DIR: "/root/.pi/shared-agent",  // 与 grok-wecom 相同
    SESSION_MODE: "persistent",
    CONTINUE_RECENT: "true",
  }
};
```

### 3. hermes

创建或修改 `~/.pi/hermes/config.cjs`：

```javascript
module.exports = {
  // ... 其他配置 ...
  env: {
    SHARED_AGENT_DIR: "/root/.pi/shared-agent",  // 与 grok-wecom 相同
    SESSION_MODE: "persistent",
    CONTINUE_RECENT: "true",
  }
};
```

---

## 环境变量说明

| 变量 | 说明 | 默认值 | 可选值 |
|------|------|--------|--------|
| `SHARED_AGENT_DIR` | 共享记忆目录 | `~/.pi/agent` | 任意绝对路径 |
| `SESSION_MODE` | 会话模式 | `persistent` | `persistent` / `inmemory` |
| `CONTINUE_RECENT` | 是否继续最近会话 | `true` | `true` / `false` |

---

## 目录结构

```
/root/.pi/shared-agent/
├── auth.json              # 认证信息（共享）
├── models.json            # 模型配置（共享）
├── sessions/              # 会话历史（共享）
│   └── *.jsonl            # 每个用户的对话记录
└── ...
```

---

## 验证配置

### 1. 启动 grok-wecom
```bash
cd /root/pi-wecom-bridge
pm2 start ecosystem.config.cjs
```

### 2. 查看日志确认配置
```bash
pm2 logs pi-wecom
```

应该看到：
```
[Config] AGENT_DIR: /root/.pi/shared-agent
[Config] SESSION_MODE: persistent
[Config] CONTINUE_RECENT: true
```

### 3. 测试记忆
1. 发送一条消息："我的名字是张三"
2. 重启 pm2：`pm2 restart pi-wecom`
3. 再问："我叫什么？"
4. 正确答案：应该回答"张三"

---

## 注意事项

1. **会话隔离**：不同用户（按 userId）有独立的会话历史
2. **并发安全**：多个 Agent 写入同一个目录时使用文件锁，一般不会冲突
3. **磁盘空间**：会话历史会持续增长，建议定期清理或使用 compaction
4. **模型差异**：不同 Agent 可以使用不同的模型（PI_MODEL），但共享上下文

---

## 故障排除

### 问题：重启后仍然失忆
- 检查 `SHARED_AGENT_DIR` 路径是否正确
- 检查磁盘空间 `df -h`
- 查看 sessions 目录是否有 jsonl 文件生成

### 问题：Agent 间记忆不同步
- 确保所有 Agent 的 `SHARED_AGENT_DIR` 完全相同
- 确保 `CONTINUE_RECENT=true`

### 问题：权限错误
```bash
chmod -R 755 /root/.pi/shared-agent
```

