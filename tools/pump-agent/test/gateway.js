#!/usr/bin/env node
// ทดสอบเส้นทางเต็ม: ตู้จ่ายจำลอง -> gateway บน Pi -> API -> UDCS จำลอง
// เน้นกรณีที่เจ็บที่สุดของหน้างานจริง: อินเทอร์เน็ตดับกลางคัน
"use strict";
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const assert = require("assert");
const { PumpAgent } = require("../agent");
const { createServer } = require("../../mock-udcs/server");

// ใช้พอร์ตสุ่ม กันชนกับ process ที่ค้างจากการรันครั้งก่อน
const SIM_PORT = 20000 + Math.floor(Math.random() * 20000);
const API_PORT = SIM_PORT + 1;
const TOKEN = "tok_test_9f3a1c", SECRET = "sec_test_7b2e8d";
const DB = path.join(__dirname, "outbox-test.db");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => ["", "-wal", "-shm"].forEach((s) => fs.rmSync(DB + s, { force: true }));

async function state() {
  const r = await fetch(`http://127.0.0.1:${API_PORT}/api/v1/station/state`);
  return r.json();
}
const inject = (cmd) => fetch(`http://127.0.0.1:${API_PORT}/api/v1/station/commands`,
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cmd) });

let sim = null;
process.on("exit", () => { if (sim) try { sim.kill("SIGKILL"); } catch {} });

