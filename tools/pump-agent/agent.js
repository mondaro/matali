#!/usr/bin/env node
// ==========================================================================
// UDOM Next — pump agent (ตัวแทนหัวจ่าย)
// โครงสร้างล้อแบบ tools/print-agent ของ UDCS: รันค้างบน Pi/PC ในปั๊ม
//
//   RS-485 (ตู้จ่าย)  <->  agent  <->  Supabase  <->  PWA (POS บนมือถือ/แท็บเล็ต)
//
// หน้าที่
//   1. poll สถานะหัวจ่ายทุกตัว -> ส่งสถานะสด (throttle แล้ว) ขึ้น Supabase
//   2. ตรวจจับรายการขายที่จบแล้ว -> ส่งขึ้นเป็น transaction (กันซ้ำด้วย client_ref)
//   3. อ่าน totalizer ตามรอบ -> ส่งขึ้นเป็น snapshot (ความจริงสูงสุดของการกระทบยอด)
//   4. รับคำสั่งจาก PWA (authorize / stop / set price) -> ยิงเข้าตู้จ่าย -> รายงานผล
//
// ใช้: node agent.js config.json
// ==========================================================================
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Bus } = require("./bus");

const CODECS = { sim: () => require("./codec/sim"), zc: () => require("./codec/zc") };
const TRANSPORTS = { tcp: () => require("./transport/tcp"), serial: () => require("./transport/serial") };

const ts = () => new Date().toISOString();
const log = (...a) => console.log(ts(), ...a);

// รายการขายถือว่า "จบ" เมื่อสถานะเข้าสู่กลุ่มนี้
const TERMINAL = new Set(["DONE", "IDLE"]);
const ACTIVE = new Set(["AUTHORIZED", "FILLING"]);

// ---------------------------------------------------------------- Nozzle
class NozzleState {
  constructor(cfg) {
    Object.assign(this, cfg);            // code, boardAddr, nozzleNo, busId
    this.state = "UNKNOWN";
    this.liters = 0;
    this.amount = 0;
    this.unitPrice = 0;
    this.pumpSeq = null;
    this.totStart = null;
    this.totLast = null;
    this.ticketRef = null;               // uuid จาก PWA ที่ผูกกับรายการนี้
    this.lastPushedAt = 0;
    this.lastPushedLiters = -1;
    this.online = false;
  }
}

// ---------------------------------------------------------------- Agent
class PumpAgent {
  constructor(cfg, sink) {
    this.cfg = cfg;
    this.sink = sink;
    this.buses = new Map();
    this.nozzles = new Map();            // code -> NozzleState
    this.stopping = false;
    this.livePushMs = cfg.live_push_ms ?? 1000;
    this.liveMinLitres = cfg.live_min_litres ?? 0.01;
  }

  async start() {
    for (const b of this.cfg.buses) {
      const codec = (CODECS[b.codec] || (() => { throw new Error(`ไม่รู้จัก codec "${b.codec}"`); }))();
      const mk = (TRANSPORTS[b.transport.kind] || (() => { throw new Error(`ไม่รู้จัก transport "${b.transport.kind}"`); }))();
      const bus = new Bus({
        id: b.id, codec, transport: mk(b.transport),
        timeoutMs: b.timeout_ms ?? 300, retries: b.retries ?? 2, gapMs: b.gap_ms ?? 20, log,
      });
      await bus.open();
      this.buses.set(b.id, bus);

      for (const board of b.boards) {
        for (const nz of board.nozzles) {
          this.nozzles.set(nz.code, new NozzleState({
            code: nz.code, busId: b.id, boardAddr: board.addr, nozzleNo: nz.nozzle_no,
          }));
        }
      }
    }
    log(`เริ่มทำงาน: ${this.buses.size} บัส, ${this.nozzles.size} หัวจ่าย`);

    this._loop("status", this.cfg.status_poll_ms ?? 500, () => this.pollAll());
    this._loop("totalizer", (this.cfg.totalizer_poll_seconds ?? 300) * 1000, () => this.snapshotAll());
    this._loop("commands", this.cfg.command_poll_ms ?? 1000, () => this.runCommands());
    this._loop("heartbeat", (this.cfg.heartbeat_seconds ?? 30) * 1000, () => this.heartbeat());
    await this.snapshotAll();
  }

