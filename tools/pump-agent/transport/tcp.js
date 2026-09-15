// ต่อกับตู้จ่ายจำลอง (tools/rs485/sim_zc.py --tcp) ตอนพัฒนา
"use strict";
const net = require("net");

module.exports = function tcpTransport({ host = "127.0.0.1", port }) {
  let sock = null, onData = null;
  return {
    describe: () => `tcp://${host}:${port}`,
    async open(handler) {
      onData = handler;
      await new Promise((resolve, reject) => {
        sock = net.createConnection({ host, port }, resolve);
        sock.once("error", reject);
      });
      sock.on("data", (d) => onData(d));
      sock.on("error", () => {});
    },
    write(buf) { sock.write(buf); },
    close() { if (sock) sock.destroy(); sock = null; },
  };
};