(async () => {
  cleanup();
  let { server } = createServer({ token: TOKEN, secret: SECRET, quiet: true });
  await new Promise((r) => server.listen(API_PORT, r));
  sim = spawn("python3", [path.join(__dirname, "../../rs485/sim_zc.py"), "--tcp", String(SIM_PORT)],
    { stdio: ["pipe", "ignore", "inherit"] });
  await sleep(1200);
  if (sim.exitCode !== null) throw new Error("ตู้จ่ายจำลองไม่ขึ้น (พอร์ตชนหรือ python ผิดพลาด)");

  const cfg = {
    agent_id: "pi-test", status_poll_ms: 250, command_poll_ms: 300,
    totalizer_poll_seconds: 3600, heartbeat_seconds: 3600, live_push_ms: 500,
    outbox_file: DB,
    udcs: { base_url: `http://127.0.0.1:${API_PORT}`, station_id: "STN-001",
            device_token: TOKEN, device_secret: SECRET, uplink_ms: 400, long_poll_seconds: 2, max_backoff_ms: 1500 },
    buses: [{ id: "bus1", codec: "sim", transport: { kind: "tcp", host: "127.0.0.1", port: SIM_PORT },
              boards: [{ addr: 1, nozzles: [{ code: "diesel_west_front", nozzle_no: 1 },
                                            { code: "diesel_west_back", nozzle_no: 2 }] }] }],
  };
  const sink = require("../sink/udcs")(cfg);
  const agent = new PumpAgent(cfg, sink);
  await agent.start();
  await sleep(1500);

  // --- 1. เส้นทางปกติ: UDCS สั่งจ่าย -> ถึงตู้จ่ายผ่าน long-poll ---
  await inject({ kind: "AUTHORIZE_AMOUNT", nozzle_code: "diesel_west_front",
                 payload: { amount: 300 }, ticket_ref: "tk-1" });
  await sleep(1200);
  sim.stdin.write("up 1\n");
  await sleep(2500);
  sim.stdin.write("down 1\n");
  await sleep(2000);

  let s = await state();
  assert.strictEqual(s.transactions.length, 1, `ควรได้ 1 รายการ (ได้ ${s.transactions.length})`);
  assert.strictEqual(s.transactions[0].ticket_ref, "tk-1");
  assert.ok(s.by_type["pump.live"] > 0, "ต้องมีสถานะสดส่งขึ้นมาด้วย");
  const r1 = s.command_results.find((r) => r.status === "DONE");
  assert.ok(r1, "ต้องมีผลคำสั่งส่งกลับมา");
  console.log(`✓ ปกติ: คำสั่งลงถึงตู้จ่าย, ได้รายการ ${s.transactions[0].liters} ล. ${s.transactions[0].amount} ฿, `
    + `สถานะสด ${s.by_type["pump.live"]} ครั้ง`);

  // --- 2. ลายเซ็นผิด -> ต้องถูกปฏิเสธ ---
  const bad = await fetch(`http://127.0.0.1:${API_PORT}/api/v1/station/packages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`,
               "x-timestamp": new Date().toISOString(), "x-nonce": "n1", "x-signature": "deadbeef" },
    body: JSON.stringify({ events: [] }),
  });
  assert.strictEqual(bad.status, 401);
  console.log(`✓ ลายเซ็นผิดถูกปฏิเสธ: ${(await bad.json()).error}`);

  // --- 3. อินเทอร์เน็ตดับ "กลางการขาย" (เคสที่เจ็บที่สุดของหน้างานจริง) ---
  // พนักงานกดสั่งจ่ายตอนเน็ตยังดี แล้วเน็ตดับระหว่างน้ำมันกำลังไหล
  sim.stdin.write("clear 1\nup 1\n");
  await sleep(700);
  await inject({ kind: "AUTHORIZE_AMOUNT", nozzle_code: "diesel_west_front",
                 payload: { amount: 400 }, ticket_ref: "tk-2" });
  await sleep(1500);                      // คำสั่งลงถึงตู้จ่าย น้ำมันเริ่มไหล
  await new Promise((r) => { server.close(r); server.closeAllConnections(); });
  console.log("\n--- ตัดอินเทอร์เน็ตขณะน้ำมันกำลังไหล ---");
  await sleep(2000);                      // จ่ายต่อไปทั้งที่ออฟไลน์
  sim.stdin.write("down 1\n");
  await sleep(2500);
  const depth = sink._internals.outbox.depth();
  assert.ok(depth > 0, `ตอนออฟไลน์ต้องมีเหตุการณ์ค้างในคิว (ได้ ${depth})`);
  assert.strictEqual(sink._internals.isOnline(), false, "ต้องรู้ตัวว่าออฟไลน์");
  console.log(`✓ ออฟไลน์: ขายจบรายการได้ตามปกติ เหตุการณ์ค้างในคิว ${depth} รายการ`);

  // --- 4. เน็ตกลับมา -> ต้องส่งของค้างขึ้นเองโดยไม่ต้องสั่ง ---
  ({ server } = createServer({ token: TOKEN, secret: SECRET, quiet: true }));
  await new Promise((r) => server.listen(API_PORT, r));
  console.log("--- เน็ตกลับมา ---");
  await sleep(5000);
  s = await state();
  // เซิร์ฟเวอร์ตัวใหม่เริ่มนับจากศูนย์ จึงดูที่ ticket_ref ไม่ใช่จำนวนสะสม
  const late = s.transactions.find((t) => t.ticket_ref === "tk-2");
  assert.ok(late, `รายการที่ขายตอนเน็ตดับต้องตามขึ้นมา (ได้ ${JSON.stringify(s.transactions.map(t=>t.ticket_ref))})`);
  assert.strictEqual(sink._internals.outbox.depth(), 0, "ส่งครบแล้วคิวต้องว่าง");
  console.log(`✓ กู้คืน: รายการที่ขายตอนเน็ตดับตามขึ้นมาครบ (${late.liters} ล. ticket ${late.ticket_ref}) คิวว่างแล้ว`);

  // --- 5. คำสั่งที่หมดอายุระหว่างเน็ตดับ ต้องไม่ถูกยิงเข้าตู้จ่าย ---
  await inject({ kind: "AUTHORIZE_AMOUNT", nozzle_code: "diesel_west_back",
                 payload: { amount: 500 }, expires_at: new Date(Date.now() - 5000).toISOString() });
  await sleep(2500);
  s = await state();
  const expired = s.command_results.find((r) => r.status === "EXPIRED");
  assert.ok(expired, "คำสั่งหมดอายุต้องถูกรายงานกลับว่า EXPIRED");
  console.log(`✓ คำสั่งค้างจนหมดอายุถูกทิ้ง ไม่ปลดล็อกหัวจ่าย: ${expired.error}`);

  agent.stop(); sim.kill(); server.close(); cleanup();
  console.log("\n✅ ผ่านทั้งหมด");
  process.exit(0);
})().catch((e) => { console.error("\n❌ ล้มเหลว:", e.message); cleanup(); process.exit(1); });
