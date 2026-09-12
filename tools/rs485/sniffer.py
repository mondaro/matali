#!/usr/bin/env python3
"""
RS-485 listen-only sniffer สำหรับ reverse-engineer โปรโตคอลหัวจ่ายน้ำมัน

ใช้กับบอร์ด ZC-C / ZC-22222 (True Supply) หรือบอร์ดจีนตระกูลเดียวกัน

หลักการ: RS-485 เป็น half-duplex master-poll เราต่อขนานเข้าไปบนสาย A/B
โดยไม่ส่งอะไรออก (listen-only) แล้วตัดเฟรมด้วย "ช่องว่างเวลา" (idle gap)
เหมือนที่ Modbus RTU ใช้ (silence >= 3.5 character times = จบเฟรม)

ความปลอดภัย:
  - สคริปต์นี้ไม่ส่งข้อมูลออกสายเด็ดขาด (ปิด RTS/DTR, ไม่เรียก write())
  - ไม่แตะ pulser, ไม่แตะซีลมาตรวัด

การใช้งาน:
  python3 sniffer.py --port /dev/ttyUSB0 --baud 9600 --out capture.jsonl
  แล้วพิมพ์ข้อความอธิบายสิ่งที่ทำหน้าตู้จ่าย + Enter เพื่อฝัง marker
  เช่น  "ยกหัวจ่าย A"  /  "จ่าย 1.00 ลิตร"  /  "วางหัวจ่าย"

ถ้าไม่รู้ baud: python3 sniffer.py --port /dev/ttyUSB0 --scan
"""

import argparse
import json
import os
import queue
import sys
import threading
import time

try:
    import serial  # pyserial
except ImportError:
    sys.exit("ต้องติดตั้งก่อน:  pip install pyserial")


COMMON_BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200]
COMMON_FRAMINGS = [
    ("8N1", serial.EIGHTBITS, serial.PARITY_NONE, serial.STOPBITS_ONE),
    ("8E1", serial.EIGHTBITS, serial.PARITY_EVEN, serial.STOPBITS_ONE),
    ("8O1", serial.EIGHTBITS, serial.PARITY_ODD, serial.STOPBITS_ONE),
    ("8N2", serial.EIGHTBITS, serial.PARITY_NONE, serial.STOPBITS_TWO),
    ("7E1", serial.SEVENBITS, serial.PARITY_EVEN, serial.STOPBITS_ONE),
]


def open_port(port, baud, bytesize, parity, stopbits):
    """เปิดพอร์ตแบบ listen-only: ไม่ยก RTS/DTR เพื่อไม่ให้ adapter สลับเป็นโหมดส่ง"""
    ser = serial.Serial()
    ser.port = port
    ser.baudrate = baud
    ser.bytesize = bytesize
    ser.parity = parity
    ser.stopbits = stopbits
    ser.timeout = 0
    ser.rtscts = False
    ser.dsrdtr = False
    ser.xonxoff = False
    ser.open()
    try:
        ser.rts = False
        ser.dtr = False
    except (OSError, ValueError):
        pass  # adapter บางตัวไม่รองรับ - ไม่เป็นไร
    ser.reset_input_buffer()
    return ser


def char_time(baud, bits_per_char=11):
    """เวลาที่ใช้ส่ง 1 ตัวอักษร (วินาที). 11 บิต = start + 8 data + parity + stop"""
    return bits_per_char / float(baud)


def hexdump(data):
    return " ".join("%02X" % b for b in data)


def ascii_repr(data):
    return "".join(chr(b) if 32 <= b < 127 else "." for b in data)


# ---------------------------------------------------------------- scan mode

