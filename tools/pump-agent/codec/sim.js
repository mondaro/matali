// ==========================================================================
// codec "sim" — ตรงกับ tools/rs485/sim_zc.py (โปรโตคอลสมมติแบบบอร์ดจีน)
// ใช้พัฒนา/ทดสอบก่อนถอดโปรโตคอลจริงของบอร์ด ZC ได้
//
// เฟรม: 02 ADDR CMD LEN DATA... SUM8 03   (SUM8 = ผลรวม ADDR..DATA)
// ตัวเลขเป็น BCD big-endian
//
// เมื่อถอดโปรโตคอลจริงได้ ให้เขียน codec/zc.js ที่ export หน้าตาเดียวกันนี้
// แล้วเปลี่ยนแค่ "codec" ใน config — ที่เหลือทั้งระบบไม่ต้องแก้
// ==========================================================================
"use strict";

const STX = 0x02, ETX = 0x03;

const CMD = { STATUS: 0x10, FILLING: 0x11, TOTALIZER: 0x12, AUTHORIZE: 0x20, STOP: 0x21, SET_PRICE: 0x30 };
const RSP = { STATUS: 0x90, FILLING: 0x91, TOTALIZER: 0x92, ACK: 0xa0 };

// สถานะที่บอร์ดรายงาน → ชื่อกลางที่ทั้งระบบใช้ร่วมกัน
const STATE = ["IDLE", "NOZZLE_UP", "AUTHORIZED", "FILLING", "DONE"];

function toBcd(value, nbytes) {
  const s = String(Math.round(value)).padStart(nbytes * 2, "0").slice(-nbytes * 2);
  return Buffer.from(s.match(/../g).map((h) => parseInt(h, 16)));
}
function fromBcd(buf) {
  let s = "";
  for (const b of buf) s += b.toString(16).padStart(2, "0");
  return parseInt(s || "0", 10);
}
function build(addr, cmd, payload = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from([addr, cmd, payload.length]), payload]);
  let sum = 0;
  for (const b of body) sum = (sum + b) & 0xff;
  return Buffer.concat([Buffer.from([STX]), body, Buffer.from([sum, ETX])]);
}

/** แกะเฟรมแรกที่สมบูรณ์ออกจาก buffer → { frame, rest } หรือ { frame:null, rest } */
function decode(buf) {
  let i = 0;
  while (i < buf.length && buf[i] !== STX) i++;
  if (buf.length - i < 6) return { frame: null, rest: buf.slice(i) };
  const len = buf[i + 3];
  const total = 4 + len + 2;
  if (buf.length - i < total) return { frame: null, rest: buf.slice(i) };
  const f = buf.slice(i, i + total);
  const body = f.slice(1, 4 + len);
  let sum = 0;
  for (const b of body) sum = (sum + b) & 0xff;
  if (sum !== f[4 + len] || f[total - 1] !== ETX) {
    return { frame: null, rest: buf.slice(i + 1) };      // เฟรมเสีย ขยับไป STX ตัวถัดไป
  }
  return {
    frame: { addr: body[0], cmd: body[1], payload: body.slice(3) },
    rest: buf.slice(i + total),
  };
}

module.exports = {
  name: "sim",
  decode,

  // ---- คำสั่งที่ agent ส่งออกไป: คืน { frame, parse } ----
  readStatus(addr) {
    return {
      frame: build(addr, CMD.STATUS),
      parse: (f) => {
        if (f.cmd !== RSP.STATUS) throw new Error(`ตอบผิดชนิด 0x${f.cmd.toString(16)}`);
        return { state: STATE[f.payload[0]] || "UNKNOWN", nozzleNo: f.payload[1] };
      },
    };
  },

  readFilling(addr) {
    return {
      frame: build(addr, CMD.FILLING),
      parse: (f) => {
        if (f.cmd !== RSP.FILLING) throw new Error(`ตอบผิดชนิด 0x${f.cmd.toString(16)}`);
        const p = f.payload;
        return {
          nozzleNo: p[0],
          liters: fromBcd(p.slice(1, 5)) / 1000,
          amount: fromBcd(p.slice(5, 9)) / 100,
          unitPrice: fromBcd(p.slice(9, 12)) / 100,
          pumpSeq: fromBcd(p.slice(12, 14)),
        };
      },
    };
  },

  readTotalizer(addr, nozzleNo) {
    return {
      frame: build(addr, CMD.TOTALIZER, Buffer.from([nozzleNo])),
      parse: (f) => {
        if (f.cmd !== RSP.TOTALIZER) throw new Error(`ตอบผิดชนิด 0x${f.cmd.toString(16)}`);
        const p = f.payload;
        return {
          nozzleNo: p[0],
          volTotal: fromBcd(p.slice(1, 6)) / 100,
          amtTotal: fromBcd(p.slice(6, 11)) / 100,
        };
      },
    };
  },

  /** mode: FREE | AMOUNT | VOLUME ; preset เป็นบาท (AMOUNT) หรือลิตร (VOLUME) */
  authorize(addr, nozzleNo, mode, preset) {
    const modeByte = { FREE: 0, AMOUNT: 1, VOLUME: 2 }[mode];
    if (modeByte === undefined) throw new Error(`mode ไม่รู้จัก: ${mode}`);
    const raw = mode === "AMOUNT" ? Math.round(preset * 100)
      : mode === "VOLUME" ? Math.round(preset * 1000) : 0;
    return {
      frame: build(addr, CMD.AUTHORIZE, Buffer.concat([Buffer.from([nozzleNo, modeByte]), toBcd(raw, 4)])),
      parse: parseAck,
    };
  },

  stop(addr, nozzleNo) {
    return { frame: build(addr, CMD.STOP, Buffer.from([nozzleNo])), parse: parseAck };
  },

  setPrice(addr, nozzleNo, price) {
    return {
      frame: build(addr, CMD.SET_PRICE, Buffer.concat([Buffer.from([nozzleNo]), toBcd(Math.round(price * 100), 3)])),
      parse: parseAck,
    };
  },
};

function parseAck(f) {
  if (f.cmd !== RSP.ACK) throw new Error(`ตอบผิดชนิด 0x${f.cmd.toString(16)}`);
  if (f.payload[0] !== 0x00) throw new Error("ตู้จ่ายปฏิเสธคำสั่ง (NAK)");
  return { ok: true };
}
