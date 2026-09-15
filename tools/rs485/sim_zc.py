#!/usr/bin/env python3
"""
ZC dispenser simulator - ตู้จ่ายน้ำมันจำลอง (บอร์ด ZC / Zcheng) สำหรับพัฒนาก่อนได้ของจริง

⚠️ โปรโตคอลในไฟล์นี้เป็น "สมมติฐาน" ที่สร้างขึ้นให้เหมือนบอร์ดจีนทั่วไป
   ยังไม่ใช่โปรโตคอลจริงของ ZC-C — เอาไว้พัฒนา agent / UDOM Next integration
   ก่อนถอดโปรโตคอลจริงได้ พอถอดได้แล้วให้แก้เฉพาะไฟล์ codec ตัวเดียว

รูปแบบเฟรม (เหมือนบอร์ดจีนส่วนใหญ่):
    02  ADDR  CMD  LEN  DATA...  SUM8  03
    SUM8 = ผลรวมของ ADDR..DATA (ไม่รวม 02, SUM, 03) & 0xFF
    ตัวเลขทั้งหมดเป็น BCD (big-endian)

คำสั่ง master -> ตู้จ่าย            ตอบกลับ (CMD | 0x80)
    0x10 อ่านสถานะ                  0x90  state(1) nozzle(1)
    0x11 อ่านรายการที่กำลัง/เพิ่งจ่าย  0x91  nozzle(1) vol BCD4(x1000 L) amt BCD4(x100 ฿) price BCD3(x100) seq BCD2
    0x12 อ่าน totalizer  [nozzle]    0x92  nozzle(1) vol BCD5(x100 L) amt BCD5(x100 ฿)
    0x20 อนุญาตจ่าย [nz, mode, BCD4] 0xA0  00=ok 01=error   (mode 0=อิสระ 1=ตามเงิน 2=ตามลิตร)
    0x21 หยุด [nozzle]               0xA0
    0x30 ตั้งราคา [nz, BCD3(x100)]   0xA0

สถานะ: 0=ว่าง 1=ยกหัวจ่าย 2=อนุญาตแล้ว 3=กำลังจ่าย 4=จ่ายเสร็จรอเคลียร์

การใช้งาน:
    python3 sim_zc.py --tcp 5000            # ให้ agent ต่อ TCP (ง่ายสุดสำหรับ Node)
    python3 sim_zc.py --pty                 # สร้าง /dev/pts/N ให้เปิดเหมือน serial จริง
คำสั่งที่พิมพ์ระหว่างรัน:
    up 1 | down 1 | flow 40 | fault 1 | ok 1 | state | quit
"""

import argparse
import os
import pty
import queue
import socket
import sys
import threading
import time

STX, ETX = 0x02, 0x03

IDLE, NOZZLE_UP, AUTHORIZED, FILLING, DONE = 0, 1, 2, 3, 4
STATE_NAME = {IDLE: "ว่าง", NOZZLE_UP: "ยกหัวจ่าย", AUTHORIZED: "อนุญาตแล้ว",
              FILLING: "กำลังจ่าย", DONE: "จ่ายเสร็จ"}


def to_bcd(value, nbytes):
    """int -> BCD big-endian nbytes ไบต์"""
    s = str(int(value)).rjust(nbytes * 2, "0")[-nbytes * 2:]
    return bytes(int(s[i:i + 2], 16) for i in range(0, len(s), 2))


def from_bcd(data):
    return int("".join("%02X" % b for b in data) or "0")


def build(addr, cmd, payload=b""):
    body = bytes([addr, cmd, len(payload)]) + payload
    return bytes([STX]) + body + bytes([sum(body) & 0xFF, ETX])


def parse(buf):
    """แกะเฟรมแรกที่สมบูรณ์ออกจาก buf -> (addr, cmd, payload, ไบต์ที่เหลือ) หรือ (None,...,buf)"""
    while buf and buf[0] != STX:
        buf = buf[1:]
    if len(buf) < 6:
        return None, None, None, buf
    length = buf[3]
    total = 4 + length + 2
    if len(buf) < total:
        return None, None, None, buf
    frame = buf[:total]
    body = frame[1:4 + length]
    if (sum(body) & 0xFF) != frame[4 + length] or frame[total - 1] != ETX:
        return None, None, None, buf[1:]          # เฟรมเสีย ขยับไปหา STX ตัวถัดไป
    return body[0], body[1], bytes(body[3:]), buf[total:]


class Nozzle:
    def __init__(self, no, product, price):
        self.no = no
        self.product = product
        self.price = price          # บาท/ลิตร
        self.state = IDLE
        self.mode = 0               # 0 อิสระ 1 ตามเงิน 2 ตามลิตร
        self.preset = 0.0
        self.volume = 0.0           # ลิตรของรายการปัจจุบัน
        self.amount = 0.0
        self.seq = 0
        self.tot_volume = 12845.512  # totalizer สะสม
        self.tot_amount = 493_712.40
        self.fault = False


