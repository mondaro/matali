# บัสเงียบ + การต่อเข้า UDOM Next (UDCS)

อัปเดตหลังทราบว่า **True Supply ไม่ให้ข้อมูล** และ **ไม่มี POS ต่ออยู่กับตู้จ่าย**

---

## 1. ข้อเท็จจริงที่เปลี่ยนแผนไปจากเอกสาร 01

ตู้จ่ายเป็น **slave** บน RS-485 — มันจะพูดก็ต่อเมื่อถูกถาม
**ไม่มี POS = ไม่มี master = บัสเงียบสนิท = `sniffer.py` อย่างเดียวจะไม่ได้อะไรเลย**

เอกสาร 01 เขียนบนสมมติฐานว่าอาจมี POS เดิมให้ดักฟัง — ข้อนั้นใช้ไม่ได้แล้ว
เราต้อง **เป็น master เอง** แล้วยิงคำถามเข้าไปหาเสียงตอบ (ไฟล์ `tools/rs485/prober.py`)

ยังมีโอกาสได้ข้อมูลแบบ passive อยู่ 2 จังหวะ — ลองก่อนเพราะฟรีและปลอดภัย:
- **ตอนบอร์ดบูต** บอร์ดจีนหลายรุ่นส่งเฟรม power-on / self-test ออกมาเอง
- **ตอนยกหัวจ่าย** บางรุ่นส่ง unsolicited event

> ต่อ sniffer ค้างไว้ → ปิดเบรกเกอร์ตู้จ่าย → เปิดใหม่ → ยกหัวจ่าย → วาง
> ถ้าได้ไบต์อะไรออกมาแม้แต่ไบต์เดียว = รู้ baud ทันที ประหยัดเวลามหาศาล

---

## 2. เจอผู้ผลิตตัวจริงแล้ว — และไม่ใช่ True Supply

บนบอร์ด `ZC-C V1.4` มี silkscreen ว่า **`COPYRIGHT GENUINE MACHINE`**

**ผู้ผลิต: Zhejiang Genuine Machine Co., Ltd. (แบรนด์ Zcheng / ZC)**
- `ZC-22222` = รุ่นตู้จ่าย 2 มอเตอร์ 2 ปั๊ม 2 มาตรวัด 2 หัวจ่าย (ซีรีส์ Panda)
- `ZC-C` = บอร์ดคอมพิวเตอร์ของตู้ซีรีส์นั้น
- True Supply เป็นแค่ **ผู้นำเข้า/ตัวแทนจำหน่ายในไทย** — ไม่ใช่คนเขียนเฟิร์มแวร์
  เขาไม่ให้ข้อมูลอาจเพราะ **เขาเองก็ไม่มี** ไม่ใช่เพราะหวง

**คำอธิบายสินค้าของผู้ผลิตระบุว่าบอร์ดรองรับโปรโตคอล POS: `Tatsuno`, `Gaskit`, `IFSF`**
(ผมเปิดหน้าเว็บผู้ผลิตตรง ๆ ไม่ได้ — โดน network policy บล็อก จึงยังยืนยัน 100% ไม่ได้
ให้ถือเป็น **เบาะแสที่แข็งแรง** ไม่ใช่ข้อเท็จจริง)

ถ้าจริง นี่คือข่าวดีมาก เพราะ **Tatsuno protocol มีคนทำ implementation ไว้เยอะ**
และ **IFSF เป็นมาตรฐานเปิด** (ต้องเป็นสมาชิกถึงได้ spec เต็ม แต่โครงสร้างมีเอกสารสาธารณะบางส่วน)

### 2.1 สิ่งที่ควรทำ: ติดต่อผู้ผลิตตรง

