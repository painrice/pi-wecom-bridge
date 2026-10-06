const AiBotPkg = require("@wecom/aibot-node-sdk");
const AiBot = AiBotPkg.default || AiBotPkg;
const generateReqId = AiBotPkg.generateReqId || (function() { return "req_" + Date.now() + "_" + Math.random().toString(36).slice(2,10); });

// 强加载 .env（防 PM2 daemon 环境污染：旧 env 里的 WECOM_BOT_ID 会压过 .env 值，
// 导致 pi-wecom 和 grok-wecom 连同一个企微 bot 互踢）
// 同款套路：grok-wecom 的 loadEnv()
const _fsEnv = require("node:fs");
const _pathEnv = require("node:path");
try {
  const _envFile = _fsEnv.readFileSync(_pathEnv.join(__dirname, "..", ".env"), "utf8");
  for (const _l of _envFile.split("\n")) {
    const _m = _l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (_m) process.env[_m[1]] = _m[2];   // 强覆盖，防 PM2 污染
  }
} catch (_e) { /* .env 不存在时用 process.env（pm2 注入） */ }

const botId = process.env.WECOM_BOT_ID;
const secret = process.env.WECOM_BOT_SECRET;
if (!botId || !secret) { console.error("[FATAL] Missing env vars"); process.exit(1); }

// ═══ 企微流式硬约束（官方，参考 grok-wecom-bot 的实现）═══
// 1) 流式更新超过 10 分钟未更新即过期 (errcode 846608)，过期后只能 fallback 到 sendMessage
// 2) markdown 单条上限 20480 字符 (errcode 40058)，分块保守取 18000
var STREAM_EXPIRED = 846608;
var MAX_STREAM_CHUNK = 18000;

var fs2 = require("node:fs");
var path = require("node:path");
var os = require("node:os");

// ═══════════════════════════════════════════════════════════════
// 持久化会话配置
// ═══════════════════════════════════════════════════════════════
// AGENT_DIR: Pi SDK 会话存储目录（本地持久化，重启后恢复）
// 默认用独立目录 /root/.pi/bridge-agent，避免与 pi CLI 共用 ~/.pi/agent 导致配置互相覆盖
var AGENT_DIR = process.env.AGENT_DIR || path.join("/root/.pi", "bridge-agent");

// SESSION_MODE: 会话模式
//   - "persistent" (默认): 持久化到磁盘，支持跨重启记忆
//   - "inmemory": 纯内存模式（旧行为）
var SESSION_MODE = process.env.SESSION_MODE || "persistent";

// CONTINUE_RECENT: 是否继续最近的会话（true=复用历史，false=每次新建）
var CONTINUE_RECENT = process.env.CONTINUE_RECENT !== "false";

console.log("[Config] AGENT_DIR: " + AGENT_DIR);
console.log("[Config] SESSION_MODE: " + SESSION_MODE);
console.log("[Config] CONTINUE_RECENT: " + CONTINUE_RECENT);

function resolveProvider() {
  if (process.env.PI_PROVIDER) return process.env.PI_PROVIDER;
  if (process.env.PI_API_URL && process.env.PI_API_KEY) {
    return process.env.PI_API_URL.includes("openrouter") ? "openrouter" : "longcat";
  }
  return "openrouter";
}

function resolveModelId(provider) {
  if (process.env.PI_MODEL) return process.env.PI_MODEL;
  return provider === "openrouter" ? "openrouter/free" : "LongCat-2.0";
}