  _loop(name, ms, fn) {
    const tick = async () => {
      if (this.stopping) return;
      try { await fn(); } catch (e) { log(`[${name}] ผิดพลาด:`, e.message); }
      if (!this.stopping) setTimeout(tick, ms);
    };
    setTimeout(tick, 10);
  }

  stop() {
    this.stopping = true;
    for (const b of this.buses.values()) b.close();
  }

  // ---- poll สถานะ ----
  async pollAll() {
    const boards = new Map();            // busId|addr -> [nozzles]
    for (const nz of this.nozzles.values()) {
      const key = `${nz.busId}|${nz.boardAddr}`;
      if (!boards.has(key)) boards.set(key, []);
      boards.get(key).push(nz);
    }
    for (const [key, list] of boards) {
      const [busId, addr] = key.split("|");
      const bus = this.buses.get(busId);
      try {
        await (bus.codec.perNozzleStatus
          ? this._pollPerNozzle(bus, Number(addr), list)
          : this._pollBoard(bus, Number(addr), list));
        for (const nz of list) nz.online = true;
      } catch (e) {
        for (const nz of list) {
          if (nz.online) log(`หัวจ่าย ${nz.code}: ขาดการติดต่อ (${e.message})`);
          nz.online = false;
        }
      }
    }
  }

  // บอร์ดรายงานสถานะระดับบอร์ด + บอกว่าหัวไหนกำลังทำงาน (แบบบอร์ดจีนทั่วไป)
  async _pollBoard(bus, addr, list) {
    const st = await bus.request(addr, bus.codec.readStatus(addr));
    const active = list.find((n) => n.nozzleNo === st.nozzleNo);
    for (const nz of list) {
      if (nz !== active) { await this._apply(bus, nz, "IDLE", null); continue; }
      let filling = null;
      if (ACTIVE.has(st.state) || st.state === "DONE") {
        filling = await bus.request(addr, bus.codec.readFilling(addr));
        if (filling.nozzleNo !== nz.nozzleNo) filling = null;
      }
      await this._apply(bus, nz, st.state, filling);
    }
  }

  // codec ที่ถามสถานะรายหัวจ่ายได้ (ตั้ง perNozzleStatus = true)
  async _pollPerNozzle(bus, addr, list) {
    for (const nz of list) {
      const st = await bus.request(addr, bus.codec.readStatus(addr, nz.nozzleNo));
      let filling = null;
      if (ACTIVE.has(st.state) || st.state === "DONE") {
        filling = await bus.request(addr, bus.codec.readFilling(addr, nz.nozzleNo));
      }
      await this._apply(bus, nz, st.state, filling);
    }
  }

  // ---- state machine: ตรวจจับจุดเริ่ม/จุดจบของรายการ ----
  async _apply(bus, nz, state, filling) {
    const prev = nz.state;
    nz.state = state;

    // เริ่มรายการใหม่: จดยอด totalizer ตั้งต้นไว้ก่อน
    if (!ACTIVE.has(prev) && ACTIVE.has(state) && nz.totStart === null) {
      nz.totStart = await this._readTot(bus, nz);
    }
    if (filling) {
      nz.liters = filling.liters;
      nz.amount = filling.amount;
      nz.unitPrice = filling.unitPrice;
      nz.pumpSeq = filling.pumpSeq;
    }

    // จบรายการ
    if (ACTIVE.has(prev) && TERMINAL.has(state) && nz.liters > 0) {
      const totEnd = await this._readTot(bus, nz);
      await this._emitTransaction(nz, totEnd);
      nz.totStart = null;
      nz.liters = nz.amount = 0;
      nz.ticketRef = null;
    }

    await this._pushLive(nz);
  }