ช่องทาง: Made-in-China (`chinagenuine`), Alibaba, หรือ 1688 — หา "Zhejiang Genuine Machine" / 正championship
คำค้นภาษาจีนที่ควรใช้:
```
加油机 主板 通讯协议          (โปรโตคอลสื่อสารบอร์ดหลักตู้จ่าย)
加油机 电脑板 RS485 协议 文档
ZC-C 加油机 控制板 联机协议
正星 / 税控 加油机 通讯协议    (โปรโตคอลตู้จ่ายแบบเชื่อมระบบภาษี - ของจีนบังคับ ทุกยี่ห้อต้องมี)
```

**เทคนิคที่ได้ผลกับ OEM จีน:** อย่าถามว่า "ขอ protocol หน่อย"
ให้ทักไปในฐานะ **ผู้จะสั่งซื้อ** แล้วถามว่า
> *"We are integrating your ZC-C mainboard with our own POS system.
> Please send the RS-485 POS communication protocol document and the
> parameter setting manual (pump address, baud rate, online mode).
> We need this before placing the order."*

โอกาสได้เอกสารสูงกว่าถามผ่านตัวแทนในไทยมาก และมัก **ฟรี**

**อีกช่องทาง:** ถามผู้ผลิต forecourt controller จีน (Ecotec, Fanetech, Censtar)
ว่ารองรับบอร์ด Zcheng ZC-C ไหม — ถ้ารองรับ แปลว่าเขามี spec และอาจขาย/แชร์ให้ได้

---

## 3. ซื้อบอร์ดสำรอง 1 ตัว มาทำ bench rig ⭐ คำแนะนำที่สำคัญที่สุดในเอกสารนี้

True Supply **ขายบอร์ดนี้เป็นสินค้า** อยู่แล้ว (ในภาพคือ "ชุดคอม MODEL C" วางเรียงเป็นพาเลท)
ซื้อมา 1 ชุด แล้วประกอบเป็นชุดทดลองบนโต๊ะ

| ทำไมต้องทำ | ผลที่ได้ |
|---|---|
| ไม่ต้องแตะตู้ที่ให้บริการ | ไม่มีความเสี่ยงทำตู้ค้างกลางการขาย |
| ไม่มีซีลชั่งตวงวัด | ยิง frame ผิด ๆ ได้เต็มที่ ไม่ผิดกฎหมาย |
| เข้าเมนู setup ได้อิสระ | หา pump address / online mode / baud ได้โดยไม่กลัวไปแตะ calibration |
| ทดสอบได้ตอนไหนก็ได้ | ไม่ต้องรอปั๊มปิด |

**อุปกรณ์ประกอบ bench rig (นอกจากบอร์ด)**

| อุปกรณ์ | ราคาโดยประมาณ | ใช้ทำอะไร |
|---|---|---|
| แหล่งจ่ายไฟปรับได้ 0–30V (หรือ 8V + 12V คงที่) | 800–1,500 ฿ | เลี้ยงบอร์ด (main 8V + nozzle 12V) |
| สวิตช์โยก 2 ตัว | 40 ฿ | จำลอง nozzle switch A/B |
| Arduino/ESP32 หรือ function generator | 150–500 ฿ | **ป้อนพัลส์เข้า PULSER-1/-2 จำลองน้ำมันไหล** |
| จอ + keyboard ของตู้ (ถ้าซื้อมาด้วย) | — | เข้าเมนู setup ได้ |
| USB↔RS-485 isolated | 400–800 ฿ | (ซื้ออยู่แล้ว) |

รวมประมาณ **บอร์ด + 2,000–3,000 บาท** — ถูกกว่าค่าเสียโอกาสถ้าทำตู้จริงพัง 1 วัน

**เคล็ดลับ:** ป้อนพัลส์เข้า PULSER แล้วดูจอตู้ → จะรู้ทันทีว่า **กี่พัลส์ = 1 ลิตร**
(ปกติ 100 pulse/L quadrature) ข้อมูลนี้จำเป็นตอนทำ cross-check ภายหลัง

---

## 4. งานที่ทำได้ "ตอนนี้เลย" ระหว่างรออุปกรณ์

เรียงตามผลตอบแทนต่อเวลา

