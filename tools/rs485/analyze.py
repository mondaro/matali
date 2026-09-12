#!/usr/bin/env python3
"""
วิเคราะห์ไฟล์ที่ได้จาก sniffer.py เพื่อหาโครงสร้างเฟรมของโปรโตคอลหัวจ่าย

ทำ 5 อย่าง:
  1. จัดกลุ่มเฟรมตามความยาว + ไบต์แรก  -> หา "ชนิดข้อความ"
  2. หาไบต์ที่คงที่ vs ไบต์ที่เปลี่ยน  -> แยก header/address/command ออกจาก payload
  3. เดา checksum: sum8, xor8, sum16, CRC16-Modbus, CRC16-CCITT, CRC8
  4. หาเลข BCD ในเฟรม แล้วเทียบกับค่าที่เรารู้ (ลิตร/บาท/ราคา) จาก --expect
  5. แสดง timeline รอบ ๆ marker เพื่อดูว่าเหตุการณ์ไหนทำให้เฟรมเปลี่ยน

การใช้งาน:
  python3 analyze.py capture.jsonl
  python3 analyze.py capture.jsonl --expect 1.00 --expect 38.44 --expect 38.44
  python3 analyze.py capture.jsonl --timeline
"""

import argparse
import collections
import json
import sys


# --------------------------------------------------------------- checksums

