#!/usr/bin/env python3
"""
Active prober สำหรับบัส RS-485 ที่ "เงียบ" (ไม่มี POS เดิมคอย poll)

ทำไมต้องมี: ตู้จ่ายเป็น slave มันจะพูดก็ต่อเมื่อถูกถามเท่านั้น
ถ้าไม่มี master บนบัส การดักฟังเฉย ๆ (sniffer.py) จะไม่ได้อะไรเลย
เครื่องมือนี้ทำหน้าที่เป็น master ชั่วคราวเพื่อ "หาเสียงตอบ"

กลยุทธ์ลดพื้นที่ค้นหา (baud x framing x address x รูปแบบเฟรม):
  ขั้น 1  โหมด modbus  - ปลอดภัย ส่งเฉพาะคำสั่งอ่าน สแกน addr 1..247
                         บอร์ดจีนบางรุ่นใช้ Modbus RTU ตรง ๆ ถ้าใช่ = จบใน 1 ชั่วโมง
  ขั้น 2  โหมด generic - ลองรูปแบบเฟรมของบอร์ดจีนที่พบบ่อย (ต้องมี --bench)
  ทั้งสองขั้นจับ "ไบต์อะไรก็ได้ที่วิ่งกลับมา" ไม่ใช่แค่เฟรมที่ถูกต้อง
  เพราะถ้า baud ใกล้เคียงแต่ไม่ตรง เราจะได้ขยะกลับมา -- ขยะก็คือเบาะแส

⚠️ ความปลอดภัย
  - โหมด modbus ส่งเฉพาะ function code อ่าน (01/03/04) ไม่เขียนอะไรทั้งสิ้น
  - โหมด generic ต้องใส่ --bench ยืนยันว่าทดสอบกับบอร์ดบนโต๊ะ ไม่ใช่ตู้ที่ให้บริการอยู่
  - ห้ามรันกับตู้จ่ายที่กำลังให้บริการลูกค้า

การใช้งาน:
  python3 prober.py --port /dev/ttyUSB0 --mode modbus
  python3 prober.py --port /dev/ttyUSB0 --mode modbus --baud 9600 --addr-max 32
  python3 prober.py --port /dev/ttyUSB0 --mode generic --bench --baud 9600
"""

import argparse
import itertools
import sys
import time

try:
    import serial
except ImportError:
    sys.exit("ต้องติดตั้งก่อน:  pip install pyserial")

BAUDS = [9600, 19200, 4800, 38400, 2400, 57600, 1200, 115200]
FRAMINGS = [
    ("8N1", serial.EIGHTBITS, serial.PARITY_NONE, serial.STOPBITS_ONE),
    ("8E1", serial.EIGHTBITS, serial.PARITY_EVEN, serial.STOPBITS_ONE),
    ("8O1", serial.EIGHTBITS, serial.PARITY_ODD, serial.STOPBITS_ONE),
    ("8N2", serial.EIGHTBITS, serial.PARITY_NONE, serial.STOPBITS_TWO),
]