### 4.1 ถ่ายรูปคริสตัลบนบอร์ด (5 นาที — ให้ข้อมูลเยอะเกินคาด)
หาคริสตัล (ตัวโลหะสี่เหลี่ยมเงิน ๆ ใกล้ MCU) แล้วอ่านตัวเลขบนตัวมัน

| คริสตัล | แปลว่า |
|---|---|
| **11.0592 MHz** | ออกแบบมาเพื่อ **baud มาตรฐาน** (9600/19200/57600) แม่นยำ 0% error — เดาได้เลยว่าเป็นค่ามาตรฐาน |
| 22.1184 MHz | เหมือนกัน (ทวีคูณของ 11.0592) |
| 12 MHz / 24 MHz | baud มาตรฐานจะมี error ~7% → มักเลือกใช้ 9600 เท่านั้น |

**ถ้าเป็น 11.0592 MHz ตัดพื้นที่ค้นหาลงเหลือ 3 ค่า จาก 8 ค่า**

### 4.2 อ่านเบอร์ MCU และชิป RS-485 (10 นาที)
- **MCU** — `STC15Fxxxx` / `STC8Axxxx` / `STC12Cxxxx`
  → บอกจำนวน UART (STC15W มี 2–4 UART) และยืนยันว่าพอร์ต 16 กับ 17 แยกกันจริง
- **ชิป transceiver ใกล้ terminal เขียว** — `MAX485` / `SP485` / `SN75176` / `MAX3485`
  → **ยืนยัน pinout ได้ทันที**: ขา 6 = A, ขา 7 = B (มาตรฐาน SO-8 ทั้งตระกูล)
  → ถ้าเจอ `MAX232` แทน = พอร์ตนั้นเป็น RS-232 ไม่ใช่ 485
- ถ้ามีชิป **opto-isolator** (`PC817`, `6N137`) คั่นอยู่ = บัสถูกแยกกราวด์แล้ว ปลอดภัยขึ้น

### 4.3 เข้าเมนู setup ของตู้จ่าย (30 นาที) ⚠️ ระวัง
หาค่า 3 อย่าง: **pump address**, **baud rate**, **โหมดออนไลน์ (联机/with computer)**

> ⚠️ **ห้ามแตะรายการที่เกี่ยวกับ calibration / K-factor / 流量系数 เด็ดขาด**
> เมนู setup ของตู้จ่ายมักรวมทั้งพารามิเตอร์ผู้ใช้ (ราคา, address, comm)
> และพารามิเตอร์มาตรวิทยา (calibration) ไว้ด้วยกัน
> **กดเข้าไปดูได้ แต่ห้ามกดยืนยันค่าใด ๆ** และถ่ายรูปทุกหน้าจอไว้
> ถ้าไม่มั่นใจ — **รอบอร์ด bench มาก่อน แล้วค่อยเล่นให้เต็มที่**

### 4.4 นับ inventory หน้างานให้ครบ (1 ชั่วโมง)
จากตาราง `fuel_meter_readings` ใน UDCS สถานีคุณมี **8 หัวจ่าย**:

| กลุ่ม | หัวจ่าย |
|---|---|
| ดีเซล ฝั่งตะวันตก | front / back |
| ดีเซล ฝั่งตะวันออก | front / back |
| แก๊สโซฮอล์ 91 | front / back |
| แก๊สโซฮอล์ 95 | front / back |

ต้องยืนยัน: **8 หัวจ่ายนี้อยู่บนกี่บอร์ด** (บอร์ด ZC 1 ตัว = 2 หัวจ่าย → น่าจะ 4 บอร์ด)
และแต่ละบอร์ดตั้ง address อะไร วาดผังการเดินสาย RS-485 ไว้ล่วงหน้า

### 4.5 พัฒนาซอฟต์แวร์ล่วงหน้าด้วยตู้จ่ายจำลอง (สัปดาห์ที่ 1–3) ⭐
ผมเขียน **`tools/rs485/sim_zc.py`** ไว้แล้ว — ตู้จ่ายจำลองที่พูดโปรโตคอลแบบบอร์ดจีนทั่วไป