function ensureModelsJson() {
  var provider = resolveProvider();
  var modelId = resolveModelId(provider);
  // openrouter 使用 pi 内置模型定义，只需 auth.json 提供 key
  if (provider === "openrouter") {
    var authPath = path.join(AGENT_DIR, "auth.json");
    if (!fs2.existsSync(authPath) || !fs2.readFileSync(authPath, "utf8").trim()) {
      var key = process.env.PI_API_KEY || process.env.OPENROUTER_API_KEY;
      if (key) {
        fs2.writeFileSync(authPath, JSON.stringify({ openrouter: { type: "api_key", key: key } }, null, 2));
        console.log("[PiBridge] auth.json -> openrouter");
      }
    }
    return;
  }
  var apiUrl = process.env.PI_API_URL;
  var apiKey = process.env.PI_API_KEY;
  if (!apiUrl || !apiKey) return;
  var mp = path.join(AGENT_DIR, "models.json");
  // 仅当文件不存在时写入，避免覆盖 pi CLI 的 models.json
  if (fs2.existsSync(mp)) {
    console.log("[PiBridge] models.json already exists, skip write");
    return;
  }
  var cfg = { providers: { longcat: { baseUrl: apiUrl, api: "openai-completions", apiKey: process.env.PI_API_KEY, models: [{ id: modelId, name: modelId, input: ["text"], contextWindow: 131072, maxTokens: 16384, compat: { supportsDeveloperRole: false, supportsReasoningEffort: false } }] } } };
  fs2.writeFileSync(mp, JSON.stringify(cfg, null, 2));
  console.log("[PiBridge] models.json -> longcat/" + modelId);
}

