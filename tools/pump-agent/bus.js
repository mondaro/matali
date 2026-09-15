// ==========================================================================
// Bus — RS-485 เส้นหนึ่ง = master ตัวเดียว = คิวคำสั่งเดียว
//
// RS-485 เป็น half-duplex: ห้ามมีสองอย่างยิงพร้อมกันเด็ดขาด
// ทุกคำขอจึงต้องผ่านคิวนี้ตัวเดียว ทำทีละรายการ
// ==========================================================================
"use strict";

class Bus {
  constructor({ id, transport, codec, timeoutMs = 300, retries = 2, gapMs = 20, log = () => {} }) {
    this.id = id;
    this.transport = transport;
    this.codec = codec;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.gapMs = gapMs;                 // เว้นช่วงระหว่างเฟรม กัน RS-485 ชนกัน
    this.log = log;
    this.buf = Buffer.alloc(0);
    this.pending = null;                // { addr, parse, resolve, reject, timer }
    this.queue = [];
    this.running = false;
    this.stats = { sent: 0, ok: 0, timeout: 0, badFrame: 0 };
  }

  async open() {
    await this.transport.open((chunk) => this._onData(chunk));
    this.log(`bus ${this.id} เปิดแล้ว (${this.transport.describe()})`);
  }

  close() { this.transport.close(); }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const { frame, rest } = this.codec.decode(this.buf);
      this.buf = rest;
      if (!frame) break;
      const p = this.pending;
      if (!p) { this.stats.badFrame++; continue; }        // เฟรมที่ไม่ได้ขอ - ทิ้ง
      if (frame.addr !== p.addr) { this.stats.badFrame++; continue; }
      clearTimeout(p.timer);
      this.pending = null;
      try { this.stats.ok++; p.resolve(p.parse(frame)); }
      catch (e) { p.reject(e); }
    }
  }

  /** ส่ง 1 คำขอผ่านคิว — request มาจาก codec: { frame, parse } */
  request(addr, { frame, parse }) {
    return new Promise((resolve, reject) => {
      this.queue.push({ addr, frame, parse, resolve, reject, tries: 0 });
      this._pump();
    });
  }

  async _pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        try {
          const result = await this._sendOnce(job);
          job.resolve(result);
        } catch (e) {
          if (job.tries < this.retries) { job.tries++; this.queue.unshift(job); }
          else job.reject(e);
        }
        if (this.gapMs) await new Promise((r) => setTimeout(r, this.gapMs));
      }
    } finally { this.running = false; }
  }

  _sendOnce(job) {
    return new Promise((resolve, reject) => {
      this.buf = Buffer.alloc(0);                        // ทิ้งเศษของรอบก่อน
      this.pending = {
        addr: job.addr, parse: job.parse, resolve, reject,
        timer: setTimeout(() => {
          this.pending = null;
          this.stats.timeout++;
          reject(new Error(`ตู้จ่าย addr=${job.addr} ไม่ตอบใน ${this.timeoutMs} ms`));
        }, this.timeoutMs),
      };
      this.stats.sent++;
      this.transport.write(job.frame);
    });
  }
}

module.exports = { Bus };