```bash
python3 tools/rs485/sim_zc.py --tcp 5000      # ให้ agent ต่อผ่าน TCP
python3 tools/rs485/sim_zc.py --pty           # สร้าง /dev/pts/N เหมือน serial จริง
```
ระหว่างรันพิมพ์คำสั่งจำลองหน้าตู้ได้: `up 1` `down 1` `flow 40` `fault 1` `state`

**ทดสอบแล้วใช้งานได้จริง** — authorize preset 500 บาท → จ่ายที่ 40 ล./นาที →
`down` ปิดรายการ → totalizer เดินตาม → address ผิดหรือ checksum ผิดจะเงียบ (เหมือน RS-485 จริง)

⚠️ **โปรโตคอลใน simulator เป็น "สมมติฐาน" ไม่ใช่ของจริง**
คุณค่าอยู่ที่: เขียน agent, ออกแบบ schema, ต่อเข้า UDOM Next, ทำ UI, เขียนเทสต์
ได้ครบ **ก่อน** อุปกรณ์มาถึง พอถอดโปรโตคอลจริงได้ → **แก้แค่ไฟล์ codec ตัวเดียว** ที่เหลือใช้ได้หมด

---

## 5. ลำดับการถอดโปรโตคอล (เมื่ออุปกรณ์มาถึง)

| ขั้น | ทำอะไร | เครื่องมือ | เวลา |
|---|---|---|---|
| **P0** | ต่อ sniffer แล้ว power-cycle บอร์ด + ยกหัวจ่าย | `sniffer.py` | 30 นาที |
| **P1** | สแกน Modbus RTU (ปลอดภัย ส่งเฉพาะคำสั่งอ่าน) | `prober.py --mode modbus` | 1–2 ชม. |
| **P2** | สแกน generic 7 รูปแบบเฟรม × 8 คำสั่ง × address | `prober.py --mode generic --bench` | 4–8 ชม. |
| **P3** | ได้เสียงตอบแล้ว → ทำสคริปต์ทดสอบ + วิเคราะห์ | `sniffer.py` + `analyze.py` | 2–5 วัน |
| **P4** | เขียน codec จริง แทนที่ตัวสมมติใน simulator | — | 3–5 วัน |

`prober.py` จับ **"ไบต์อะไรก็ได้ที่วิ่งกลับมา"** ไม่ใช่แค่เฟรมที่ถูกต้อง —
เพราะถ้า baud ใกล้เคียงแต่ไม่ตรง เราจะได้ขยะกลับมา และ **ขยะก็คือเบาะแส**

ถ้า P0–P2 ไม่เจออะไรเลย เช็คตามลำดับ (prober พิมพ์ให้ตอนจบ):
1. **สาย A/B สลับกัน** ← สาเหตุอันดับ 1 ลองสลับดูก่อนเสมอ
2. ต่อ GND ร่วมหรือยัง
3. เปิดโหมดออนไลน์ในเมนู setup หรือยัง ← สาเหตุอันดับ 2
4. terminator 120Ω
5. พอร์ตที่ต่อเป็น RS-485 จริงไหม (ขา 16 อาจเป็น RS-232/RS-422)
6. ไฟเลี้ยงครบไหม (8V main + 12V nozzle)

---

## 6. การต่อเข้า UDOM Next (UDCS) — ออกแบบตามของที่มีอยู่แล้ว

ผมอ่านรีโป `mondaro/UDCS` แล้ว **ระบบคุณมี domain น้ำมันอยู่แล้ว และมี pattern ที่ตรงกับงานนี้เป๊ะ**

### 6.1 ของเดิมที่ใช้ต่อได้ทันที