  async _readTot(bus, nz) {
    try {
      const t = await bus.request(nz.boardAddr, bus.codec.readTotalizer(nz.boardAddr, nz.nozzleNo));
      nz.totLast = t.volTotal;
      return t;
    } catch (e) { log(`อ่าน totalizer ${nz.code} ไม่ได้: ${e.message}`); return null; }
  }

  async _emitTransaction(nz, totEnd) {
    const endedAt = new Date().toISOString();
    // client_ref กันซ้ำ: ผูกหัวจ่าย + วันที่ + เลขรายการของบอร์ด + totalizer ปลาย
    // (เลข seq ของบอร์ดวนกลับได้ จึงต้องมีวันที่และ totalizer ร่วมด้วย)
    const clientRef = "tx_" + crypto.createHash("sha1").update([
      nz.code, endedAt.slice(0, 10), nz.pumpSeq ?? "-",
      totEnd ? totEnd.volTotal.toFixed(3) : nz.liters.toFixed(3),
    ].join("|")).digest("hex").slice(0, 24);

    const tx = {
      client_ref: clientRef,
      nozzle_code: nz.code,
      pump_seq: nz.pumpSeq,
      ended_at: endedAt,
      liters: Number(nz.liters.toFixed(3)),
      unit_price: Number(nz.unitPrice.toFixed(2)),
      amount: Number(nz.amount.toFixed(2)),
      tot_start: nz.totStart ? nz.totStart.volTotal : null,
      tot_end: totEnd ? totEnd.volTotal : null,
      ticket_ref: nz.ticketRef,
    };

    // ตรวจสอบตัวเอง: ลิตรที่รายงาน ต้องตรงกับส่วนต่าง totalizer
    if (tx.tot_start !== null && tx.tot_end !== null) {
      const drift = Math.abs(tx.tot_end - tx.tot_start - tx.liters);
      if (drift > 0.05) {
        tx.warning = `ลิตรไม่ตรงส่วนต่าง totalizer (ต่าง ${drift.toFixed(3)} ล.)`;
        log(`⚠️  ${nz.code}: ${tx.warning}`);
      }
    }
    log(`รายการจบ ${nz.code}: ${tx.liters} ล. ${tx.amount} ฿ (seq ${tx.pump_seq})`);
    await this.sink.pushTransaction(tx);
  }

  // ---- สถานะสด: throttle ไม่ให้ท่วม Supabase ----
  async _pushLive(nz) {
    const now = Date.now();
    const moved = Math.abs(nz.liters - nz.lastPushedLiters) >= this.liveMinLitres;
    const stale = now - nz.lastPushedAt >= this.livePushMs;
    const idleQuiet = !ACTIVE.has(nz.state) && !moved;
    if (idleQuiet && now - nz.lastPushedAt < 15000) return;   // ว่างอยู่ - ส่งแค่ทุก 15 วิ
    if (!stale && !moved) return;
    nz.lastPushedAt = now;
    nz.lastPushedLiters = nz.liters;
    await this.sink.pushLive({
      nozzle_code: nz.code, state: nz.state, online: nz.online,
      liters: Number(nz.liters.toFixed(3)), amount: Number(nz.amount.toFixed(2)),
      unit_price: Number(nz.unitPrice.toFixed(2)), ticket_ref: nz.ticketRef,
      updated_at: new Date().toISOString(),
    });
  }

  // ---- totalizer ตามรอบ ----
  async snapshotAll() {
    const rows = [];
    for (const nz of this.nozzles.values()) {
      const bus = this.buses.get(nz.busId);
      if (ACTIVE.has(nz.state)) continue;             // อย่าไปแทรกตอนกำลังจ่าย
      const t = await this._readTot(bus, nz);
      if (!t) continue;
      rows.push({
        client_ref: `tot_${nz.code}_${Math.floor(Date.now() / 60000)}`,   // กันซ้ำระดับนาที
        nozzle_code: nz.code, taken_at: new Date().toISOString(),
        vol_total: t.volTotal, amt_total: t.amtTotal,
      });
    }
    if (rows.length) await this.sink.pushTotalizers(rows);
  }

