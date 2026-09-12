console.log("Test A: import wecom SDK by name from project dir");
try {
  const m = await import("@wecom/aibot-node-sdk");
  console.log("  OK, WSClient:", typeof (m.WSClient || m.default?.WSClient));
} catch (e) {
  console.log("  FAIL:", e.message);
}

console.log("Test B: import Pi SDK");
try {
  const m = await import("@mariozechner/pi-coding-agent");
  console.log("  OK, createAgentSession:", typeof m.createAgentSession);
} catch (e) {
  console.log("  FAIL:", e.message);
}

console.log("Test C: import Pi AI");
try {
  const m = await import("@mariozechner/pi-ai");
  console.log("  OK, getModel:", typeof m.getModel);
} catch (e) {
  console.log("  FAIL:", e.message);
}