| ของเดิมใน UDCS | ใช้กับงานนี้ยังไง |
|---|---|
| **`tools/print-agent/`** (Node + `@supabase/supabase-js` + systemd) | **แม่แบบของ pump agent** — โครงเดียวกันเป๊ะ: login เป็น role `AGENT` → `heartbeat` RPC → `claim jobs` RPC → ทำงาน → `finish` RPC |
| `fuel_meter_readings` | ปลายทางของยอดมิเตอร์ที่อ่านอัตโนมัติ |
| `fuel_tank_readings` (dip_cm, water_cm, actual_liters) | ปลายทางของ ATG ในเฟสถัดไป |
| `tank_calibration_points` (ABS/DELTA, dip_cm→liters) | **นี่คือ strapping table ที่ผมพูดถึงในเอกสาร 00 — คุณมีแล้ว** |
| `js/offline_outbox.js` | pattern คิวออฟไลน์ที่มีอยู่ ใช้แนวคิดเดียวกันใน agent |
| `client_ref text UNIQUE` | **idiom idempotency ที่คุณใช้อยู่แล้ว** — ใช้ต่อกับ transaction จากหัวจ่าย |
| `shift_closings` | ผูก transaction เข้ากับกะ |

### 6.2 ปัญหาที่ต้องแก้ก่อน: `fuel_meter_readings` เป็นตารางแบบกว้าง

```sql
diesel_west_front_small / _digital / _digital_money
diesel_west_back_small  / _digital / _digital_money
... รวม 8 หัวจ่าย x 3 คอลัมน์ = 24 คอลัมน์, 1 แถว/วัน, กรอกมือ
```

ตารางแบบนี้ **ใช้กับข้อมูลอัตโนมัติไม่ได้** เพราะ:
- agent จะอ่านทุก 5 นาที ไม่ใช่วันละครั้ง
- เพิ่ม/ย้ายหัวจ่ายต้อง ALTER TABLE
- ผูก transaction รายรายการเข้ากับหัวจ่ายไม่ได้

**แต่ห้ามทิ้งของเดิม** — รายงานและ RPC ที่มีอยู่พึ่งมันอยู่

**วิธีย้ายแบบไม่พัง:** เพิ่มตารางใหม่แบบ normalize + ทำ **view ที่ pivot กลับเป็นรูปเดิม**
รายงานเก่าทำงานต่อได้โดยไม่ต้องแก้ แล้วค่อย ๆ ย้ายทีละหน้า

### 6.3 Schema ที่เสนอ (ข้อเสนอสำหรับรีโป UDCS — ยังไม่ได้เขียนลงไป)