class PiBridge {
  constructor(pi) { this.sessions = new Map(); this._ready = false; this.pi = pi; }
  _ensureReady() { if (this._ready) return; if (!fs2.existsSync(AGENT_DIR)) fs2.mkdirSync(AGENT_DIR, { recursive: true }); ensureModelsJson(); this._ready = true; }
  async getOrCreateSession(userId, onDelta, onComplete, onError) {
    this._ensureReady();
    var entry = this.sessions.get(userId);
    if (entry) {
      // 更新 entry 上的回调引用（subscribe 闭包会读取 entry.onComplete）
      entry.onDelta = onDelta;
      entry.onComplete = onComplete;
      entry.onError = onError;
      return entry.session;
    }
    var pi = this.pi;
    var auth = pi.AuthStorage.create(path.join(AGENT_DIR, "auth.json"));
    var reg = pi.ModelRegistry.create(auth, path.join(AGENT_DIR, "models.json"));
    var provider = resolveProvider();
    var modelId = resolveModelId(provider);
    var model = reg.find(provider, modelId);
    if (!model) model = pi.getModel(provider, modelId);
    if (!model && provider !== "longcat") model = pi.getModel("deepseek", "deepseek-chat");
    if (!model) { var av = await reg.getAvailable(); if (av.length) model = av[0]; else throw new Error("No model"); }
    
    // ═══════════════════════════════════════════════════════════
    // 关键改动：支持持久化 SessionManager
    // ═══════════════════════════════════════════════════════════
    var sm;
    var sessionDir = path.join(AGENT_DIR, "sessions");
    
    if (SESSION_MODE === "inmemory") {
      // 纯内存模式（旧行为，重启丢失）
      sm = pi.SessionManager.inMemory(AGENT_DIR);
      console.log("[PiBridge] " + userId + " -> in-memory session");
    } else if (CONTINUE_RECENT) {
      // 持久化 + 继续最近会话（推荐：重启后恢复记忆）
      sm = pi.SessionManager.continueRecent(AGENT_DIR, sessionDir);
      console.log("[PiBridge] " + userId + " -> continue recent session");
    } else {
      // 持久化 + 新建会话
      sm = pi.SessionManager.create(AGENT_DIR, sessionDir);
      console.log("[PiBridge] " + userId + " -> new persistent session");
    }
    
    var res = await pi.createAgentSession({ agentDir: AGENT_DIR, authStorage: auth, modelRegistry: reg, model: model, thinkingLevel: "off", sessionManager: sm, tools: ["read", "bash", "grep"] });
    var session = res.session;
    // 注意：subscribe 闭包通过 entry 对象间接引用回调，这样复用 session 时能调用最新的回调
    var entry2 = { session, unsubscribe: null, streaming: false, onDelta, onComplete, onError, stepCount: 0, currentTool: null };
    var unsub = session.subscribe(function(ev) {
      // 1. 文本增量
      if (ev.type === "message_update" && ev.assistantMessageEvent && ev.assistantMessageEvent.type === "text_delta") {
        entry2.onDelta(ev.assistantMessageEvent.delta);
      }
      // 2. agent_message 事件：包含 tool_use / thinking
      if (ev.type === "agent_message" && ev.message) {
        var msg = ev.message;
        // tool_use 类型（工具调用开始）
        if (msg.type === "tool_use" || (msg.toolCalls && msg.toolCalls.length)) {
          var tc = msg.toolCalls ? msg.toolCalls[0] : msg;
          var name = tc.name || tc.tool || "tool";
          entry2.stepCount++;
          entry2.currentTool = name;
          var stepMsg = "🔧 正在执行 " + name + "…";
          entry2.onDelta(stepMsg + "\n");
        }
        // thinking 类型（推理过程）
        if (msg.type === "thinking" && msg.content) {
          entry2.onDelta("💭 " + msg.content + "\n");
        }
      }
      // 3. 兼容旧事件名 tool_call / thinking
      if (ev.type === "tool_call" && ev.tool) {
        entry2.stepCount++;
        entry2.currentTool = ev.tool;
        entry2.onDelta("🔧 正在执行 " + ev.tool + "…\n");
      }
      if (ev.type === "thinking" && ev.content) {
        entry2.onDelta("💭 " + ev.content + "\n");
      }
      // 4. 任务结束
      if (ev.type === "agent_end") {
        // 防重复：确保 onComplete 只执行一次
        if (!entry2.completed) {
          entry2.completed = true;
          entry2.onComplete();
        }
      }
    });
    entry2.unsubscribe = unsub;
    this.sessions.set(userId, entry2);
    console.log("[PiBridge] " + userId + " -> " + model.provider + "/" + model.id);
    return session;
  }
  async sendMessage(userId, msg, onDelta, onComplete, onError, ws, fr, streamId, streamState) {
    try {
      var s = await this.getOrCreateSession(userId, onDelta, onComplete, onError);
      var e = this.sessions.get(userId);
      if (e) { e.streaming = true; e.completed = false; e.stepCount = 0; }
      // 启动心跳：每 30 秒发送一次进度，防止长任务完全静默
      // 死流保护：心跳检查返回的 errcode，流过期(846608)即停心跳、只发一次 sendMessage 通知，
      // 避免僵尸流循环（30s 一直给已作废的流发心跳）
      var heartbeatTimer = null;
      var hbAnnounced = false;
      if (ws && fr && streamId) {
        heartbeatTimer = setInterval(function() {
          var entry = this.sessions.get(userId);
          if (!entry || entry.completed) {
            clearInterval(heartbeatTimer);
            return;
          }
          var steps = entry.stepCount || 0;
          var tool = entry.currentTool ? " (" + entry.currentTool + ")" : "";
          if (streamState && streamState.dead) {
            // 流已过期：停心跳，一次性告知用户（避免 30s 死循环心跳）
            clearInterval(heartbeatTimer);
            if (!hbAnnounced) {
              hbAnnounced = true;
              ws.sendMessage(userId, { msgtype: "text", text: { content: "⏳ 仍在处理（已执行 " + steps + " 步" + tool + "），之前的流已过期，完成后会自动通知你" } }).catch(function() {});
            }
            return;
          }
          var hbMsg = "⏳ 仍在处理…（已执行 " + steps + " 步" + tool + ")";
          ws.replyStreamNonBlocking(fr, streamId, hbMsg, false).then(function(r) {
            if (r && r.errcode === STREAM_EXPIRED && streamState) streamState.dead = true;
          }).catch(function() {});
        }.bind(this), 30000);
        // 将 timer 存入 entry，以便 onComplete 时清理
        e.heartbeatTimer = heartbeatTimer;
      }
      await s.prompt(msg);
    }
    catch (err) { console.error("[PiBridge] " + err.message); onError(err); }
    finally { var e2 = this.sessions.get(userId); if (e2) { e2.streaming = false; if (e2.heartbeatTimer) clearInterval(e2.heartbeatTimer); } }
  }
}

// ── Module-level bridge instance (accessible by connectWS) ──
var bridge = null;

// ── WebSocket client wrapper with auto-reconnect ──
var ws = null;
var reconnecting = false;

