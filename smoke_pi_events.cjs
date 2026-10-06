// 冒烟：脱离企微直接驱动 Pi SDK，观察 agent 多轮工具循环的事件序列
// 用途：定位「模型输出了正文但 bridge 收不到后续 text_delta / agent_end」的问题
const path = require("node:path");

var AGENT_DIR = "/root/.pi/bridge-agent";
var provider = process.env.PI_PROVIDER;
var modelId = process.env.PI_MODEL;

async function main() {
  var piC = await import("@mariozechner/pi-coding-agent");
  var piA = await import("@mariozechner/pi-ai");
  var pi = { createAgentSession: piC.createAgentSession, AuthStorage: piC.AuthStorage, ModelRegistry: piC.ModelRegistry, SessionManager: piC.SessionManager, getModel: piA.getModel };

  var auth = pi.AuthStorage.create(path.join(AGENT_DIR, "auth.json"));
  var reg = pi.ModelRegistry.create(auth, path.join(AGENT_DIR, "models.json"));
  var model = reg.find(provider, modelId) || pi.getModel(provider, modelId);
  if (!model) { console.error("model not found:", provider, modelId); process.exit(1); }
  console.log("[Test] model:", model.provider + "/" + model.id);

  var sm = pi.SessionManager.create(AGENT_DIR, path.join(AGENT_DIR, "sessions", "smoke_test"));
  var res = await pi.createAgentSession({ agentDir: AGENT_DIR, authStorage: auth, modelRegistry: reg, model: model, thinkingLevel: "off", sessionManager: sm, tools: ["bash"] });
  var session = res.session;

  var eventCounts = {};
  var textLen = 0;
  var deltas = 0;
  var ended = false;
  var unsub = session.subscribe(function(ev) {
    eventCounts[ev.type] = (eventCounts[ev.type] || 0) + 1;
    if (ev.type === "message_update" && ev.assistantMessageEvent) {
      var ae = ev.assistantMessageEvent;
      eventCounts["ae:" + ae.type] = (eventCounts["ae:" + ae.type] || 0) + 1;
      if (ae.type === "text_delta") { deltas++; textLen += (ae.delta || "").length; }
    }
    if (ev.type === "agent_message" && ev.message) {
      var m = ev.message;
      var kinds = (m.content || []).map(function(p) { return p.type; }).join("+");
      console.log("[EV] agent_message role=" + m.role + " parts=[" + kinds + "]");
    }
    if (ev.type === "agent_end") {
      ended = true;
      console.log("[EV] agent_end FIRED");
    }
    // 打印未知事件类型，帮助发现被遗漏的信号
    if (["message_update","agent_message","agent_end","agent_start","tool_execution_start","tool_execution_end","message_start","message_end"].indexOf(ev.type) < 0) {
      console.log("[EV] OTHER:", ev.type, JSON.stringify(ev).slice(0, 120));
    }
  });

  console.log("[Test] prompting (short tool task)...");
  var t0 = Date.now();
  try {
    await session.prompt("请用 bash 工具执行 `echo hello-pi-smoke` 然后告诉我输出是什么。简短回答。");
    console.log("[Test] prompt() RESOLVED in", ((Date.now() - t0) / 1000).toFixed(1) + "s, agent_end fired:", ended);
  } catch (e) {
    console.log("[Test] prompt() THREW:", e.message, "agent_end fired:", ended);
  }

  console.log("[Test] text_delta count:", deltas, "total text chars:", textLen);
  console.log("[Test] event counts:", JSON.stringify(eventCounts, null, 0));
  try { unsub(); } catch (e) {}
  process.exit(0);
}
main().catch(function(e) { console.error("[FATAL]", e); process.exit(1); });
