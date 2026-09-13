const AiBotPkg = require("@wecom/aibot-node-sdk");
const AiBot = AiBotPkg.default || AiBotPkg;
const generateReqId = AiBotPkg.generateReqId || (function() { return "req_" + Date.now() + "_" + Math.random().toString(36).slice(2,10); });

const botId = process.env.WECOM_BOT_ID;
const secret = process.env.WECOM_BOT_SECRET;
if (!botId || !secret) { console.error("[FATAL] Missing env vars"); process.exit(1); }

var fs2 = require("node:fs");
var path = require("node:path");
var os = require("node:os");

// ═══════════════════════════════════════════════════════════════
// 持久化会话配置
// ═══════════════════════════════════════════════════════════════
// AGENT_DIR: Pi SDK 会话存储目录（本地持久化，重启后恢复）
var AGENT_DIR = process.env.AGENT_DIR || path.join(os.homedir(), ".pi", "agent");

// SESSION_MODE: 会话模式
//   - "persistent" (默认): 持久化到磁盘，支持跨重启记忆
//   - "inmemory": 纯内存模式（旧行为）
var SESSION_MODE = process.env.SESSION_MODE || "persistent";

// CONTINUE_RECENT: 是否继续最近的会话（true=复用历史，false=每次新建）
var CONTINUE_RECENT = process.env.CONTINUE_RECENT !== "false";

console.log("[Config] AGENT_DIR: " + AGENT_DIR);
console.log("[Config] SESSION_MODE: " + SESSION_MODE);
console.log("[Config] CONTINUE_RECENT: " + CONTINUE_RECENT);

function ensureModelsJson() {
  var apiUrl = process.env.PI_API_URL;
  var apiKey = process.env.PI_API_KEY;
  var modelId = process.env.PI_MODEL || "LongCat-2.0";
  if (!apiUrl || !apiKey) return;
  var mp = path.join(AGENT_DIR, "models.json");
  var cfg = { providers: { longcat: { baseUrl: apiUrl, api: "openai-completions", apiKey: process.env.PI_API_KEY, models: [{ id: modelId, name: "LongCat-2.0", input: ["text"], contextWindow: 131072, maxTokens: 16384, compat: { supportsDeveloperRole: false, supportsReasoningEffort: false } }] } } };
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
    var model;
    if (process.env.PI_API_URL) model = reg.find("longcat", process.env.PI_MODEL || "LongCat-2.0");
    if (!model) model = pi.getModel("deepseek", "deepseek-chat");
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
    var entry2 = { session, unsubscribe: null, streaming: false, onDelta, onComplete, onError };
    var unsub = session.subscribe(function(ev) {
      if (ev.type === "message_update" && ev.assistantMessageEvent && ev.assistantMessageEvent.type === "text_delta") {
        entry2.onDelta(ev.assistantMessageEvent.delta);
      }
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
  async sendMessage(userId, msg, onDelta, onComplete, onError) {
    try {
      var s = await this.getOrCreateSession(userId, onDelta, onComplete, onError);
      var e = this.sessions.get(userId);
      if (e) { e.streaming = true; e.completed = false; }
      await s.prompt(msg);
    }
    catch (err) { console.error("[PiBridge] " + err.message); onError(err); }
    finally { var e2 = this.sessions.get(userId); if (e2) e2.streaming = false; }
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

    // 发送 "thinking" 指示
    ws.replyStreamNonBlocking(fr, streamId, "🤔 正在思考…", false).catch(function() {});

    try {
      // 收集完整回复，然后一次性发送 fin=true
      var fullReply = "";
      var replySent = false;
      await bridge.sendMessage(u, m,
        function(d) { fullReply += d; },
        function() {
          if (replySent) return;  // 防重复
          replySent = true;
          var text = fullReply || "（空回复）";
          ws.replyStreamNonBlocking(fr, streamId, text, true).catch(function() {});
        },
        function(err) {
          if (replySent) return;  // 防重复
          replySent = true;
          ws.replyStreamNonBlocking(fr, streamId, "Error: " + err.message, true).catch(function() {});
        }
      );
      // 如果 sendMessage 正常完成但 onComplete 没被调用（理论上不应发生）
      if (!replySent) {
        replySent = true;
        ws.replyStreamNonBlocking(fr, streamId, fullReply || "（空回复）", true).catch(function() {});
      }
    } catch (err) {
      console.error("[Bridge] " + err.message);
      if (!replySent) {
        replySent = true;
        ws.replyStreamNonBlocking(fr, streamId, "Error: " + err.message, true).catch(function() {});
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
  console.log(" Model: " + (process.env.PI_MODEL || "default"));
  console.log(" Session: " + SESSION_MODE + " (dir: " + AGENT_DIR + ")");
  console.log("===================");
}
main().catch(function(e) { console.error("[FATAL]", e); process.exit(1); });