class Dispenser:
    """ตู้จ่าย 1 ตู้ = 1 address = 2 หัวจ่าย (A/B) ตามบอร์ด ZC"""

    def __init__(self, addr, nozzles):
        self.addr = addr
        self.nozzles = {n.no: n for n in nozzles}
        self.flow_lpm = 40.0
        self.lock = threading.Lock()

    def nz(self, no):
        return self.nozzles.get(no)

    # ----- การจำลองการไหลของน้ำมัน -----
    def tick(self, dt):
        with self.lock:
            for n in self.nozzles.values():
                if n.state != FILLING:
                    continue
                step = self.flow_lpm / 60.0 * dt
                if n.mode == 1 and n.preset > 0:
                    remain_l = max(0.0, n.preset / n.price - n.volume)
                    step = min(step, remain_l)
                elif n.mode == 2 and n.preset > 0:
                    step = min(step, max(0.0, n.preset - n.volume))
                n.volume = round(n.volume + step, 3)
                n.amount = round(n.volume * n.price, 2)
                n.tot_volume = round(n.tot_volume + step, 3)
                n.tot_amount = round(n.tot_amount + step * n.price, 2)
                reached = (n.mode == 1 and n.amount >= n.preset - 0.005) or \
                          (n.mode == 2 and n.volume >= n.preset - 0.0005)
                if n.preset > 0 and reached:
                    n.state = DONE
                    print("  [sim] หัวจ่าย %d ครบ preset -> %.3f ล. %.2f ฿"
                          % (n.no, n.volume, n.amount))

    # ----- ตอบคำสั่ง -----
    def handle(self, cmd, payload):
        with self.lock:
            if cmd == 0x10:                                   # อ่านสถานะ
                active = next((n for n in self.nozzles.values() if n.state != IDLE), None)
                n = active or next(iter(self.nozzles.values()))
                return 0x90, bytes([n.state, n.no])

            if cmd == 0x11:                                   # อ่านรายการ
                active = next((n for n in self.nozzles.values()
                               if n.state in (FILLING, DONE, AUTHORIZED)), None)
                n = active or next(iter(self.nozzles.values()))
                return 0x91, (bytes([n.no])
                              + to_bcd(round(n.volume * 1000), 4)
                              + to_bcd(round(n.amount * 100), 4)
                              + to_bcd(round(n.price * 100), 3)
                              + to_bcd(n.seq, 2))

            if cmd == 0x12:                                   # อ่าน totalizer
                n = self.nz(payload[0] if payload else 1)
                if not n:
                    return 0xA0, b"\x01"
                return 0x92, (bytes([n.no])
                              + to_bcd(round(n.tot_volume * 100), 5)
                              + to_bcd(round(n.tot_amount * 100), 5))

            if cmd == 0x20:                                   # อนุญาตจ่าย
                if len(payload) < 6:
                    return 0xA0, b"\x01"
                n = self.nz(payload[0])
                if not n or n.fault or n.state not in (NOZZLE_UP, IDLE):
                    return 0xA0, b"\x01"
                n.mode = payload[1]
                raw = from_bcd(payload[2:6])
                n.preset = raw / 100.0 if n.mode == 1 else raw / 1000.0 if n.mode == 2 else 0.0
                n.volume = n.amount = 0.0
                n.seq = (n.seq + 1) % 10000
                n.state = FILLING if n.state == NOZZLE_UP else AUTHORIZED
                print("  [sim] อนุญาตหัวจ่าย %d mode=%d preset=%.2f seq=%d"
                      % (n.no, n.mode, n.preset, n.seq))
                return 0xA0, b"\x00"

            if cmd == 0x21:                                   # หยุด
                n = self.nz(payload[0] if payload else 1)
                if not n:
                    return 0xA0, b"\x01"
                if n.state in (AUTHORIZED, FILLING):
                    n.state = DONE
                    print("  [sim] หยุดหัวจ่าย %d ที่ %.3f ล." % (n.no, n.volume))
                return 0xA0, b"\x00"

            if cmd == 0x30:                                   # ตั้งราคา
                if len(payload) < 4:
                    return 0xA0, b"\x01"
                n = self.nz(payload[0])
                if not n:
                    return 0xA0, b"\x01"
                n.price = from_bcd(payload[1:4]) / 100.0
                print("  [sim] ตั้งราคาหัวจ่าย %d = %.2f ฿/ล." % (n.no, n.price))
                return 0xA0, b"\x00"

            return 0xA0, b"\x01"                              # คำสั่งไม่รู้จัก

    # ----- คำสั่งจากคีย์บอร์ด -----
    def operator(self, line):
        parts = line.split()
        if not parts:
            return
        cmd = parts[0].lower()
        arg = parts[1] if len(parts) > 1 else None
        with self.lock:
            if cmd == "up" and arg:
                n = self.nz(int(arg))
                if n:
                    if n.state == FILLING:
                        print("  [sim] หัวจ่าย %d ยกอยู่แล้ว (ไม่ทำอะไร)" % n.no)
                    else:
                        if n.state == AUTHORIZED:
                            n.state = FILLING          # อนุญาตไว้ก่อน แล้วค่อยยก
                        else:
                            n.state = NOZZLE_UP        # ยกก่อน รอการอนุญาต
                            n.volume = n.amount = 0.0
                        print("  [sim] ยกหัวจ่าย %d -> %s" % (n.no, STATE_NAME[n.state]))
            elif cmd == "down" and arg:
                n = self.nz(int(arg))
                if n:
                    if n.state in (FILLING, AUTHORIZED):
                        n.state = DONE
                        print("  [sim] วางหัวจ่าย %d จบรายการ %.3f ล. %.2f ฿"
                              % (n.no, n.volume, n.amount))
                    else:
                        n.state = IDLE
            elif cmd == "clear" and arg:
                n = self.nz(int(arg))
                if n:
                    n.state = IDLE
                    n.volume = n.amount = 0.0
            elif cmd == "flow" and arg:
                self.flow_lpm = float(arg)
                print("  [sim] อัตราการไหล = %.1f ล./นาที" % self.flow_lpm)
            elif cmd in ("fault", "ok") and arg:
                n = self.nz(int(arg))
                if n:
                    n.fault = (cmd == "fault")
                    print("  [sim] หัวจ่าย %d fault=%s" % (n.no, n.fault))
            elif cmd == "state":
                for n in self.nozzles.values():
                    print("  หัวจ่าย %d %-6s %-10s %8.3f ล. %10.2f ฿  ราคา %.2f  tot %.3f ล."
                          % (n.no, n.product, STATE_NAME[n.state], n.volume,
                             n.amount, n.price, n.tot_volume))
            else:
                print("  คำสั่ง: up N | down N | clear N | flow LPM | fault N | ok N | state | quit")


