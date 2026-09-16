// ==========================================================================
// sink "udcs" — คุยกับ UDOM Next ผ่าน HTTP API (ไม่ใช่ Supabase RPC ตรง ๆ)
//
// ข้อจำกัดที่กำหนดทุกอย่าง: Pi อยู่หลัง NAT ของปั๊ม ไม่มี public IP
// -> UDCS ยิงเข้าหา Pi ไม่ได้  ->  Pi ต้องเป็นฝ่ายเปิดการเชื่อมต่อออกเสมอ
//
//   ขาขึ้น  POST /api/v1/station/packages   ส่งเป็นชุด ทุก uplink_ms
//   ขาลง    GET  /api/v1/station/commands?wait=25   long-poll กด latency ให้เหลือ ~0
//
// ความปลอดภัย: Bearer device token + ลายเซ็น HMAC-SHA256 กัน replay
// ==========================================================================
"use strict";
const crypto = require("crypto");
const { Outbox } = require("../outbox");

const DURABLE = new Set(["pump.transaction", "pump.totalizer", "pump.alarm", "command.result"]);
const log = (...a) => console.log(new Date().toISOString(), ...a);

module.exports = function udcsSink(cfg) {
  const api = cfg.udcs;
  if (!api?.base_url || !api?.device_token || !api?.device_secret) {
    throw new Error("config ต้องมี udcs.base_url, udcs.device_token, udcs.device_secret");
  }
  // HTTP header รับได้เฉพาะ ASCII — token ที่มีอักขระไทย/ยูนิโคดจะทำให้ fetch ล้มเหลวทุกครั้ง
  // แล้ว gateway จะออฟไลน์เงียบ ๆ ตลอดกาลโดยไม่มีใครรู้สาเหตุ จึงต้องจับตั้งแต่ตอนเริ่ม
  for (const [k, v] of [["device_token", api.device_token], ["station_id", api.station_id]]) {
    if (v !== undefined && !/^[\x20-\x7E]*$/.test(String(v))) {
      throw new Error(`udcs.${k} ต้องเป็นอักขระ ASCII เท่านั้น (ใส่ใน HTTP header ไม่ได้)`);
    }
  }
  const outbox = new Outbox({ file: cfg.outbox_file || "outbox.db", log });
  const liveBuf = new Map();          // nozzle_code -> แถวล่าสุด (ทับของเก่า ไม่สะสม)
  const cmdQueue = [];
  let commandsSeen = new Set();
  let online = false;
  const MAX_BACKOFF = api.max_backoff_ms || 60000;   // ปรับได้ เผื่อหน้างานอยากให้กู้คืนเร็วกว่านี้
  let backoff = 1000;

  const newId = () => crypto.randomUUID();

  function sign(method, pathname, bodyText, timestamp, nonce) {
    const digest = crypto.createHash("sha256").update(bodyText).digest("hex");
    const base = [timestamp, nonce, method, pathname, digest].join("\n");
    return crypto.createHmac("sha256", api.device_secret).update(base).digest("hex");
  }

  async function call(method, pathname, body, { timeoutMs = 20000 } = {}) {
    const bodyText = body === undefined ? "" : JSON.stringify(body);
    const timestamp = new Date().toISOString();
    const nonce = newId();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(api.base_url + pathname, {
        method,
        signal: ctrl.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${api.device_token}`,
          "x-gateway-id": cfg.agent_id,
          "x-station-id": api.station_id,
          "x-timestamp": timestamp,
          "x-nonce": nonce,
          "x-signature": sign(method, pathname, bodyText, timestamp, nonce),
        },
        body: body === undefined ? undefined : bodyText,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* ปล่อยเป็น null */ }
      if (!res.ok) {
        const err = new Error(`${method} ${pathname} -> ${res.status} ${json?.error || text.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      return json;
    } finally { clearTimeout(t); }
  }

  function enqueue(type, data, occurredAt) {
    outbox.put({ event_id: newId(), type, occurred_at: occurredAt || new Date().toISOString(), data });
  }

  // ---------------- ขาขึ้น ----------------
  async function uplink() {
    const durable = outbox.peek(api.batch_size || 200);
    // สถานะสดเป็นของชั่วคราว: ส่งได้ก็ส่ง ส่งไม่ได้ก็ทิ้ง ไม่ลงคิว
    const live = [...liveBuf.values()].map((d) => ({
      event_id: newId(), type: "pump.live", occurred_at: d.updated_at, data: d,
    }));
    liveBuf.clear();
    if (!durable.length && !live.length) return;

    const pkg = {
      package_id: newId(),
      station_id: api.station_id,
      gateway_id: cfg.agent_id,
      sent_at: new Date().toISOString(),
      queue_depth: outbox.depth(),
      events: [...durable.map(({ seq, ...e }) => e), ...live],
    };

    try {
      const res = await call("POST", "/api/v1/station/packages", pkg);
      outbox.ack((res?.accepted || []).filter((id) => durable.some((d) => d.event_id === id)));
      if (res?.rejected?.length) outbox.reject(res.rejected);
      // ปลายทางแนบคำสั่งกลับมาด้วยได้ (เผื่อ long-poll หลุด)
      for (const c of res?.commands || []) pushCommand(c);
      if (!online) log(`เชื่อมต่อ UDCS ได้แล้ว (คิวค้าง ${outbox.depth()})`);
      online = true;
      backoff = 1000;
    } catch (e) {
      outbox.bumpTries(durable.map((d) => d.event_id), e.message);
      if (online) log(`ส่งขึ้น UDCS ไม่ได้ เข้าโหมดออฟไลน์: ${e.message}`);
      online = false;
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
      throw e;
    }
  }

  // ---------------- ขาลง (long-poll) ----------------
  function pushCommand(c) {
    // กันซ้ำด้วย ticket_ref (uuid) ไม่ใช่ c.id เพราะ id เป็นเลขรันนิ่งของฐานข้อมูล
    // ถ้าปลายทางถูกสร้างใหม่/ย้าย instance เลขจะวนกลับ แล้วคำสั่งจริงจะถูกทิ้งเพราะนึกว่าซ้ำ
    const key = c.ticket_ref || `id:${c.id}`;
    if (commandsSeen.has(key)) return;
    commandsSeen.add(key);
    if (commandsSeen.size > 5000) commandsSeen = new Set([...commandsSeen].slice(-2000));
    cmdQueue.push(c);
  }

  async function downlinkLoop() {
    for (;;) {
      try {
        const wait = api.long_poll_seconds ?? 25;
        const res = await call("GET", `/api/v1/station/commands?gateway_id=${encodeURIComponent(cfg.agent_id)}&wait=${wait}`,
          undefined, { timeoutMs: (wait + 10) * 1000 });
        for (const c of res?.commands || []) pushCommand(c);
      } catch (e) {
        if (e.name !== "AbortError") await sleep(Math.min(backoff, 30000));
        else await sleep(200);
      }
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------- วนส่งขาขึ้น ----------------
  (async function uplinkLoop() {
    for (;;) {
      try { await uplink(); await sleep(api.uplink_ms || 1000); }
      catch { await sleep(backoff); }
    }
  })();
  downlinkLoop();

  return {
    async claimCommands() {
      // ทิ้งคำสั่งที่หมดอายุระหว่างทางตั้งแต่ตรงนี้ ไม่ให้ไปถึงตู้จ่าย
      const now = Date.now();
      const take = cmdQueue.splice(0, cmdQueue.length);
      const live = [], dead = [];
      for (const c of take) (c.expires_at && Date.parse(c.expires_at) < now ? dead : live).push(c);
      for (const c of dead) {
        log(`คำสั่ง #${c.id} หมดอายุระหว่างทาง ไม่ส่งเข้าตู้จ่าย`);
        enqueue("command.result", { command_id: c.id, status: "EXPIRED", error: "หมดอายุระหว่างทางถึงตัวแทน" });
      }
      return live;
    },
    async finishCommand(id, status, error) {
      enqueue("command.result", { command_id: id, status, error });
    },
    async pushLive(row) { liveBuf.set(row.nozzle_code, row); },
    async pushTransaction(tx) { enqueue("pump.transaction", tx, tx.ended_at); },
    async pushTotalizers(rows) { for (const r of rows) enqueue("pump.totalizer", r, r.taken_at); },
    async heartbeat(hb) {
      liveBuf.set("__heartbeat__", {
        nozzle_code: "__heartbeat__", updated_at: new Date().toISOString(),
        ...hb, online, queue_depth: outbox.depth(), queue_oldest: outbox.oldestAt(),
      });
      log(`[hb] ${online ? "ออนไลน์" : "ออฟไลน์"} คิวค้าง ${outbox.depth()} เหตุการณ์`);
    },
    _internals: { outbox, isOnline: () => online },
  };
};

module.exports.DURABLE = DURABLE;
