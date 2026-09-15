// RS-485 ของจริง — ต้องติดตั้ง serialport: npm install serialport
// หมายเหตุ: adapter แบบ auto-direction (ที่มีชิป MAX485 + วงจร TX enable อัตโนมัติ)
// ใช้ได้เลย ไม่ต้องคุม RTS เอง ถ้าเป็นแบบคุม RTS ต้องตั้ง rtsMode ใน config
"use strict";

module.exports = function serialTransport({ port, baud = 9600, framing = "8N1" }) {
  let SerialPort;
  try { ({ SerialPort } = require("serialport")); }
  catch { throw new Error("ต้องติดตั้งก่อน: npm install serialport"); }

  const m = /^([78])([NEO])([12])$/.exec(framing);
  if (!m) throw new Error(`framing ไม่ถูกต้อง: ${framing} (เช่น 8N1, 8E1)`);
  const opts = {
    path: port,
    baudRate: baud,
    dataBits: Number(m[1]),
    parity: { N: "none", E: "even", O: "odd" }[m[2]],
    stopBits: Number(m[3]),
    autoOpen: false,
  };

  let sp = null;
  return {
    describe: () => `${port} ${baud} ${framing}`,
    async open(handler) {
      sp = new SerialPort(opts);
      await new Promise((resolve, reject) => sp.open((e) => (e ? reject(e) : resolve())));
      sp.on("data", (d) => handler(d));
      sp.on("error", () => {});
    },
    write(buf) { sp.write(buf); },
    close() { if (sp && sp.isOpen) sp.close(); sp = null; },
  };
};