function connectWS() {
  ws = new AiBot.WSClient({ botId, secret, maxReconnectAttempts: -1, heartbeatInterval: 30000, requestTimeout: 60000 });

  ws.on("authenticated", function() { console.log("[Bridge] Auth OK"); });
  ws.on("disconnected", function(r) {
    console.warn("[Bridge] Disc: " + r);
    if (!reconnecting) {
      reconnecting = true;
      setTimeout(function() { reconnecting = false; connectWS(); }, 2000);
    }
  });
  ws.on("reconnecting", function(a, d) { console.log("[Bridge] Reconn #" + a + " " + d + "ms"); });

  ws.on("message.text", async function(fr) {
    if (!bridge) { console.error("[Bridge] bridge not initialized yet"); return; }
    var c = fr.body && fr.body.text ? fr.body.text.content : null;
    var u = fr.body && fr.body.from ? fr.body.from.userid : null;
    var ct = fr.body ? (fr.body.chatType || fr.body.chattype) : null;
    if (!c || !u) return;
    var m = c;
    if (ct === "group" || ct === "groupchat") m = c.replace(/^@\S+\s*/, "").trim();
    if (!m) return;
    console.log("[Bridge] " + u + ": " + m.substring(0, 80));

    // 生成固定的 streamId，确保 thinking 和最终回复使用同一个 stream
    var rid = fr.headers && fr.headers.reqId ? fr.headers.reqId : fr.req_id;
    var streamId = generateReqId("s");

    var fullReply = "";
    var replySent = false;
    var attempts = 0;
    var MAX_ATTEMPTS = 3;
    // 空内容 / 限流类错误自动重试（free 档模型不稳定，整轮吐空白或 429）
    var RETRYABLE = /429|rate.?limit|too many|timeout|ECONN|fetch failed|503/i;
    // ── 死流保护（参考 grok-wecom-bot 的 846608 处理模式）──
    // 状态先声明，thinking 推送的 .then 回调才会引用到（函数内调用时均已初始化）
    var streamState = { dead: false };
    var hardTimer = null;
    function markStreamDead(reason) {
      if (!streamState.dead) { streamState.dead = true; console.log("[Bridge] stream dead (" + reason + "), final reply will fall back to sendMessage"); }
    }
    // 发送 "thinking" 指示
    ws.replyStreamNonBlocking(fr, streamId, "🤔 正在思考…", false)
      .then(function(r) { if (r && r.errcode === STREAM_EXPIRED) markStreamDead("846608 on thinking"); })
      .catch(function() {});
    async function pushStream(sid, text, fin) {
      var r;
      try { r = await ws.replyStreamNonBlocking(fr, sid, text, fin); }
      catch (e) { markStreamDead("ws error: " + e.message); return false; }
      if (r && r.errcode === STREAM_EXPIRED) { markStreamDead("846608 stream expired"); return false; }
      return true;
    }
    async function sendLong(cid, text) {
      try {
        if (text.length <= MAX_STREAM_CHUNK) {
          await ws.sendMessage(cid, { msgtype: "markdown", markdown: { content: text } });
          return;
        }
        // 超 20480 上限时分块发（40058 保护）
        for (var i = 0; i < text.length; i += MAX_STREAM_CHUNK) {
          var tail = (i + MAX_STREAM_CHUNK < text.length) ? "（未完）" : "";
          await ws.sendMessage(cid, { msgtype: "markdown", markdown: { content: text.slice(i, i + MAX_STREAM_CHUNK) + tail } });
        }
      } catch (e) { console.error("[Bridge] sendMessage fallback failed: " + e.message); }
    }
    async function deliverFinal(text, fin) {
      if (!streamState.dead) {
        var ok = await pushStream(streamId, text, fin !== false);
        if (ok) return;
      }
      console.log("[Bridge] final push via stream unavailable, fallback to sendMessage");
      await sendLong(u, text || "");
    }
    function finishDeliver(text, fin) {
      if (replySent) return;
      replySent = true;
      if (hardTimer) clearTimeout(hardTimer);
      deliverFinal(text, fin).catch(function(e) { console.error("[Bridge] deliverFinal: " + e.message); });
    }
    // 任务级硬超时：prompt() 挂死时兜底收尾，防僵尸流循环
    var HARD_TIMEOUT_MS = 25 * 60 * 1000;
    hardTimer = setTimeout(function() {
      if (replySent) return;
      console.log("[Bridge] hard timeout (25min) hit, force-delivering partial result");
      finishDeliver((fullReply ? fullReply + "\n\n" : "") + "（任务 25 分钟未完成，已强制结束，可重新下达指令）", true);
    }, HARD_TIMEOUT_MS);
    async function runSend() {
      attempts++;
      await bridge.sendMessage(u, m,
        function(d) {
          // 每个文本增量立即发出去（fin=false 表示非终止消息）；流死后停推（内容仍累积，走 fallback）
          if (d && !replySent) {
            fullReply += d;
            if (!streamState.dead) {
              ws.replyStreamNonBlocking(fr, streamId, d, false).then(function(r) {
                if (r && r.errcode === STREAM_EXPIRED) markStreamDead("846608 on delta");
              }).catch(function() {});
            }
          }
        },
        function() {
          if (replySent) return;  // 防重复
          if (!fullReply && attempts < MAX_ATTEMPTS) {
            console.log("[Bridge] empty reply from model, retry " + attempts + "/" + MAX_ATTEMPTS);
            fullReply = "";
            runSend();
            return;
          }
          finishDeliver(fullReply || "（模型未返回内容，请稍后再试）", true);
        },
        function(err) {
          if (replySent) return; // 防重复
          if (attempts < MAX_ATTEMPTS && RETRYABLE.test(String(err && err.message))) {
            console.log("[Bridge] send error (" + err.message + "), retry " + attempts + "/" + MAX_ATTEMPTS);
            fullReply = "";
            setTimeout(function() { runSend(); }, 2000 * attempts);
            return;
          }
          finishDeliver("Error: " + err.message, true);
        },
        ws, fr, streamId, streamState  // 传入流式参数 + 死流状态对象，供 heartbeat 感知
      );
      // 如果 sendMessage 正常完成但 onComplete 没被调用（理论上不应发生）
      if (!replySent) {
        finishDeliver(fullReply || "（模型未返回内容，请稍后再试）", true);
      }
    }
    try {
      await runSend();
    } catch (err) {
      console.error("[Bridge] " + err.message);
      if (!replySent) {
        finishDeliver("Error: " + err.message, true);
      }
    }
  });

  ws.on("message.image", async function(fr) {
    var u2 = fr.body && fr.body.from ? fr.body.from.userid : null;
    if (!u2) return;
    try { var r2 = await ws.downloadFile(fr.body.image.url, fr.body.image.aeskey); console.log("[Bridge] IMG " + r2.buffer.length); } catch (e) {}
    ws.replyStreamNonBlocking(fr, generateReqId("i"), "[IMG]", true).catch(function() {});
  });

  ws.on("event.enter_chat", function(fr) { ws.replyWelcome(fr, { msgtype: "text", text: { content: "Hi! Pi here." } }).catch(function() {}); });
  ws.on("event.template_card_event", function(fr) { console.log("[Bridge] Card: " + JSON.stringify(fr.body)); });

  ws.connect();
}