def scan(port, seconds_per_combo=3.0):
    """ลองทุก baud/framing แล้วให้คะแนนว่าอันไหนน่าจะถูก

    เกณฑ์ให้คะแนน: ได้ไบต์เยอะ, ไม่มี framing error, และเฟรมมีขนาดสม่ำเสมอ
    (โปรโตคอล poll มักส่งเฟรมความยาวซ้ำ ๆ)
    """
    results = []
    print("สแกน baud/framing ... (ให้ตู้จ่ายทำงานปกติระหว่างสแกน)\n")
    for baud in COMMON_BAUDS:
        for name, bits, par, stop in COMMON_FRAMINGS:
            try:
                ser = open_port(port, baud, bits, par, stop)
            except serial.SerialException as exc:
                print("  เปิดพอร์ตไม่ได้: %s" % exc)
                return
            gap = char_time(baud) * 3.5
            frames = []
            buf = bytearray()
            last = time.monotonic()
            deadline = last + seconds_per_combo
            total = 0
            while time.monotonic() < deadline:
                chunk = ser.read(256)
                now = time.monotonic()
                if chunk:
                    if buf and (now - last) > gap:
                        frames.append(bytes(buf))
                        buf = bytearray()
                    buf += chunk
                    total += len(chunk)
                    last = now
                elif buf and (now - last) > gap:
                    frames.append(bytes(buf))
                    buf = bytearray()
                else:
                    time.sleep(0.001)
            ser.close()

            if total == 0:
                score = 0.0
            else:
                lengths = [len(f) for f in frames]
                # เฟรมยาวสม่ำเสมอ = น่าเชื่อถือ; เฟรมยาว 1 ไบต์เยอะ ๆ = อ่านผิด baud
                distinct = len(set(lengths)) or 1
                singles = sum(1 for n in lengths if n <= 2)
                score = total / (distinct * 1.0) - singles * 5
            results.append((score, baud, name, total, len(frames)))
            print("  %6d %-4s : %5d ไบต์  %4d เฟรม  score=%.1f"
                  % (baud, name, total, len(frames), score))

    results.sort(reverse=True)
    print("\nน่าจะเป็น:")
    for score, baud, name, total, nframes in results[:3]:
        if total:
            print("  --baud %d --framing %s   (%d ไบต์ / %d เฟรม)"
                  % (baud, name, total, nframes))
    if not any(r[3] for r in results):
        print("  ไม่พบข้อมูลเลย - เช็ค: สาย A/B สลับกันไหม, "
              "บอร์ดเปิดโหมด online/联机 หรือยัง, มี master poll อยู่ไหม")


# ------------------------------------------------------------ capture mode

def marker_reader(q):
    """อ่าน stdin เพื่อฝัง marker ระหว่างจับข้อมูล"""
    for line in sys.stdin:
        text = line.strip()
        if text:
            q.put(text)


def capture(port, baud, framing_name, outfile, gap_chars):
    framing = next((f for f in COMMON_FRAMINGS if f[0] == framing_name), None)
    if framing is None:
        sys.exit("framing ไม่รู้จัก: %s (เลือกจาก %s)"
                 % (framing_name, ", ".join(f[0] for f in COMMON_FRAMINGS)))
    _, bits, par, stop = framing

    ser = open_port(port, baud, bits, par, stop)
    gap = char_time(baud) * gap_chars
    print("จับข้อมูลที่ %d %s  (gap = %.1f ms)  -> %s"
          % (baud, framing_name, gap * 1000, outfile))
    print("พิมพ์คำอธิบายสิ่งที่ทำหน้าตู้จ่ายแล้วกด Enter เพื่อฝัง marker, Ctrl-C เพื่อหยุด\n")

    mq = queue.Queue()
    threading.Thread(target=marker_reader, args=(mq,), daemon=True).start()

    fh = open(outfile, "a", buffering=1)
    t0 = time.time()
    buf = bytearray()
    last = time.monotonic()
    count = 0

    def flush_frame():
        nonlocal buf, count
        if not buf:
            return
        rec = {
            "t": round(time.time() - t0, 6),
            "kind": "frame",
            "len": len(buf),
            "hex": hexdump(buf),
            "ascii": ascii_repr(buf),
        }
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        count += 1
        print("[%9.3f] %3d  %s  |%s|"
              % (rec["t"], rec["len"], rec["hex"], rec["ascii"]))
        buf = bytearray()

    try:
        while True:
            while not mq.empty():
                text = mq.get()
                rec = {"t": round(time.time() - t0, 6), "kind": "marker", "text": text}
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                print(">>> MARKER: %s" % text)

            chunk = ser.read(512)
            now = time.monotonic()
            if chunk:
                if buf and (now - last) > gap:
                    flush_frame()
                buf += chunk
                last = now
            else:
                if buf and (now - last) > gap:
                    flush_frame()
                time.sleep(0.0005)
    except KeyboardInterrupt:
        flush_frame()
        print("\nจับได้ %d เฟรม -> %s" % (count, outfile))
    finally:
        fh.close()
        ser.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", required=True, help="เช่น /dev/ttyUSB0 หรือ COM3")
    ap.add_argument("--baud", type=int, default=9600)
    ap.add_argument("--framing", default="8N1",
                    help="8N1 | 8E1 | 8O1 | 8N2 | 7E1")
    ap.add_argument("--gap-chars", type=float, default=3.5,
                    help="ช่องว่างกี่ character time ถึงถือว่าจบเฟรม (ค่าเริ่มต้น 3.5 แบบ Modbus)")
    ap.add_argument("--out", default="capture.jsonl")
    ap.add_argument("--scan", action="store_true", help="สแกนหา baud/framing ที่ถูก")
    args = ap.parse_args()

    if args.scan:
        scan(args.port)
    else:
        capture(args.port, args.baud, args.framing, args.out, args.gap_chars)


if __name__ == "__main__":
    main()