def serve(disp, read_fn, write_fn, stop_evt):
    buf = b""
    last = time.monotonic()
    while not stop_evt.is_set():
        now = time.monotonic()
        disp.tick(now - last)
        last = now
        chunk = read_fn()
        if chunk is None:
            return                             # อีกฝั่งปิดการเชื่อมต่อ
        if not chunk:
            time.sleep(0.02)
            continue
        buf += chunk
        while True:
            addr, cmd, payload, buf = parse(buf)
            if addr is None:
                break
            if addr != disp.addr:
                continue                       # ไม่ใช่ address ของเรา - เงียบ (เหมือน RS-485 จริง)
            rcmd, rpayload = disp.handle(cmd, payload)
            time.sleep(0.01)                   # หน่วงแบบบอร์ดจริง
            write_fn(build(disp.addr, rcmd, rpayload))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tcp", type=int, help="เปิด TCP server ที่พอร์ตนี้ (แนะนำสำหรับ agent ที่เขียนด้วย Node)")
    ap.add_argument("--pty", action="store_true", help="สร้าง pseudo-serial /dev/pts/N")
    ap.add_argument("--addr", type=int, default=1, help="address ของตู้จ่าย (ค่าเริ่มต้น 1)")
    args = ap.parse_args()

    disp = Dispenser(args.addr, [Nozzle(1, "D", 32.94), Nozzle(2, "G95", 38.44)])
    stop = threading.Event()

    def keyboard():
        for line in sys.stdin:
            line = line.strip()
            if line in ("quit", "exit"):
                stop.set()
                return
            disp.operator(line)
    threading.Thread(target=keyboard, daemon=True).start()

    print("ตู้จ่ายจำลอง addr=%d  หัวจ่าย 1=ดีเซล 32.94  2=แก๊สโซฮอล์95 38.44" % args.addr)
    print("พิมพ์ 'state' ดูสถานะ, 'up 1' ยกหัวจ่าย, 'quit' ออก\n")

    if args.pty:
        master, slave = pty.openpty()
        print("เปิดพอร์ตนี้ในโปรแกรมของคุณ:  %s\n" % os.ttyname(slave))
        os.set_blocking(master, False)

        def read_fn():
            try:
                return os.read(master, 1024)
            except BlockingIOError:
                return b""
        serve(disp, read_fn, lambda b: os.write(master, b), stop)

    elif args.tcp:
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("127.0.0.1", args.tcp))
        srv.listen(1)
        print("รอการเชื่อมต่อที่ tcp://127.0.0.1:%d\n" % args.tcp)
        while not stop.is_set():
            srv.settimeout(0.5)
            try:
                conn, _ = srv.accept()
            except socket.timeout:
                continue
            print("  [sim] มีการเชื่อมต่อเข้ามา")
            conn.setblocking(False)

            def read_fn():
                try:
                    data = conn.recv(1024)
                    return data if data else None
                except (BlockingIOError, socket.error):
                    return b""
            try:
                serve(disp, read_fn, conn.sendall, stop)
            except (BrokenPipeError, OSError, TypeError):
                pass
            try:
                print("  [sim] การเชื่อมต่อปิด")
            except BrokenPipeError:
                pass
            conn.close()
    else:
        ap.error("ต้องระบุ --tcp PORT หรือ --pty")


if __name__ == "__main__":
    main()