def crc16_modbus(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def crc16_ccitt(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def crc8(data, poly=0x07):
    crc = 0
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ poly) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def checksum_candidates(frame):
    """คืน list ของ (ชื่อ, ช่วงข้อมูลที่คลุม, ตำแหน่งไบต์ตรวจสอบ) ที่ผ่านทั้งหมด"""
    n = len(frame)
    hits = []
    # ลองทุกการรวมกัน: เริ่มที่ start, จบก่อนตำแหน่ง checksum, checksum อยู่ท้าย
    for start in range(0, min(3, n)):
        for tail in range(0, min(3, n - start - 1)):   # จำนวนไบต์หลัง checksum
            # checksum 1 ไบต์
            pos = n - 1 - tail
            if pos <= start:
                continue
            body = frame[start:pos]
            got = frame[pos]
            if (sum(body) & 0xFF) == got:
                hits.append(("sum8", start, pos, tail))
            if ((-sum(body)) & 0xFF) == got:
                hits.append(("sum8-neg", start, pos, tail))
            x = 0
            for b in body:
                x ^= b
            if x == got:
                hits.append(("xor8", start, pos, tail))
            if crc8(body) == got:
                hits.append(("crc8", start, pos, tail))
            # checksum 2 ไบต์
            pos2 = n - 2 - tail
            if pos2 > start:
                body2 = frame[start:pos2]
                le = frame[pos2] | (frame[pos2 + 1] << 8)
                be = (frame[pos2] << 8) | frame[pos2 + 1]
                if crc16_modbus(body2) == le:
                    hits.append(("crc16-modbus(LE)", start, pos2, tail))
                if crc16_ccitt(body2) == be:
                    hits.append(("crc16-ccitt(BE)", start, pos2, tail))
                if (sum(body2) & 0xFFFF) == le:
                    hits.append(("sum16(LE)", start, pos2, tail))
                if (sum(body2) & 0xFFFF) == be:
                    hits.append(("sum16(BE)", start, pos2, tail))
    return hits


# --------------------------------------------------------------------- BCD

def is_bcd(b):
    return (b >> 4) <= 9 and (b & 0x0F) <= 9


def bcd_runs(frame, min_len=2):
    """หาช่วงไบต์ที่เป็น BCD ติดกัน คืน (offset, length, ค่าเป็น int)"""
    out = []
    i = 0
    n = len(frame)
    while i < n:
        if is_bcd(frame[i]):
            j = i
            while j < n and is_bcd(frame[j]):
                j += 1
            if j - i >= min_len:
                for start in range(i, j - min_len + 1):
                    for end in range(start + min_len, j + 1):
                        digits = "".join("%02X" % b for b in frame[start:end])
                        out.append((start, end - start, int(digits)))
            i = j
        else:
            i += 1
    return out


def find_expected(frames, expected, scale_options=(1, 10, 100, 1000)):
    """หาว่าค่าที่เรารู้ (เช่น 1.00 ลิตร) โผล่ที่ offset ไหนของเฟรมไหนบ้าง"""
    found = collections.Counter()
    for frame in frames:
        for off, length, value in bcd_runs(frame):
            for scale in scale_options:
                if abs(value - expected * scale) < 1e-6:
                    found[(off, length, scale, "BCD")] += 1
        # ลองแบบ binary ด้วย (LE/BE 2-4 ไบต์)
        for length in (2, 3, 4):
            for off in range(0, len(frame) - length + 1):
                chunk = frame[off:off + length]
                for order in ("little", "big"):
                    value = int.from_bytes(chunk, order)
                    for scale in scale_options:
                        if value and abs(value - expected * scale) < 1e-6:
                            found[(off, length, scale, "bin-" + order)] += 1
    return found


# ------------------------------------------------------------------- main

def load(path):
    frames, markers = [], []
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if rec.get("kind") == "frame":
                frames.append((rec["t"], bytes.fromhex(rec["hex"].replace(" ", ""))))
            elif rec.get("kind") == "marker":
                markers.append((rec["t"], rec["text"]))
    return frames, markers


def report_groups(frames):
    groups = collections.defaultdict(list)
    for _, f in frames:
        key = (len(f), f[0] if f else None)
        groups[key].append(f)

    print("=" * 78)
    print("ชนิดข้อความที่พบ (จัดกลุ่มตาม ความยาว + ไบต์แรก)")
    print("=" * 78)
    for (length, first), items in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        print("\n--- len=%d  first=0x%02X  จำนวน %d เฟรม"
              % (length, first if first is not None else 0, len(items)))

        # ไบต์ไหนคงที่ ไบต์ไหนเปลี่ยน
        pattern = []
        for i in range(length):
            values = {f[i] for f in items}
            pattern.append("%02X" % items[0][i] if len(values) == 1 else "??")
        print("    รูปแบบ : %s" % " ".join(pattern))
        varying = [i for i in range(length) if len({f[i] for f in items}) > 1]
        print("    ไบต์ที่เปลี่ยน (index): %s" % (varying or "ไม่มี"))

        # checksum ที่ผ่านทุกเฟรมในกลุ่ม
        common = None
        for f in items[:200]:
            hits = set(checksum_candidates(f))
            common = hits if common is None else (common & hits)
            if not common:
                break
        if common:
            print("    ✅ checksum ที่ผ่านทุกเฟรม:")
            for name, start, pos, tail in sorted(common):
                print("       %-18s คลุมไบต์ [%d:%d] , วางที่ index %d , มีอีก %d ไบต์ต่อท้าย"
                      % (name, start, pos, pos, tail))
        else:
            print("    ⚠️  ไม่เจอ checksum แบบมาตรฐาน "
                  "(อาจเป็น checksum แบบ nibble/BCD หรือเฟรมถูกตัดผิด - ลองปรับ --gap-chars)")

        for f in items[:3]:
            print("    ตัวอย่าง: %s" % " ".join("%02X" % b for b in f))


def report_timeline(frames, markers, window=2.0):
    print("\n" + "=" * 78)
    print("TIMELINE รอบ ๆ marker")
    print("=" * 78)
    for t, text in markers:
        print("\n>>> [%9.3f] %s" % (t, text))
        for ft, f in frames:
            if t - 0.3 <= ft <= t + window:
                print("    [%9.3f] %s" % (ft, " ".join("%02X" % b for b in f)))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("capture", help="ไฟล์ .jsonl จาก sniffer.py")
    ap.add_argument("--expect", type=float, action="append", default=[],
                    help="ค่าที่รู้ว่าต้องมีในเฟรม เช่น --expect 1.00 --expect 38.44 (ใส่ได้หลายค่า)")
    ap.add_argument("--timeline", action="store_true", help="แสดงเฟรมรอบ ๆ marker")
    args = ap.parse_args()

    frames, markers = load(args.capture)
    if not frames:
        sys.exit("ไม่มีเฟรมในไฟล์")
    print("โหลด %d เฟรม, %d marker\n" % (len(frames), len(markers)))

    report_groups(frames)

    if args.expect:
        print("\n" + "=" * 78)
        print("ค้นหาค่าที่คาดหวังในเฟรม")
        print("=" * 78)
        raw = [f for _, f in frames]
        for want in args.expect:
            hits = find_expected(raw, want)
            print("\n--- ค่า %g" % want)
            if not hits:
                print("    ไม่พบ (ลองตรวจว่าค่าถูกเก็บเป็น ASCII หรือมี offset/สเกลอื่น)")
            for (off, length, scale, enc), count in hits.most_common(8):
                print("    offset=%2d  len=%d  scale=x%-4d  %-12s  พบ %d ครั้ง"
                      % (off, length, scale, enc, count))

    if args.timeline:
        report_timeline(frames, markers)


if __name__ == "__main__":
    main()
