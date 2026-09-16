// ==========================================================================
// Outbox — คิวเหตุการณ์ที่ "ห้ามหาย" เก็บลง SQLite บนเครื่อง Pi
//
// หลักการ: เขียนลงดิสก์ให้สำเร็จก่อน แล้วค่อยพยายามส่งขึ้น UDCS
//          ลบออกก็ต่อเมื่อปลายทาง ACK แล้วเท่านั้น (at-least-once + dedupe ที่ปลายทาง)
//
// แยกสองชนิดชัดเจน:
//   DURABLE (transaction / totalizer / alarm / command result) -> ลงคิว ส่งจนกว่าจะสำเร็จ
//   EPHEMERAL (สถานะสด)                                        -> ห้ามลงคิว ส่งไม่ได้ก็ทิ้ง
//   เพราะสถานะสดของเมื่อ 3 ชั่วโมงที่แล้วไม่มีประโยชน์ มีแต่จะถ่วงคิวจริง
//
// ต้องใช้ Node >= 22.5 (โมดูล node:sqlite ในตัว) หรือติดตั้ง better-sqlite3
// ==========================================================================
"use strict";
const fs = require("fs");
const path = require("path");

function openDb(file) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(file);
    return {
      exec: (s) => db.exec(s),
      run: (sql, ...a) => db.prepare(sql).run(...a),
      all: (sql, ...a) => db.prepare(sql).all(...a),
      get: (sql, ...a) => db.prepare(sql).get(...a),
      close: () => db.close(),
    };
  } catch (e1) {
    try {
      const Better = require("better-sqlite3");
      const db = new Better(file);
      return {
        exec: (s) => db.exec(s),
        run: (sql, ...a) => db.prepare(sql).run(...a),
        all: (sql, ...a) => db.prepare(sql).all(...a),
        get: (sql, ...a) => db.prepare(sql).get(...a),
        close: () => db.close(),
      };
    } catch (e2) {
      throw new Error("ต้องใช้ Node >= 22.5 (มี node:sqlite ในตัว) หรือติดตั้ง: npm install better-sqlite3");
    }
  }
}

class Outbox {
  constructor({ file = "outbox.db", maxRows = 200000, log = () => {} } = {}) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = openDb(file);
    this.maxRows = maxRows;
    this.log = log;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;          -- ไฟดับกลางคันแล้วข้อมูลต้องไม่หาย
      CREATE TABLE IF NOT EXISTS events (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id    TEXT NOT NULL UNIQUE,
        type        TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        data        TEXT NOT NULL,
        tries       INTEGER NOT NULL DEFAULT 0,
        last_error  TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    `);
  }

  /** ใส่เหตุการณ์ลงคิว — เขียนลงดิสก์เสร็จแล้วถึงจะคืน */
  put(event) {
    try {
      this.db.run(
        "INSERT INTO events (event_id, type, occurred_at, data) VALUES (?,?,?,?)",
        event.event_id, event.type, event.occurred_at, JSON.stringify(event.data)
      );
    } catch (e) {
      if (!/UNIQUE/i.test(String(e.message))) throw e;   // ซ้ำ = เคยใส่ไปแล้ว ไม่เป็นไร
    }
    this._trim();
  }

  /** ดึงชุดถัดไปไปส่ง (เรียงตาม seq เพื่อรักษาลำดับ) */
  peek(limit = 200) {
    return this.db.all(
      "SELECT seq, event_id, type, occurred_at, data FROM events ORDER BY seq LIMIT ?", limit
    ).map((r) => ({ seq: r.seq, event_id: r.event_id, type: r.type,
                    occurred_at: r.occurred_at, data: JSON.parse(r.data) }));
  }

  /** ปลายทาง ACK แล้ว — ลบทิ้งได้ */
  ack(eventIds) {
    if (!eventIds.length) return 0;
    const marks = eventIds.map(() => "?").join(",");
    this.db.run(`DELETE FROM events WHERE event_id IN (${marks})`, ...eventIds);
    return eventIds.length;
  }

  /** ปลายทางปฏิเสธถาวร (ข้อมูลผิดรูป) — ทิ้งพร้อมบันทึกเหตุผล ไม่งั้นจะติดคิวตลอดกาล */
  reject(rejections) {
    for (const r of rejections) {
      this.log(`ปลายทางปฏิเสธถาวร ${r.event_id}: ${r.reason}`);
      this.db.run("DELETE FROM events WHERE event_id = ?", r.event_id);
    }
  }

  bumpTries(eventIds, error) {
    if (!eventIds.length) return;
    const marks = eventIds.map(() => "?").join(",");
    this.db.run(`UPDATE events SET tries = tries + 1, last_error = ? WHERE event_id IN (${marks})`,
      String(error).slice(0, 300), ...eventIds);
  }

  depth() { return this.db.get("SELECT count(*) AS n FROM events").n; }
  oldestAt() { return this.db.get("SELECT min(created_at) AS t FROM events").t; }

  getMeta(k, dflt = null) { const r = this.db.get("SELECT v FROM meta WHERE k = ?", k); return r ? r.v : dflt; }
  setMeta(k, v) { this.db.run("INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v)); }

  /** คิวล้นเพราะเน็ตดับยาว: ทิ้งของเก่าที่สุดที่ "ไม่ใช่รายการขาย" ก่อนเสมอ */
  _trim() {
    const n = this.depth();
    if (n <= this.maxRows) return;
    const over = n - this.maxRows;
    this.db.run(`DELETE FROM events WHERE seq IN (
      SELECT seq FROM events WHERE type <> 'pump.transaction' ORDER BY seq LIMIT ?)`, over);
    const still = this.depth();
    if (still > this.maxRows) {
      this.log(`⚠️ คิวล้น ${still} แถว และเหลือแต่รายการขาย — จะไม่ทิ้ง ต้องรีบแก้การเชื่อมต่อ`);
    }
  }

  close() { this.db.close(); }
}

module.exports = { Outbox };
