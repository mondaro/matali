// sink สำหรับ dev: พิมพ์ทุกอย่างออกจอ และรับคำสั่งจาก stdin แทน Supabase
// คำสั่งที่พิมพ์ได้:  amount <code> <บาท> | volume <code> <ลิตร> | free <code> | stop <code> | price <code> <ราคา>
"use strict";
const crypto = require("crypto");

module.exports = function consoleSink() {
  const queue = [];
  let seq = 0;
  const ts = () => new Date().toISOString();

  process.stdin.on("data", (d) => {
    for (const line of String(d).split("\n")) {
      const [op, code, val] = line.trim().split(/\s+/);
      if (!op) continue;
      const kind = { amount: "AUTHORIZE_AMOUNT", volume: "AUTHORIZE_VOLUME", free: "AUTHORIZE_FREE",
                     stop: "STOP", price: "SET_PRICE" }[op];
      if (!kind) { console.log("  คำสั่ง: amount|volume|free|stop|price <code> [ค่า]"); continue; }
      const payload = op === "amount" ? { amount: Number(val) }
        : op === "volume" ? { liters: Number(val) }
        : op === "price" ? { price: Number(val) } : {};
      queue.push({
        id: ++seq, kind, nozzle_code: code, payload,
        ticket_ref: crypto.randomUUID(),
        expires_at: new Date(Date.now() + 60000).toISOString(),
      });
      console.log(`  >> เข้าคิว #${seq} ${kind} ${code} ${val ?? ""}`);
    }
  });

  return {
    async claimCommands() { return queue.splice(0, queue.length); },
    async finishCommand(id, status, error) {
      console.log(`${ts()} [cmd] #${id} -> ${status}${error ? " : " + error : ""}`);
    },
    async pushLive(row) {
      console.log(`${ts()} [live] ${row.nozzle_code.padEnd(18)} ${row.state.padEnd(10)} `
        + `${row.liters.toFixed(3).padStart(9)} ล. ${row.amount.toFixed(2).padStart(10)} ฿`
        + (row.ticket_ref ? `  ticket=${row.ticket_ref.slice(0, 8)}` : ""));
    },
    async pushTransaction(tx) {
      console.log(`${ts()} [TX  ] ${JSON.stringify(tx)}`);
    },
    async pushTotalizers(rows) {
      for (const r of rows) {
        console.log(`${ts()} [tot ] ${r.nozzle_code.padEnd(18)} ${r.vol_total.toFixed(2).padStart(12)} ล. `
          + `${(r.amt_total ?? 0).toFixed(2).padStart(12)} ฿`);
      }
    },
    async heartbeat(hb) {
      const off = hb.nozzles.filter((n) => !n.online).map((n) => n.code);
      console.log(`${ts()} [hb  ] ${hb.nozzles.length} หัวจ่าย`
        + (off.length ? ` | ขาดการติดต่อ: ${off.join(", ")}` : " | ออนไลน์ครบ"));
    },
  };
};