def crc16_modbus(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def modbus_frame(addr, fc, start=0, count=1):
    body = bytes([addr, fc, start >> 8, start & 0xFF, count >> 8, count & 0xFF])
    crc = crc16_modbus(body)
    return body + bytes([crc & 0xFF, crc >> 8])


# ---- รูปแบบเฟรมที่พบบ่อยในบอร์ดจีน (สำหรับโหมด generic) ----
# แต่ละตัวคือฟังก์ชัน (addr, cmd) -> bytes
def f_stx_sum_etx(addr, cmd):
    body = bytes([addr, cmd, 0x00])
    return bytes([0x02]) + body + bytes([sum(body) & 0xFF, 0x03])


def f_stx_sum_etx_nolen(addr, cmd):
    body = bytes([addr, cmd])
    return bytes([0x02]) + body + bytes([sum(body) & 0xFF, 0x03])


def f_aa_xor(addr, cmd):
    body = bytes([addr, cmd, 0x00])
    x = 0
    for b in body:
        x ^= b
    return bytes([0xAA]) + body + bytes([x])


def f_55_sum(addr, cmd):
    body = bytes([addr, cmd, 0x00])
    return bytes([0x55]) + body + bytes([sum(body) & 0xFF])


def f_bare_sum(addr, cmd):
    body = bytes([addr, cmd])
    return body + bytes([sum(body) & 0xFF])


def f_high_addr(addr, cmd):
    """บางโปรโตคอลตั้งบิตสูงของ address ไว้เป็นเครื่องหมายเริ่มเฟรม"""
    body = bytes([0x80 | (addr & 0x7F), cmd])
    return body + bytes([sum(body) & 0xFF])


def f_fa_crc(addr, cmd):
    body = bytes([addr, cmd, 0x00])
    crc = crc16_modbus(body)
    return bytes([0xFA, 0xFB]) + body + bytes([crc & 0xFF, crc >> 8])


GENERIC_TEMPLATES = [
    ("STX+len+sum8+ETX", f_stx_sum_etx),
    ("STX+sum8+ETX", f_stx_sum_etx_nolen),
    ("AA+xor8", f_aa_xor),
    ("55+sum8", f_55_sum),
    ("addr+cmd+sum8", f_bare_sum),
    ("0x80|addr+cmd+sum8", f_high_addr),
    ("FAFB+crc16", f_fa_crc),
]

# คำสั่งที่ "น่าจะเป็นการอ่าน" เท่านั้น - ค่าต่ำ ๆ มักเป็น status/query
SAFE_CMDS = [0x00, 0x01, 0x10, 0x11, 0x20, 0x30, 0x40, 0x50]


def open_port(port, baud, framing):
    _, bits, par, stop = framing
    ser = serial.Serial(port=port, baudrate=baud, bytesize=bits, parity=par,
                        stopbits=stop, timeout=0, rtscts=False, dsrdtr=False)
    ser.reset_input_buffer()
    ser.reset_output_buffer()
    return ser


def ask(ser, frame, wait_s):
    """ส่ง 1 เฟรม แล้วรอฟังคำตอบ - คืนไบต์ทั้งหมดที่ได้ (อาจเป็นขยะ)"""
    ser.reset_input_buffer()
    ser.write(frame)
    ser.flush()
    got = bytearray()
    deadline = time.monotonic() + wait_s
    while time.monotonic() < deadline:
        chunk = ser.read(256)
        if chunk:
            got += chunk
            deadline = time.monotonic() + 0.05   # ยังไหลอยู่ - รอต่ออีกนิด
        else:
            time.sleep(0.002)
    return bytes(got)


def report_hit(kind, baud, framing_name, addr, detail, resp):
    print("\n" + "!" * 70)
    print("!! เจอการตอบสนอง: %s" % kind)
    print("!!   baud=%d  framing=%s  addr=%d  %s" % (baud, framing_name, addr, detail))
    print("!!   ตอบกลับ %d ไบต์: %s" % (len(resp), " ".join("%02X" % b for b in resp)))
    print("!" * 70 + "\n")


def probe_modbus(port, bauds, framings, addr_max, wait_s):
    hits = []
    for baud in bauds:
        for framing in framings:
            try:
                ser = open_port(port, baud, framing)
            except serial.SerialException as exc:
                sys.exit("เปิดพอร์ตไม่ได้: %s" % exc)
            print("สแกน Modbus RTU  baud=%-6d framing=%s  addr 1..%d"
                  % (baud, framing[0], addr_max))
            for addr in range(1, addr_max + 1):
                for fc in (0x03, 0x04, 0x01):
                    resp = ask(ser, modbus_frame(addr, fc), wait_s)
                    if not resp:
                        continue
                    valid = (len(resp) >= 5 and resp[0] == addr
                             and crc16_modbus(resp[:-2]) == (resp[-2] | (resp[-1] << 8)))
                    kind = "Modbus RTU ถูกต้อง ✅" if valid else "มีไบต์กลับมา (baud อาจใกล้เคียง)"
                    report_hit(kind, baud, framing[0], addr, "fc=0x%02X" % fc, resp)
                    hits.append((baud, framing[0], addr, fc, valid, resp))
                    if valid:
                        ser.close()
                        return hits
            ser.close()
    return hits


def probe_generic(port, bauds, framings, addr_max, wait_s):
    hits = []
    for baud in bauds:
        for framing in framings:
            try:
                ser = open_port(port, baud, framing)
            except serial.SerialException as exc:
                sys.exit("เปิดพอร์ตไม่ได้: %s" % exc)
            print("สแกน generic  baud=%-6d framing=%s  (%d รูปแบบ x %d คำสั่ง x %d address)"
                  % (baud, framing[0], len(GENERIC_TEMPLATES), len(SAFE_CMDS), addr_max))
            for addr, (tname, tf), cmd in itertools.product(
                    range(1, addr_max + 1), GENERIC_TEMPLATES, SAFE_CMDS):
                resp = ask(ser, tf(addr, cmd), wait_s)
                if resp:
                    report_hit("ตอบกลับในโหมด generic", baud, framing[0], addr,
                               "รูปแบบ=%s cmd=0x%02X" % (tname, cmd), resp)
                    hits.append((baud, framing[0], addr, tname, cmd, resp))
            ser.close()
    return hits


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", required=True)
    ap.add_argument("--mode", choices=["modbus", "generic"], default="modbus")
    ap.add_argument("--baud", type=int, help="ล็อก baud เดียว (ไม่ใส่ = ไล่ทุกค่า)")
    ap.add_argument("--framing", help="ล็อก framing เดียว เช่น 8N1")
    ap.add_argument("--addr-max", type=int, default=32,
                    help="สแกน address ถึงเท่าไร (modbus สูงสุด 247, ค่าเริ่มต้น 32)")
    ap.add_argument("--wait", type=float, default=0.15, help="รอคำตอบกี่วินาทีต่อ 1 เฟรม")
    ap.add_argument("--bench", action="store_true",
                    help="ยืนยันว่าทดสอบกับบอร์ดบนโต๊ะ ไม่ใช่ตู้ที่ให้บริการอยู่ (บังคับสำหรับ generic)")
    args = ap.parse_args()

    if args.mode == "generic" and not args.bench:
        sys.exit("โหมด generic ส่งเฟรมที่ไม่รู้ความหมายเข้าไปในบอร์ด\n"
                 "ต้องใส่ --bench เพื่อยืนยันว่าทดสอบกับบอร์ดบนโต๊ะเท่านั้น\n"
                 "ห้ามรันกับตู้จ่ายที่กำลังให้บริการลูกค้า")

    bauds = [args.baud] if args.baud else BAUDS
    framings = ([f for f in FRAMINGS if f[0] == args.framing] if args.framing else FRAMINGS)
    if not framings:
        sys.exit("framing ไม่รู้จัก (เลือกจาก %s)" % ", ".join(f[0] for f in FRAMINGS))

    combos = len(bauds) * len(framings)
    per = args.addr_max * (3 if args.mode == "modbus" else
                           len(GENERIC_TEMPLATES) * len(SAFE_CMDS))
    print("จะยิงทั้งหมดประมาณ %d เฟรม ใช้เวลาราว %.0f นาที\n"
          % (combos * per, combos * per * (args.wait + 0.01) / 60))

    hits = (probe_modbus if args.mode == "modbus" else probe_generic)(
        args.port, bauds, framings, args.addr_max, args.wait)

    print("\n" + "=" * 70)
    if hits:
        print("สรุป: เจอการตอบสนอง %d ครั้ง - เอา baud/framing/addr ที่เจอ" % len(hits))
        print("ไปใช้กับ sniffer.py แล้วทดลองคำสั่งทีละตัวต่อ")
    else:
        print("ไม่เจอการตอบสนองเลย ตรวจตามลำดับนี้:")
        print("  1. สาย A/B สลับกันหรือเปล่า (ลองสลับดู - เป็นสาเหตุอันดับ 1)")
        print("  2. ต่อ GND ร่วมกันหรือยัง")
        print("  3. บอร์ดเปิดโหมดออนไลน์ (联机 / with-computer) ในเมนู setup หรือยัง")
        print("  4. ใส่ terminator 120 ohm ที่ปลายสายหรือยัง")
        print("  5. พอร์ตที่ต่ออยู่เป็น RS-485 จริงไหม (ขา 16 อาจเป็น RS-232/RS-422)")
        print("  6. บอร์ดจ่ายไฟครบไหม (8V main + 12V nozzle)")


if __name__ == "__main__":
    main()
