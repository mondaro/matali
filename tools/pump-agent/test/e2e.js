#!/usr/bin/env node
// ทดสอบครบวงจร: agent <-> ตู้จ่ายจำลอง (tools/rs485/sim_zc.py)
// จำลองสิ่งที่ PWA จะทำ: สั่งจ่าย 200 บาท -> ยกหัวจ่าย -> ดูยอดวิ่ง -> วางหัวจ่าย -> ได้ transaction
"use strict";
const { spawn } = require("child_process");
const path = require("path");
const assert = require("assert");
const { PumpAgent } = require("../agent");

const PORT = 5077;
const SIM = path.join(__dirname, "../../rs485/sim_zc.py");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const sim = spawn("python3", [SIM, "--tcp", String(PORT), "--addr", "1"], { stdio: ["pipe", "pipe", "inherit"] });
  sim.stdout.on("data", (d) => process.stdout.write("  [sim] " + d));
  await sleep(1200);

  const live = [];
  const txs = [];
  const tots = [];
  const cmdQueue = [];
  const finished = [];
  const sink = {
    async claimCommands() { return cmdQueue.splice(0, cmdQueue.length); },
    async finishCommand(id, status, error) { finished.push({ id, status, error }); },
    async pushLive(r) { live.push(r); },
    async pushTransaction(t) { txs.push(t); },
    async pushTotalizers(r) { tots.push(...r); },
    async heartbeat() {},
  };

  const agent = new PumpAgent({
    agent_id: "test", status_poll_ms: 200, command_poll_ms: 200,
    totalizer_poll_seconds: 3600, heartbeat_seconds: 3600, live_push_ms: 400,
    buses: [{
      id: "bus1", codec: "sim",
      transport: { kind: "tcp", host: "127.0.0.1", port: PORT },
      boards: [{ addr: 1, nozzles: [
        { code: "diesel_west_front", nozzle_no: 1 },
        { code: "diesel_west_back", nozzle_no: 2 },
      ] }],
    }],
  }, sink);

  await agent.start();
  await sleep(600);
  assert.ok(tots.length >= 2, "ควรอ่าน totalizer ตั้งต้นได้ทั้งสองหัวจ่าย");
  const totBefore = tots.find((t) => t.nozzle_code === "diesel_west_front").vol_total;
  console.log(`\n✓ totalizer ตั้งต้น diesel_west_front = ${totBefore} ล.`);

  // --- PWA สั่งจ่าย 200 บาท ---
  cmdQueue.push({ id: 1, kind: "AUTHORIZE_AMOUNT", nozzle_code: "diesel_west_front",
                  payload: { amount: 200 }, ticket_ref: "ticket-abc-123",
                  expires_at: new Date(Date.now() + 60000).toISOString() });
  await sleep(700);
  assert.deepStrictEqual(finished[0], { id: 1, status: "DONE", error: null }, "คำสั่งสั่งจ่ายต้องสำเร็จ");
  console.log("✓ สั่งจ่าย 200 บาท สำเร็จ");

  // --- พนักงานยกหัวจ่าย น้ำมันไหล ---
  sim.stdin.write("up 1\n");
  await sleep(3000);
  const flowing = live.filter((r) => r.nozzle_code === "diesel_west_front" && r.state === "FILLING");
  assert.ok(flowing.length >= 2, `ควรมีสถานะสดตอนกำลังจ่ายอย่างน้อย 2 ครั้ง (ได้ ${flowing.length})`);
  assert.ok(flowing.at(-1).liters > flowing[0].liters, "ยอดลิตรต้องเดินหน้า");
  assert.strictEqual(flowing.at(-1).ticket_ref, "ticket-abc-123", "ticket_ref ต้องติดมากับสถานะสด");
  console.log(`✓ ยอดวิ่ง: ${flowing[0].liters} -> ${flowing.at(-1).liters} ล. `
    + `(ส่งขึ้น ${flowing.length} ครั้งใน 3 วิ = throttle ทำงาน)`);

  // --- ลูกค้าหยุดเองก่อนครบ 200 บาท: วางหัวจ่าย ---
  sim.stdin.write("down 1\n");
  await sleep(1200);
  assert.strictEqual(txs.length, 1, `ควรได้ transaction 1 รายการ (ได้ ${txs.length})`);
  const tx = txs[0];
  console.log("✓ ได้ transaction:", JSON.stringify(tx));

  assert.strictEqual(tx.nozzle_code, "diesel_west_front");
  assert.strictEqual(tx.ticket_ref, "ticket-abc-123", "transaction ต้องผูกกับ ticket ที่ PWA ส่งมา");
  assert.ok(tx.liters > 0 && tx.liters < 200 / 32.94, "ต้องได้ยอดจริงที่จ่าย ไม่ใช่ยอด preset");
  assert.ok(Math.abs(tx.amount - tx.liters * tx.unit_price) < 0.02, "ยอดเงินต้องตรงกับ ลิตร x ราคา");
  assert.ok(Math.abs(tx.tot_end - tx.tot_start - tx.liters) < 0.05,
    `ส่วนต่าง totalizer ต้องตรงกับลิตรที่จ่าย (start=${tx.tot_start} end=${tx.tot_end} liters=${tx.liters})`);
  assert.ok(!tx.warning, "ไม่ควรมีคำเตือน");
  assert.ok(/^tx_[0-9a-f]{24}$/.test(tx.client_ref), "client_ref ต้องมีรูปแบบถูกต้อง");
  console.log("✓ ยอดเงิน = ลิตร x ราคา, ส่วนต่าง totalizer ตรงกับลิตรที่จ่าย");

  // --- กันสั่งซ้อน: สั่งจ่ายขณะกำลังจ่ายต้องถูกปฏิเสธ ---
  sim.stdin.write("clear 1\nup 2\n");
  await sleep(500);
  cmdQueue.push({ id: 2, kind: "AUTHORIZE_AMOUNT", nozzle_code: "diesel_west_back",
                  payload: { amount: 100 }, expires_at: new Date(Date.now() + 60000).toISOString() });
  await sleep(600);                     // อนุญาตขณะยกหัวจ่ายอยู่ -> เข้าสู่ FILLING ทันที
  cmdQueue.push({ id: 3, kind: "AUTHORIZE_AMOUNT", nozzle_code: "diesel_west_back",
                  payload: { amount: 999 }, expires_at: new Date(Date.now() + 60000).toISOString() });
  await sleep(600);
  const c3 = finished.find((f) => f.id === 3);
  assert.strictEqual(c3.status, "ERROR", "สั่งจ่ายซ้อนขณะกำลังจ่ายต้องถูกปฏิเสธ");
  console.log(`✓ กันสั่งซ้อน: ${c3.error}`);

  // --- คำสั่งหมดอายุต้องไม่ถูกส่งเข้าตู้จ่าย ---
  cmdQueue.push({ id: 4, kind: "AUTHORIZE_AMOUNT", nozzle_code: "diesel_west_front",
                  payload: { amount: 500 }, expires_at: new Date(Date.now() - 1000).toISOString() });
  await sleep(500);
  const c4 = finished.find((f) => f.id === 4);
  assert.strictEqual(c4.status, "ERROR");
  assert.match(c4.error, /หมดอายุ/, "ต้องปฏิเสธเพราะหมดอายุ");
  console.log(`✓ คำสั่งหมดอายุถูกปฏิเสธ: ${c4.error}`);

  // --- ตู้จ่ายหลุด: ต้องไม่ยิงคำสั่งเข้าไปมั่ว ---
  sim.stdin.write("quit\n");
  await sleep(1500);
  cmdQueue.push({ id: 5, kind: "AUTHORIZE_AMOUNT", nozzle_code: "diesel_west_front",
                  payload: { amount: 100 }, expires_at: new Date(Date.now() + 60000).toISOString() });
  await sleep(900);
  const c5 = finished.find((f) => f.id === 5);
  assert.strictEqual(c5.status, "ERROR", "ตู้จ่ายหลุดแล้วต้องปฏิเสธคำสั่ง");
  console.log(`✓ ตู้จ่ายขาดการติดต่อ: ${c5.error}`);

  agent.stop();
  sim.kill();
  console.log("\n✅ ผ่านทั้งหมด");
  process.exit(0);
})().catch((e) => { console.error("\n❌ ล้มเหลว:", e.message); process.exit(1); });
