#!/usr/bin/env node
// ==========================================================================
// Mock UDCS — จำลองปลายทาง API ของ UDOM Next เพื่อทดสอบ gateway บน Pi
// ใช้ตอนพัฒนา ไม่ต้องมี Supabase จริง ไม่ต้องแตะรีโป UDCS
//
// ทำตาม contract ใน docs/03-gateway-architecture-and-api.md:
//   POST /api/v1/station/packages          รับชุดเหตุการณ์ -> ACK ทีละ event_id
//   GET  /api/v1/station/commands?wait=25  long-poll คำสั่งลงไปหา gateway
//   POST /api/v1/station/commands          (ฝั่งทดสอบ) ป้อนคำสั่งเข้าคิว
//   GET  /api/v1/station/state             (ฝั่งทดสอบ) ดูว่ารับอะไรไปแล้วบ้าง
//
// ตรวจสอบจริง: Bearer token, ลายเซ็น HMAC, เวลาเบี้ยว, nonce ซ้ำ, event ซ้ำ
// ==========================================================================
"use strict";
const http = require("http");
const crypto = require("crypto");

function createServer({ token, secret, skewMs = 5 * 60 * 1000, quiet = false } = {}) {
  const received = [];                  // เหตุการณ์ที่รับแล้ว (dedupe ด้วย event_id)
  const seenEvents = new Set();
  const seenNonces = new Map();         // nonce -> เวลา (กัน replay)
  const commands = [];                  // คิวคำสั่งรอส่งลงไป
  const waiters = [];                   // long-poll ที่ค้างอยู่
  const commandResults = new Map();
  let nextCommandId = 1;
  const say = (...a) => { if (!quiet) console.log(new Date().toISOString(), "[mock-udcs]", ...a); };

  // ⚠️ ต้องเซ็น/ตรวจบน "request target" เต็ม (path + query) ให้ตรงกันทั้งสองฝั่ง
  //    ไม่งั้น GET ที่มี query จะลายเซ็นไม่ตรงเสมอ
  function verify(req, target, bodyText) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${token}`) return "token ไม่ถูกต้อง";
    const tsHdr = req.headers["x-timestamp"], nonce = req.headers["x-nonce"], sig = req.headers["x-signature"];
    if (!tsHdr || !nonce || !sig) return "ขาด header ลายเซ็น";
    const skew = Math.abs(Date.now() - Date.parse(tsHdr));
    if (!(skew < skewMs)) return `เวลาเบี้ยวเกินกำหนด (${Math.round(skew / 1000)} วินาที)`;
    if (seenNonces.has(nonce)) return "nonce ซ้ำ (น่าจะเป็น replay)";
    const digest = crypto.createHash("sha256").update(bodyText).digest("hex");
    const base = [tsHdr, nonce, req.method, target, digest].join("\n");
    const want = crypto.createHmac("sha256", secret).update(base).digest("hex");
    const a = Buffer.from(want), b = Buffer.from(String(sig));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return "ลายเซ็นไม่ถูกต้อง";
    seenNonces.set(nonce, Date.now());
    for (const [n, t] of seenNonces) if (Date.now() - t > skewMs * 2) seenNonces.delete(n);
    return null;
  }

  function flushWaiters() {
    while (waiters.length && commands.length) {
      const w = waiters.shift();
      clearTimeout(w.timer);
      const batch = commands.splice(0, commands.length);
      w.send({ commands: batch });
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };

      // ---- ช่องทางทดสอบ (ไม่ต้องเซ็น) ----
      if (req.method === "POST" && url.pathname === "/api/v1/station/commands") {
        const c = { id: nextCommandId++, ...JSON.parse(body || "{}") };
        c.expires_at ||= new Date(Date.now() + 60000).toISOString();
        c.ticket_ref ||= crypto.randomUUID();      // ตรงกับ pump_commands.ticket_ref ใน schema จริง
        commands.push(c);
        say(`ป้อนคำสั่ง #${c.id} ${c.kind} ${c.nozzle_code}`);
        flushWaiters();
        return send(200, { command: c });
      }
      if (req.method === "GET" && url.pathname === "/api/v1/station/state") {
        return send(200, {
          received_count: received.length,
          by_type: received.reduce((m, e) => ((m[e.type] = (m[e.type] || 0) + 1), m), {}),
          transactions: received.filter((e) => e.type === "pump.transaction").map((e) => e.data),
          command_results: [...commandResults.values()],
        });
      }

      // ---- ช่องทางจริงของ gateway (ต้องเซ็น) ----
      const bad = verify(req, req.url, body);
      if (bad) { say(`ปฏิเสธ ${req.method} ${url.pathname}: ${bad}`); return send(401, { error: bad }); }

      if (req.method === "POST" && url.pathname === "/api/v1/station/packages") {
        const pkg = JSON.parse(body || "{}");
        const accepted = [], rejected = [];
        for (const ev of pkg.events || []) {
          if (!ev.event_id || !ev.type) { rejected.push({ event_id: ev.event_id, reason: "ขาด event_id หรือ type" }); continue; }
          if (seenEvents.has(ev.event_id)) { accepted.push(ev.event_id); continue; }   // ซ้ำ = ACK เฉย ๆ
          seenEvents.add(ev.event_id);
          received.push(ev);
          if (ev.type === "command.result") commandResults.set(ev.data.command_id, ev.data);
          accepted.push(ev.event_id);
        }
        const durable = (pkg.events || []).filter((e) => e.type !== "pump.live").length;
        if (durable) say(`รับชุด ${pkg.package_id?.slice(0, 8)} : ${durable} เหตุการณ์ถาวร (คิวฝั่ง gateway ${pkg.queue_depth})`);
        return send(200, { accepted, rejected, server_time: new Date().toISOString(),
                           commands: commands.splice(0, commands.length) });
      }

      if (req.method === "GET" && url.pathname === "/api/v1/station/commands") {
        const wait = Math.min(Number(url.searchParams.get("wait") || 25), 60);
        if (commands.length) return send(200, { commands: commands.splice(0, commands.length) });
        const w = { send: (o) => send(200, o) };
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          send(200, { commands: [] });
        }, wait * 1000);
        waiters.push(w);
        return;
      }
      send(404, { error: "ไม่พบเส้นทางนี้" });
    });
  });

  return { server, state: { received, commands, commandResults } };
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.env.PORT || 8088);
  const { server } = createServer({
    token: process.env.DEVICE_TOKEN || "dev-token",
    secret: process.env.DEVICE_SECRET || "dev-secret",
  });
  server.listen(port, () => console.log(`mock UDCS ฟังอยู่ที่ http://127.0.0.1:${port}`));
}