```sql
-- ทะเบียนหัวจ่าย: ผูกโลกจริง (บอร์ด/address/หัว) เข้ากับชื่อคอลัมน์เดิม
CREATE TABLE IF NOT EXISTS fuel_nozzles (
  id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  code          text NOT NULL UNIQUE,        -- 'diesel_west_front'  (= prefix คอลัมน์เดิม)
  label         text NOT NULL,               -- 'ดีเซล ฝั่งตะวันตก หน้า'
  fuel_type     text NOT NULL,
  board_addr    smallint NOT NULL,           -- address ของบอร์ด ZC บนบัส RS-485
  nozzle_no     smallint NOT NULL,           -- 1 = ฝั่ง A, 2 = ฝั่ง B
  pulses_per_litre integer DEFAULT 100,
  active        boolean NOT NULL DEFAULT true,
  UNIQUE (board_addr, nozzle_no)
);

-- ยอดสะสมที่ agent อ่านมา (ความจริงสูงสุดสำหรับการกระทบยอด)
CREATE TABLE IF NOT EXISTS fuel_totalizer_snapshots (
  id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  nozzle_id   bigint NOT NULL REFERENCES fuel_nozzles(id),
  taken_at    timestamptz NOT NULL DEFAULT now(),
  vol_total   numeric NOT NULL,              -- ลิตรสะสมจากมิเตอร์อิเล็กทรอนิกส์
  amt_total   numeric,                       -- บาทสะสม
  source      text NOT NULL DEFAULT 'AGENT'  -- AGENT / MANUAL
    CHECK (source IN ('AGENT','MANUAL')),
  agent_id    text,
  client_ref  text UNIQUE                    -- ใช้ idiom เดิมของระบบกัน insert ซ้ำ
);
CREATE INDEX IF NOT EXISTS idx_tot_snap_nozzle_time
  ON fuel_totalizer_snapshots (nozzle_id, taken_at DESC);

-- รายการขายรายครั้งจากหัวจ่าย
CREATE TABLE IF NOT EXISTS fuel_pump_transactions (
  id           bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  client_ref   text UNIQUE NOT NULL,         -- กันซ้ำ: hash(addr|nozzle|วันที่|seq|tot_end)
  nozzle_id    bigint NOT NULL REFERENCES fuel_nozzles(id),
  pump_seq     integer,                      -- เลขรายการของบอร์ด (วนกลับได้ จึงต้องรวมวันที่ใน client_ref)
  started_at   timestamptz,
  ended_at     timestamptz NOT NULL,
  liters       numeric NOT NULL,
  unit_price   numeric NOT NULL,
  amount       numeric NOT NULL,
  tot_start    numeric,                      -- totalizer ก่อน/หลัง = ตัวตรวจสอบว่ารายการไม่หาย
  tot_end      numeric,
  shift_id     bigint,
  sales_order_id bigint,                     -- ผูกกับบิลขายเมื่อเก็บเงินแล้ว (NULL = ยังไม่ผูก)
  status       text NOT NULL DEFAULT 'COMPLETED'
    CHECK (status IN ('COMPLETED','VOID','UNPAID')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- คิวคำสั่งไปหาตู้จ่าย (โครงเดียวกับ print_jobs)
CREATE TABLE IF NOT EXISTS pump_commands (
  id           bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  nozzle_id    bigint NOT NULL REFERENCES fuel_nozzles(id),
  kind         text NOT NULL
    CHECK (kind IN ('AUTHORIZE_AMOUNT','AUTHORIZE_VOLUME','AUTHORIZE_FREE','STOP','SET_PRICE')),
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','CLAIMED','DONE','ERROR','EXPIRED')),
  requested_by text,
  claimed_by   text,
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '60 seconds',
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

**view ที่ทำให้รายงานเดิมยังทำงานได้** (แนวคิด — pivot snapshot ปลายวันกลับเป็นรูปกว้าง):

```sql
CREATE OR REPLACE VIEW fuel_meter_readings_auto AS
WITH eod AS (
  SELECT DISTINCT ON (n.code, (s.taken_at AT TIME ZONE 'Asia/Bangkok')::date)
         n.code,
         (s.taken_at AT TIME ZONE 'Asia/Bangkok')::date AS reading_date,
         s.vol_total, s.amt_total
  FROM fuel_totalizer_snapshots s
  JOIN fuel_nozzles n ON n.id = s.nozzle_id
  ORDER BY n.code, 2, s.taken_at DESC          -- แถวสุดท้ายของแต่ละวัน
)
SELECT reading_date,
       MAX(vol_total) FILTER (WHERE code='diesel_west_front') AS diesel_west_front_digital,
       MAX(amt_total) FILTER (WHERE code='diesel_west_front') AS diesel_west_front_digital_money,
       MAX(vol_total) FILTER (WHERE code='diesel_west_back')  AS diesel_west_back_digital,
       MAX(amt_total) FILTER (WHERE code='diesel_west_back')  AS diesel_west_back_digital_money
       -- ... ครบทั้ง 8 หัวจ่าย