async function main() {
  var piC = await import("@mariozechner/pi-coding-agent");
  var piA = await import("@mariozechner/pi-ai");
  var pi = { createAgentSession: piC.createAgentSession, AuthStorage: piC.AuthStorage, ModelRegistry: piC.ModelRegistry, SessionManager: piC.SessionManager, getModel: piA.getModel };
  bridge = new PiBridge(pi);
  console.log("[Bridge] Pi ready");

  connectWS();

  var sd = function(s) { console.log("[" + s + "] exit"); if (ws) ws.disconnect(); setTimeout(function() { process.exit(0); }, 500); };
  process.on("SIGINT", function() { sd("SIGINT"); });
  process.on("SIGTERM", function() { sd("SIGTERM"); });
  process.on("unhandledRejection", function(r) { console.error("[Bridge] UH: " + r); });

  console.log("===================");
  console.log(" Pi-WeCom Bridge");
  console.log(" BotID: " + botId.substring(0, 10) + "...");
  console.log(" Model: " + resolveProvider() + "/" + resolveModelId(resolveProvider()));
  console.log(" Session: " + SESSION_MODE + " (dir: " + AGENT_DIR + ")");
  console.log("===================");
}
main().catch(function(e) { console.error("[FATAL]", e); process.exit(1); });