  // ---- คำสั่งจาก PWA ----
  async runCommands() {
    const cmds = await this.sink.claimCommands();
    for (const c of cmds) {
      let status = "DONE", error = null;
      try {
        // กันคำสั่งค้าง: หมดอายุแล้วไม่ยิงเข้าตู้จ่ายเด็ดขาด
        if (c.expires_at && Date.parse(c.expires_at) < Date.now()) {
          throw new Error("คำสั่งหมดอายุก่อนถึงตู้จ่าย");
        }
        const nz = this.nozzles.get(c.nozzle_code);
        if (!nz) throw new Error(`ไม่รู้จักหัวจ่าย ${c.nozzle_code}`);
        if (!nz.online) throw new Error(`หัวจ่าย ${c.nozzle_code} ขาดการติดต่อ`);
        const bus = this.buses.get(nz.busId);
        const a = [nz.boardAddr, nz.nozzleNo];

        switch (c.kind) {
          case "AUTHORIZE_AMOUNT":
            this._guardFree(nz);
            nz.ticketRef = c.ticket_ref || null;
            await bus.request(nz.boardAddr, bus.codec.authorize(...a, "AMOUNT", Number(c.payload.amount)));
            break;
          case "AUTHORIZE_VOLUME":
            this._guardFree(nz);
            nz.ticketRef = c.ticket_ref || null;
            await bus.request(nz.boardAddr, bus.codec.authorize(...a, "VOLUME", Number(c.payload.liters)));
            break;
          case "AUTHORIZE_FREE":
            this._guardFree(nz);
            nz.ticketRef = c.ticket_ref || null;
            await bus.request(nz.boardAddr, bus.codec.authorize(...a, "FREE", 0));
            break;
          case "STOP":
            await bus.request(nz.boardAddr, bus.codec.stop(...a));
            break;
          case "SET_PRICE":
            if (ACTIVE.has(nz.state)) throw new Error("เปลี่ยนราคาขณะกำลังจ่ายไม่ได้");
            await bus.request(nz.boardAddr, bus.codec.setPrice(...a, Number(c.payload.price)));
            break;
          default:
            throw new Error(`คำสั่งไม่รู้จัก: ${c.kind}`);
        }
        log(`คำสั่ง #${c.id} ${c.kind} ${c.nozzle_code} สำเร็จ`);
      } catch (e) {
        status = "ERROR"; error = e.message;
        log(`คำสั่ง #${c.id} ${c.kind} ${c.nozzle_code} ล้มเหลว: ${e.message}`);
      }
      await this.sink.finishCommand(c.id, status, error);
    }
  }

  _guardFree(nz) {
    if (ACTIVE.has(nz.state)) throw new Error(`หัวจ่าย ${nz.code} กำลังจ่ายอยู่`);
  }

  async heartbeat() {
    const stats = {};
    for (const [id, b] of this.buses) stats[id] = b.stats;
    await this.sink.heartbeat({
      agent_id: this.cfg.agent_id,
      nozzles: [...this.nozzles.values()].map((n) => ({ code: n.code, state: n.state, online: n.online })),
      bus_stats: stats,
    });
  }
}

module.exports = { PumpAgent, NozzleState };

// ---------------------------------------------------------------- main
if (require.main === module) {
  const cfgPath = process.argv[2] || path.join(__dirname, "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const sink = cfg.sink === "supabase" ? require("./sink/supabase")(cfg) : require("./sink/console")(cfg);
  const agent = new PumpAgent(cfg, sink);
  const bye = () => { log("กำลังปิด..."); agent.stop(); process.exit(0); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
  agent.start().catch((e) => { console.error(e); process.exit(1); });
}