FROM eod GROUP BY reading_date;
```

> คอลัมน์ `*_small` (มิเตอร์เล็ก/มิเตอร์กลไก) **อ่านผ่าน RS-485 ไม่ได้** เพราะเป็นตัวนับกลไก
> ยังต้องกรอกมือต่อไป หรือดักพัลส์จากขา `TOTALIZER-1/-2` ในเฟสหลัง
> — และมันมีประโยชน์: **เป็นตัวตรวจสอบไขว้กับมิเตอร์ดิจิทัล** เก็บไว้ดีแล้ว

### 6.4 สถาปัตยกรรม pump agent (คัดลอกจาก print-agent)

```
tools/pump-agent/                    ← ในรีโป UDCS ข้าง ๆ print-agent
├── agent.js              main loop: heartbeat / อ่าน totalizer / ดึงคำสั่ง / ส่งผล
├── codec/
│   ├── index.js          เลือก codec ตาม config
│   ├── zc.js             ⚠️ codec จริง (เขียนหลังถอดโปรโตคอลได้)
│   └── sim.js            codec ของ simulator (ใช้พัฒนาไปก่อน)
├── transport/
│   ├── serial.js         RS-485 ของจริง
│   └── tcp.js            ต่อ sim_zc.py --tcp ตอน dev
├── store.js              SQLite local-first + คิวส่งขึ้น Supabase
├── config.example.json
├── udom-pump-agent.service
└── README.md
```

`config.json` (ล้อแบบ print-agent):
```jsonc
{
  "supabase_url": "https://<project>.supabase.co",
  "supabase_anon_key": "<anon key>",
  "email": "pump-agent@udom.local",
  "password": "<รหัสผ่านบัญชี role AGENT>",
  "agent_id": "pi-forecourt",
  "transport": { "kind": "serial", "port": "/dev/ttyUSB0", "baud": 9600, "framing": "8N1" },
  "codec": "zc",
  "totalizer_poll_seconds": 300,
  "status_poll_ms": 500,
  "command_poll_ms": 1000,
  "heartbeat_seconds": 30,
  "nozzles": [
    { "code": "diesel_west_front", "board_addr": 1, "nozzle_no": 1 },
    { "code": "diesel_west_back",  "board_addr": 1, "nozzle_no": 2 },
    { "code": "diesel_east_front", "board_addr": 2, "nozzle_no": 1 },
    { "code": "diesel_east_back",  "board_addr": 2, "nozzle_no": 2 },
    { "code": "gas91_front",       "board_addr": 3, "nozzle_no": 1 },
    { "code": "gas91_back",        "board_addr": 3, "nozzle_no": 2 },
    { "code": "gas95_front",       "board_addr": 4, "nozzle_no": 1 },
    { "code": "gas95_back",        "board_addr": 4, "nozzle_no": 2 }
  ]
}
```

RPC ที่ต้องเพิ่มใน Supabase (ล้อชื่อจาก print-agent):
| RPC | เทียบกับของเดิม |
|---|---|
| `pump_agent_heartbeat(p_agent_id, p_agent_name, p_nozzles)` | `print_agent_heartbeat` |
| `claim_pump_commands(p_agent_id)` | `claim_print_jobs` |
| `finish_pump_command(p_command_id, p_status, p_error)` | `finish_print_job` |
| `push_totalizer_snapshots(p_rows jsonb)` | (ใหม่ — insert แบบ upsert บน `client_ref`) |
| `push_pump_transactions(p_rows jsonb)` | (ใหม่ — upsert บน `client_ref`) |

### 6.5 กฎเหล็ก 5 ข้อของ agent

1. **Local-first** — เขียน SQLite ก่อน แล้วค่อยส่งขึ้น Supabase (ปั๊มเน็ตหลุดบ่อย)
2. **`client_ref` ทุกแถว** — ใช้ idiom เดิมของระบบ ส่งซ้ำกี่ครั้งก็ไม่เกิดข้อมูลซ้ำ
3. **totalizer คือความจริงสูงสุด** — ยอดขายที่ใช้กระทบยอด = `tot_end − tot_start`
   ไม่ใช่ผลรวม transaction (transaction หายได้ totalizer ไม่หาย)
   ถ้า `SUM(transaction.liters) ≠ Δtotalizer` → **แจ้งเตือน** ว่ามีรายการหาย
4. **บัสเดียว master เดียว** — RS-485 เป็น half-duplex ห้ามมี 2 process ยิงพร้อมกัน
   ทำ command queue ภายใน agent คิวเดียว
5. **คำสั่งมี expiry** — `pump_commands.expires_at` 60 วินาที
   ถ้า authorize แล้วไม่ยกหัวจ่าย ต้อง auto-cancel ไม่ให้ค้าง

---

## 7. Roadmap ที่ปรับใหม่

| สัปดาห์ | ไม่ต้องใช้อุปกรณ์ | ต้องใช้อุปกรณ์ |
|---|---|---|
| 1 | ทักผู้ผลิตจีนขอ protocol · ถ่ายรูปคริสตัล/MCU/transceiver · สั่งซื้อบอร์ดสำรอง | — |
| 1–2 | เขียน SQL migration + RPC ใน UDCS · เขียนโครง `pump-agent` ต่อกับ `sim_zc.py` | — |
| 2–3 | ทำ UI ในแอป (แผงหัวจ่าย real-time, สั่งจ่าย, ยอดมิเตอร์อัตโนมัติ) ทดสอบกับ simulator | — |
| 3–4 | — | ประกอบ bench rig · P0–P2 หาเสียงตอบ |
| 4–6 | — | P3–P4 ถอดโปรโตคอล เขียน `codec/zc.js` |
| 6–7 | — | ต่อตู้จริง 1 ตู้ read-only · เทียบยอดกับที่กรอกมือ 1 สัปดาห์ |
| 7–9 | — | ขยายครบ 8 หัวจ่าย · เลิกกรอกมือ · เปิดฟีเจอร์สั่งจ่าย |

**ประเด็นสำคัญ:** งานสัปดาห์ 1–3 ทำได้ทั้งหมดโดยไม่ต้องรออุปกรณ์
ถ้าทำตามนี้ พออุปกรณ์มาถึงเหลืองานแค่ **ถอดโปรโตคอล** อย่างเดียว ไม่ต้องมาเริ่มเขียนระบบ

---

## 8. เครื่องมือในรีโปตอนนี้

| ไฟล์ | หน้าที่ | สถานะ |
|---|---|---|
| `tools/rs485/sniffer.py` | ดักฟัง listen-only + สแกน baud + ฝัง marker | ใช้ได้ |
| `tools/rs485/analyze.py` | ถอดโครงสร้างเฟรม, เดา checksum 7 แบบ, หา field BCD/binary | ทดสอบแล้ว |
| `tools/rs485/prober.py` | **ยิงหาเสียงตอบบนบัสเงียบ** (Modbus scan + generic 7 รูปแบบ) | ใช้ได้ |
| `tools/rs485/sim_zc.py` | **ตู้จ่ายจำลอง** สำหรับพัฒนาก่อนได้ของจริง (TCP/PTY) | ทดสอบแล้ว |

---

## 9. คำถามที่ยังค้าง

1. 8 หัวจ่ายอยู่บนกี่บอร์ด และเป็นบอร์ด `ZC-C V1.4` ทั้งหมดหรือปนกับ `ZC-22222` รุ่นเก่า
2. คริสตัลบนบอร์ดเป็นกี่ MHz (ข้อ 4.1)
3. ชิปข้าง terminal เขียวเบอร์อะไร (ข้อ 4.2)
4. จะให้ pump agent รันบนเครื่องเดียวกับ print-agent (Raspberry Pi ตัวเดิม) หรือแยกเครื่อง
   — แนะนำ **แยกเครื่อง** เพราะ agent น้ำมันต้องรันตลอด 24 ชม. และ Chromium ของ print-agent กินแรม
5. เฟส "สั่งจ่าย" จะใช้ทำอะไรกันแน่ (เติมล่วงหน้า / บัตรฟลีท / ล็อกหัวจ่ายจนกว่าจะจ่ายเงิน)
   — ตอบข้อนี้จะกำหนดว่า `pump_commands` ต้องมี kind อะไรบ้าง
