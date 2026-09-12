# ATG + Forecourt Controller แบบ DIY สำหรับสถานีบริการน้ำมัน

เอกสารออกแบบระบบ: วัดระดับน้ำมันในถังใต้ดิน (ATG) + ติดต่อหัวจ่าย (รับยอดขาย / สั่งจ่าย)
เน้นอุปกรณ์ราคาถูก หาซื้อได้ ได้มาตรฐานสากล และต่อยอดเข้าระบบเดิม (UDOM Next) ได้ง่าย

---

## 0. สรุปสำหรับผู้บริหาร (TL;DR)

| ส่วน | ทำเองได้ไหม | แนวทางที่แนะนำ |
|---|---|---|
| Probe ในถัง | ❌ ห้ามทำเอง (Zone 0) | ซื้อ magnetostrictive probe สำเร็จรูปที่มี ATEX/IECEx + Modbus RTU |
| Safety barrier | ❌ ห้ามทำเอง | ซื้อ IS barrier (Zener/galvanic) มาตรฐาน IEC 60079-11 |
| มาตรวัดหัวจ่าย | ❌ ห้ามแตะ (ผิดกฎหมาย) | อ่านอย่างเดียวผ่านโปรโตคอลของหัวจ่าย |
| Forecourt controller | ⚠️ ทำเองได้แต่ไม่คุ้ม | ใช้ PTS-2 (รองรับ >150 ยี่ห้อหัวจ่าย + >50 แบบ ATG, JSON API) |
| Edge gateway + Software | ✅ **ตรงนี้คือส่วนที่เราทำเอง** | Linux box + service ของเราเอง → UDOM Next |

**หลักคิด:** อย่า DIY ส่วนที่เป็น *ความปลอดภัย* และ *กฎหมายมาตราชั่งตวงวัด*
ให้ DIY ส่วนที่เป็น *ซอฟต์แวร์ การรวมข้อมูล และ business logic* ซึ่งเป็นส่วนที่แบรนด์ขายแพงที่สุด

ต้นทุนประมาณ **90,000–150,000 บาท/สถานี** (4 ถัง / 4 ตู้จ่าย / 8 หัวจ่าย)
เทียบกับระบบแบรนด์ (Veeder-Root TLS-450 + Doms) ที่ 400,000–800,000 บาท

---

## 1. ข้อจำกัดที่ต้องยอมรับก่อน (สำคัญมาก)

### 1.1 พื้นที่อันตราย (Hazardous Area)
- **ภายในถังใต้ดิน = Zone 0** อุปกรณ์ทุกชิ้นต้องเป็น `Ex ia IIA T3/T4` และต่อผ่าน **IS barrier** เท่านั้น
- **ห้องปั๊มในตู้จ่าย = Zone 1**, รอบตู้จ่ายรัศมี 4.5 ม. = Zone 2
- ห้ามเอา ESP32 / Arduino / sensor ทั่วไปลงถังเด็ดขาด — ไม่ใช่เรื่องมาตรฐาน แต่เป็นเรื่องระเบิด
- Edge PC / controller ต้องอยู่ในอาคารสำนักงาน (safe area)
- อ้างอิง: `IEC 60079-0`, `IEC 60079-11`, `IEC 60079-14`, NFPA 30/30A

### 1.2 กฎหมายมาตราชั่งตวงวัด (ไทย)
- มาตรวัดของหัวจ่ายผ่านการตรวจสอบและ **ผนึกซีล** โดยสำนักชั่งตวงวัด กรมการค้าภายใน
- แก้ไข/ดัดแปลง/ถอดซีล = **จำคุกไม่เกิน 7 ปี ปรับไม่เกิน 280,000 บาท**
- เกณฑ์ความคลาดเคลื่อนที่ยอมรับ: ±50 ml ต่อการจ่าย 5 ลิตร (±1%)
- ⇒ ระบบเราต้อง **read-only** ต่อมาตรวัด: อ่านค่าจากบอร์ดอิเล็กทรอนิกส์ของหัวจ่ายผ่านโปรโตคอล
  ไม่ใช่ไปแทนที่ pulser หรือปรับ calibration
- การสั่งจ่าย (authorize / preset) ทำได้ เพราะเป็นการสั่งผ่านโปรโตคอลมาตรฐานของหัวจ่ายเอง
  ตัวมาตรวัดยังทำงานและนับตามเดิม

### 1.3 กฎหมายอื่นที่เกี่ยวข้อง
- กฎกระทรวง สถานีบริการน้ำมันเชื้อเพลิง (กรมธุรกิจพลังงาน)
- ถ้าจะอ้างว่าเป็น "ระบบตรวจจับการรั่วไหล" ตามข้อกำหนด ต้องใช้ probe + อัลกอริทึมที่ผ่านการรับรอง
  (EPA third-party certified / SIR) — ระบบ DIY ใช้เป็น **ระบบเฝ้าระวังภายใน** ได้ แต่ยังไม่ใช่ compliance

---

## 2. สถาปัตยกรรมภาพรวม

```
 ┌─────────── HAZARDOUS AREA ────────────┐   ┌────────── SAFE AREA (ห้องออฟฟิศ) ──────────┐
 │                                        │   │                                            │
 │  Tank 1 ┬ MS Probe (Ex ia, Modbus) ───┼──▶│ IS Barrier ─┐                              │
 │  Tank 2 ┼ MS Probe ──────────────────┼──▶│ IS Barrier ─┼─ RS-485 (ATG bus) ─┐         │
 │  Tank 3 ┼ MS Probe ──────────────────┼──▶│ IS Barrier ─┤                    │         │
 │  Tank 4 ┴ MS Probe ──────────────────┼──▶│ IS Barrier ─┘                    │         │
 │                                        │   │                                  ▼         │
 │  Dispenser 1..N                        │   │                          ┌──────────────┐  │
 │   └ บอร์ดอิเล็กทรอนิกส์ของตู้จ่าย ─────┼──▶│ ── 2-wire / RS-485 ─────▶│  PTS-2       │  │
 │     (Tatsuno / Gilbarco / Wayne /      │   │    (dispenser bus)       │  Controller  │  │
 │      Tokheim / Censtar)                │   │                          └──────┬───────┘  │
 └────────────────────────────────────────┘   │                                 │ Ethernet │
                                               │                        JSON/HTTP+WebSocket│
                                               │                                 ▼          │
                                               │      ┌────────────────────────────────┐   │
                                               │      │  EDGE GATEWAY (Linux)          │   │
                                               │      │  - pts-poller (service ของเรา) │   │
                                               │      │  - SQLite/Postgres local        │   │
                                               │      │  - store & forward queue        │   │
                                               │      │  - reconciliation engine        │   │
                                               │      │  - local web UI                 │   │
                                               │      └───────────────┬────────────────┘   │
                                               └──────────────────────┼────────────────────┘
                                                                       │ REST / MQTT / Webhook
                                                                       ▼
                                                              ┌─────────────────┐
                                                              │   UDOM Next     │
                                                              │   (ระบบเดิม)     │
                                                              └─────────────────┘
```

---

## 3. ส่วนที่ 1: ATG (วัดระดับน้ำมันในถัง)

### 3.1 เลือกเทคโนโลยี probe

| แบบ | ความแม่นยำ | วัดน้ำก้นถังได้ | ราคา/ตัว | สรุป |
|---|---|---|---|---|
| **Magnetostrictive** | ±0.2–0.5 mm | ✅ (ลูกลอย 2 ตัว) | 8,000–25,000 ฿ | ✅ **เลือกอันนี้** — มาตรฐานอุตสาหกรรม |
| Radar / Guided wave | ±1 mm | ⚠️ ยาก | 30,000+ ฿ | แพงเกิน ไม่จำเป็น |
| Hydrostatic pressure | ±0.5% FS | ❌ | 3,000 ฿ | ถูกแต่ **ใช้ไม่ได้** — drift ตามความหนาแน่น แยกชั้นน้ำไม่ได้ |
| Ultrasonic (non-contact) | ±3 mm | ❌ | 5,000 ฿ | ไอน้ำมันรบกวน ไม่เหมาะกับ UST |
| ไม้วัด (dip stick) | ±3 mm | ✅ | 500 ฿ | ต้องมีไว้ **สอบเทียบ** เสมอ |

**สเปกที่ต้องระบุตอนสั่งซื้อ:**
```
- Type: Magnetostrictive, 2 floats (product + water)
- Output: RS-485, Modbus RTU  (สำคัญ! อย่าเอารุ่นที่ล็อกโปรโตคอลเฉพาะยี่ห้อ)
- Certification: ATEX / IECEx  Ex ia IIA T4 Ga  (หรืออย่างน้อย CNEx + SIL2)
- Temperature: multi-point RTD 5 จุด (ไม่ใช่จุดเดียว) สำหรับ VCF
- Resolution: ≤ 0.1 mm, Accuracy ≤ ±0.5 mm
- Length: ตามความสูงถัง + 100 mm
- Ingress: IP68, ทนน้ำมันเบนซิน/E20/E85/B7
```

**ผู้ขายที่หาได้จริง (สั่ง Alibaba / Made-in-China / ตัวแทนในไทย):**
- Zhengzhou Windbell — รุ่น `WB-P300P` มี ATEX/IECEx/SIL
- SYW-A series (float type Modbus RS485) — ราคาถูกสุด ~8,000–12,000 ฿
- GAMICOS — สเปกดี เอกสารครบ
- ของแบรนด์: Veeder-Root Mag Probe, Franklin Fueling INCON TSP — แพงกว่า 3–4 เท่า แต่ถ้าจะเคลม compliance ต้องใช้

> ⚠️ ต้องขอ **ใบ certificate ตัวจริง (ATEX/IECEx certificate number)** และตรวจสอบเลขที่กับฐานข้อมูล IECEx ก่อนซื้อ ผู้ขายจีนบางรายอ้างลอย ๆ

### 3.2 Intrinsic Safety Barrier (ห้ามข้าม)
- ติดตั้งในตู้ควบคุมฝั่ง safe area บน DIN rail
- ตัวเลือก: MTL7700 series (Zener), Pepperl+Fuchs KFD2 (galvanic isolator), หรือ Chinese equivalent ที่มี ATEX
- ต้อง **galvanic isolator สำหรับ RS-485** (ไม่ใช่ Zener ธรรมดา) ถ้า probe เป็น RS-485
- ราคา 1,500–4,000 ฿/ช่อง
- ต้องคำนวณ **entity parameters**: `Uo ≤ Ui`, `Io ≤ Ii`, `Po ≤ Pi`, `Co ≥ Ci + Ccable`, `Lo ≥ Li + Lcable`
  → เก็บเป็นเอกสาร IS loop calculation ไว้แสดงตอนตรวจ

### 3.3 การเดินสาย
- สายชีลด์คู่บิดเกลียว (STP) ทนน้ำมัน เดินในท่อร้อยสายแยกจากสายไฟกำลัง
- Cable gland แบบ Ex ที่ manhole
- Junction box แบบ Ex e ที่หัวถัง
- ต่อ shield ลงกราวด์ **ปลายเดียว** ที่ฝั่ง safe area

### 3.4 คณิตศาสตร์ที่ทำให้ "แม่นยำ" (สำคัญกว่าตัว probe)

Probe ให้แค่ `ระดับน้ำมัน (mm)`, `ระดับน้ำ (mm)`, `อุณหภูมิ (°C)` — ที่เหลือเป็นซอฟต์แวร์ทั้งหมด

**a) Strapping table (ตารางเทียบถัง)**
- ขอจากผู้ผลิตถัง หรือ calibrate เองด้วยน้ำ/น้ำมัน ทีละ 500 ลิตร
- เก็บเป็นตาราง `level_mm → volume_litre` ความละเอียด 1 mm
- ระหว่างจุดใช้ **cubic spline interpolation** (ไม่ใช่ linear — ถังทรงกระบอกนอนไม่เป็นเส้นตรง)
- สูตรถังทรงกระบอกนอน (ใช้ตรวจสอบ):
  ```
  A(h) = r²·acos((r−h)/r) − (r−h)·√(2rh − h²)
  V    = A(h)·L  +  ปริมาตรฝาหัวท้าย (dished ends)
  ```

**b) การชดเชยการเอียงถัง (tilt)**
- ถังใต้ดินมักเอียง 0.5–2° เพื่อระบายน้ำ
- ถ้าไม่ชดเชย ผิดพลาดได้ 100–300 ลิตร
- วิธี: วัดระดับด้วยไม้วัดที่ 2 manhole แล้วคำนวณ tilt offset → ใส่เป็น constant ต่อถัง

**c) การชดเชยอุณหภูมิ (VCF) — ประเทศไทยใช้ฐาน 30 °C**
```
V30 = Vobs × VCF
VCF = exp[ −α30·ΔT·(1 + 0.8·α30·ΔT) ]     , ΔT = T − 30
```
- `α30` = coefficient of thermal expansion ที่ 30 °C คำนวณจากความหนาแน่นตาม `ASTM D1250 / API MPMS Ch 11.1 Table 54B`
- ค่าประมาณ: เบนซิน ~0.00120 /°C, ดีเซล ~0.00083 /°C
- ต้องรู้ density@15°C ของ product (ใส่ในตาราง product master, อัปเดตตอนรับน้ำมัน)
- ใช้ **อุณหภูมิเฉลี่ยถ่วงน้ำหนัก** จาก RTD หลายจุด เฉพาะจุดที่จมน้ำมัน

**d) หักปริมาตรน้ำ**
```
V_net_product = V(level_product) − V(level_water)
```

**e) การสอบเทียบ probe zero**
- ระยะจากปลาย probe ถึงก้นถังจริง ต้องวัดด้วยไม้วัดแล้วใส่เป็น `probe_offset_mm`
- ทำซ้ำทุก 6 เดือน

### 3.5 การตรวจจับการรับน้ำมัน (Delivery Detection)
State machine:
```
IDLE ──(level เพิ่ม > 20 mm ภายใน 2 นาที)──▶ DELIVERY_IN_PROGRESS
DELIVERY_IN_PROGRESS ──(level นิ่ง ±2 mm นาน 5 นาที)──▶ SETTLING
SETTLING ──(รออีก 15 นาที ให้ฟองอากาศออก)──▶ DELIVERY_COMPLETE
   → บันทึก: V_before(TC), V_after(TC), V_delivered, water_before/after, T_avg
   → เทียบกับใบส่งของ (BOL) → หา delivery variance
```
เกณฑ์เตือน: variance > 0.5% ของปริมาณส่ง หรือ > 200 ลิตร

### 3.6 การกระทบยอด (Reconciliation)
```
Book stock  = Opening + Deliveries − Sales(จาก totalizer) − Adjustments
Physical    = ATG net volume (TC-corrected, หักน้ำแล้ว)
Variance    = Physical − Book
Variance %  = Variance / Throughput × 100
```
- **ต้องใช้ totalizer delta ไม่ใช่ผลรวม transaction** (transaction หายได้ตอนเน็ตหลุด, totalizer ไม่หาย)
- เกณฑ์อุตสาหกรรม: |variance| ≤ 0.5% ของ throughput ต่อเดือน
- แจ้งเตือน 3 ระดับ: daily > 1.0%, 7-day rolling > 0.5%, 30-day > 0.3%
- ทำ **SIR (Statistical Inventory Reconciliation)** แบบ CUSUM ตรวจจับ leak ช้า ๆ

### 3.7 Alarm ที่ต้องมี
| Alarm | เงื่อนไข |
|---|---|
| High level | > 95% ความจุ (ห้ามรับน้ำมันต่อ) |
| Overfill | > 98% |
| Low level | < ระดับสั่งซื้อ (reorder point) |
| Low low | < 10% (เสี่ยงปั๊มจ่ายดูดอากาศ) |
| Water high | ระดับน้ำ > 25 mm |
| Sudden loss | ลดลง > 0.5% นอกช่วงจ่ายน้ำมัน |
| Probe fault | ไม่ตอบ Modbus > 60 วินาที / ค่าผิดช่วง |
| Theft | ระดับลดขณะไม่มี transaction |

---

## 4. ส่วนที่ 2: ติดต่อหัวจ่าย (Forecourt / Dispenser Interface)

### 4.1 หัวจ่ายพูดโปรโตคอลอะไร

| ยี่ห้อ | โปรโตคอล | ชั้นกายภาพ |
|---|---|---|
| **Tatsuno** (พบมากในไทย) | Tatsuno protocol | RS-485 / current loop |
| Gilbarco Veeder-Root | Gilbarco Two-Wire | current loop 5787 bps |
| Wayne / Dresser Wayne | Wayne DART | current loop 9600 bps |
| Tokheim | Tokheim / DPT | current loop |
| Censtar / Sanki (จีน) | Censtar, มักอีมูเลต Gilbarco/Wayne ได้ | RS-485 |
| หัวจ่ายรุ่นใหม่ | **IFSF over IP** | Ethernet |

**IFSF** คือมาตรฐานเปิดที่ควรเล็ง (International Forecourt Standards Forum) — นิยาม Dispenser device application ทำงานบน TCP/IP หรือ LonWorks
ข้อจำกัด: **spec ต้องเป็นสมาชิกถึงจะได้** (มีค่าสมาชิก) ส่วนฝั่ง POS↔FDC มี **Conexxus FDC Specification** ที่เปิดกว่า (XML schema)

### 4.2 ทางเลือกการเชื่อมต่อ 3 แบบ

#### แบบ A — **PTS-2 Forecourt Controller** ⭐ แนะนำ
Technotrade PTS-2 (ยูเครน) — ขนาดเท่าบัตรเครดิต
- รองรับ **หัวจ่าย >150 ยี่ห้อ** (Gilbarco, Tatsuno, Tokheim, Wayne, Censtar...)
- รองรับ **ATG probe >50 แบบ** พร้อมกัน — จัดการได้ถึง 120 หัวจ่าย + 20 probe
- **JSON API over HTTP + WebSocket**, มี SSL/TLS, มี demo code (Java/C#/.NET Core/C++/JS)
- ทำหน้าที่ทั้ง protocol translation, transaction buffer, price pole, tank gauging
- ⇒ เราเขียนแค่ HTTP client — ไม่ต้องแตะ current loop เลย
- ประหยัดเวลาพัฒนา 6–12 เดือน เทียบกับ reverse-engineer โปรโตคอลเอง

ตัวอย่าง request (แนวคิด):
```jsonc
// อ่านสถานะหัวจ่าย
{ "Protocol":"jsonPTS", "Packets":[ { "Id":1, "Type":"PumpGetStatus", "Data":{"Pump":1} } ] }

// สั่งจ่าย 500 บาท ที่หัวจ่าย 1 nozzle 2
{ "Protocol":"jsonPTS", "Packets":[
  { "Id":2, "Type":"PumpAuthorize",
    "Data":{ "Pump":1, "Nozzle":2, "Type":"Amount", "Dose":500.00 } } ] }

// อ่านรายการขายที่ปิดแล้ว
{ "Protocol":"jsonPTS", "Packets":[ { "Id":3, "Type":"PumpGetFillingInfo", "Data":{"Pump":1} } ] }
```
> ตัวชื่อ packet จริงให้ยึดตามคู่มือ `jsonPTS protocol` ที่ Technotrade ให้มาพร้อมเครื่อง

#### แบบ B — เขียนโปรโตคอลเอง (DIY สุดทาง)
- ต้องมี current-loop ↔ TTL converter (opto-isolated) แล้วเขียน framing เอง
- Gilbarco Two-Wire ที่ 5787 bps ต้องใช้ UART ที่ตั้ง baud แปลก ๆ ได้ (RP2040 PIO / FTDI FT232 custom divisor ทำได้)
- **ปัญหา:** spec ของแต่ละยี่ห้อไม่เปิดสาธารณะ ต้องเซ็น NDA หรือ reverse engineer
- คุ้มเฉพาะกรณีมีหัวจ่ายยี่ห้อเดียวหลายร้อยหัว
- ⇒ **ไม่แนะนำสำหรับเฟสแรก**

#### แบบ C — อ่าน Pulser อย่างเดียว (ถูกที่สุด, read-only)
- มาตรวัดทุกตัวขับ pulser 100 pulse/ลิตร (quadrature A/B)
- ต่อผ่าน **IS barrier** แล้วนับ pulse ด้วย MCU
- ได้: ปริมาณที่จ่ายจริงต่อหัวจ่าย
- ไม่ได้: ราคา, การอนุญาตจ่าย, เลข transaction, ชนิดน้ำมัน (ต้อง map เอง)
- **ข้อควรระวังกฎหมาย:** ห้ามตัดต่อสายที่อยู่ในซีล — ต้องใช้ pulser ที่มี **dual output** หรือ pulse splitter ที่ผู้ผลิตรับรอง และให้ช่างที่ได้รับอนุญาตทำ
- ใช้เป็น **cross-check ชั้นที่สอง** คู่กับแบบ A ได้ดีมาก

**สรุป:** เฟส 1 ใช้ **แบบ A**, เฟส 2 เสริม **แบบ C** เป็นตัวตรวจสอบไขว้, เก็บ **แบบ B** ไว้พิจารณาเมื่อสเกลใหญ่

### 4.3 สิ่งที่ต้องออกแบบให้ถูกในซอฟต์แวร์

**a) Transaction lifecycle**
```
NOZZLE_UP → AUTHORIZED → FILLING(progress...) → NOZZLE_DOWN → COMPLETED → PAID/CLOSED
```
- ต้อง poll `PumpGetFillingInfo` ต่อเนื่องระหว่าง FILLING
- ต้องอ่าน transaction กลับจาก **buffer ของ controller** หลังเน็ตหลุด (PTS-2 เก็บให้)

**b) Idempotency (สำคัญมาก — กันยอดซ้ำ/ยอดหาย)**
```
transaction_key = SHA1( site_id | pump_no | nozzle_no | shift_id | pump_txn_seq | totalizer_end )
```
เลข sequence ของหัวจ่ายจะวนกลับ (เช่น 1–9999) จึงต้องผูกกับ shift/วันที่เสมอ

**c) Totalizer เป็นความจริงสูงสุด**
- อ่าน electronic totalizer (non-resettable) ทุกหัวจ่าย ทุก 5 นาที และตอนเปิด/ปิดกะ
- ยอดขายในการกระทบยอด = `totalizer_end − totalizer_start` เท่านั้น
- ผลรวม transaction ใช้แค่ตรวจสอบว่าตรงกับ totalizer ไหม — ถ้าไม่ตรง = มี transaction หาย → alarm

**d) Preset / สั่งจ่าย**
- รองรับทั้ง preset by amount (บาท) และ by volume (ลิตร)
- ต้องมี timeout: ถ้า authorize แล้วไม่ยกหัวจ่ายภายใน 60 วิ → auto-cancel
- ต้องมี emergency stop สั่งหยุดทุกหัวจ่ายพร้อมกัน

**e) ราคา**
- เขียนราคาลงหัวจ่ายผ่าน controller (price change) + price pole
- ต้อง log ทุกการเปลี่ยนราคา พร้อมผู้สั่งและ timestamp (ตรวจสอบย้อนหลังได้)
- ห้ามเปลี่ยนราคาขณะมี transaction ค้าง

---

## 5. Edge Gateway (ส่วนที่เราพัฒนาเอง)

### 5.1 ฮาร์ดแวร์
- Fanless mini PC (Intel N100, 8GB RAM, 256GB SSD) ~7,000–12,000 ฿ — เสถียรกว่า Raspberry Pi มากในสภาพร้อน
- ถ้าใช้ Pi ให้ใช้ **CM4 บน industrial carrier board** + eMMC (ห้าม SD card — พังแน่นอน)
- UPS 600VA + DIN rail PSU 24V
- 4G router สำรอง
- ตู้ควบคุมมี fan + filter (อุณหภูมิห้องปั๊มไทย 35–45 °C)

### 5.2 โครงสร้างซอฟต์แวร์ที่เสนอ
```
edge/
├── cmd/agent/                  # entrypoint
├── internal/
│   ├── pts/                    # PTS-2 JSON client (HTTP + WebSocket)
│   ├── modbus/                 # อ่าน probe ตรงผ่าน RS-485 (ทางเลือก/สำรอง)
│   ├── tank/
│   │   ├── strapping.go        # ตารางเทียบถัง + spline
│   │   ├── vcf.go              # ASTM D1250 Table 54B
│   │   └── delivery.go         # state machine ตรวจจับการรับน้ำมัน
│   ├── pump/
│   │   ├── session.go          # transaction lifecycle
│   │   └── totalizer.go
│   ├── recon/                  # reconciliation + SIR/CUSUM
│   ├── store/                  # SQLite (WAL) — local source of truth
│   ├── outbox/                 # store & forward → UDOM Next
│   └── api/                    # local REST + web UI
└── deploy/                     # systemd unit, docker-compose
```

**หลักการที่ห้ามพลาด**
1. **Local-first** — เขียนลง SQLite ก่อนเสมอ แล้วค่อย sync ขึ้น cloud (ปั๊มเน็ตหลุดบ่อย)
2. **Outbox pattern** — คิวส่งขึ้น UDOM Next พร้อม retry + exponential backoff, ไม่ลบจนกว่าจะได้ ACK
3. **ทุก event มี `event_id` (UUIDv7)** ให้ฝั่งรับ dedupe ได้
4. **NTP sync** — เวลาผิดพลาดทำให้กะและการกระทบยอดพัง; ใช้ chrony + RTC module
5. **อย่าลบข้อมูลดิบ** — เก็บ raw reading ทุก 1 นาที ย้อนหลัง 90 วัน สำหรับสืบสวนภายหลัง

### 5.3 สคีมาข้อมูลหลัก
```sql
site(id, name, tz, created_at)
product(id, code, name, density15, alpha30)
tank(id, site_id, product_id, capacity_l, diameter_mm, length_mm,
     probe_offset_mm, tilt_mm, reorder_point_l)
strapping_point(tank_id, level_mm, volume_l)          -- PK(tank_id, level_mm)
probe(id, tank_id, serial, model, bus_addr, last_seen_at)
tank_reading(id, tank_id, ts, level_mm, water_mm, temp_c,
             volume_obs_l, volume_tc_l, water_l, source)
delivery(id, tank_id, started_at, ended_at, v_before_tc, v_after_tc,
         v_delivered_tc, bol_no, bol_volume, variance_l)
dispenser(id, site_id, pump_no, brand, protocol, addr)
nozzle(id, dispenser_id, nozzle_no, tank_id, product_id)
txn(id, event_id, nozzle_id, shift_id, pump_txn_seq, started_at, ended_at,
    volume_l, unit_price, amount, totalizer_start, totalizer_end,
    status, synced_at)                                 -- UNIQUE(transaction_key)
totalizer_snapshot(id, nozzle_id, ts, volume_total_l, amount_total)
shift(id, site_id, opened_at, closed_at, opened_by, closed_by)
recon_daily(id, tank_id, business_date, opening_l, delivered_l, sold_l,
            book_l, physical_l, variance_l, variance_pct)
alarm(id, site_id, kind, severity, ref_type, ref_id, raised_at, cleared_at, note)
audit_log(id, actor, action, payload_json, ts)
outbox(id, event_id, topic, payload_json, attempts, next_retry_at, sent_at)
```

### 5.4 Event schema สำหรับส่งเข้า UDOM Next
```jsonc
{
  "event_id": "0192f3c1-...",          // UUIDv7 — ใช้ dedupe
  "event_type": "fuel.transaction.completed",
  "schema_version": 1,
  "site_id": "STN-001",
  "occurred_at": "2026-09-12T10:22:31+07:00",
  "sent_at":     "2026-09-12T10:22:33+07:00",
  "data": {
    "pump_no": 1, "nozzle_no": 2,
    "product_code": "G95",
    "volume_l": 24.512,
    "unit_price": 38.44,
    "amount": 942.24,
    "totalizer_start_l": 128455.120,
    "totalizer_end_l":   128479.632,
    "pump_txn_seq": 4471,
    "shift_id": "SH-20260912-A",
    "started_at": "2026-09-12T10:21:02+07:00",
    "ended_at":   "2026-09-12T10:22:31+07:00"
  }
}
```
Event types: `fuel.transaction.completed`, `fuel.tank.reading`, `fuel.delivery.completed`,
`fuel.alarm.raised`, `fuel.alarm.cleared`, `fuel.shift.closed`, `fuel.recon.daily`,
`fuel.price.changed`, `fuel.totalizer.snapshot`

**การเชื่อมกับ UDOM Next** (เลือกได้ตามระบบเดิม):
- REST: `POST /api/v1/fuel/events` (batch ได้, ตอบ 200 + list ของ event_id ที่รับแล้ว)
- MQTT: topic `udom/{site_id}/fuel/{event_type}` , QoS 1, retained สำหรับ state
- Webhook + HMAC-SHA256 signature header
> ควรทำ **anti-corruption layer** บาง ๆ ที่ฝั่ง edge เพื่อ map เป็นสคีมาของ UDOM Next
> ระบบ edge ไม่ควรรู้จัก domain model ของ UDOM Next โดยตรง

---

## 6. BOM และงบประมาณ (ต่อ 1 สถานี: 4 ถัง / 4 ตู้จ่าย / 8 หัวจ่าย)

| รายการ | จำนวน | ราคา/หน่วย | รวม (฿) |
|---|---|---|---|
| Magnetostrictive probe (ATEX, Modbus) | 4 | 12,000 | 48,000 |
| IS barrier / galvanic isolator | 4 | 2,500 | 10,000 |
| Ex junction box + cable gland | 4 | 1,500 | 6,000 |
| สาย STP ทนน้ำมัน + ท่อร้อยสาย | ~200 m | — | 12,000 |
| PTS-2 forecourt controller | 1 | 30,000 | 30,000 |
| Edge mini PC (N100) | 1 | 10,000 | 10,000 |
| ตู้ควบคุม + DIN PSU 24V + UPS | 1 ชุด | — | 12,000 |
| RS-485 isolator / converter | 2 | 1,500 | 3,000 |
| ไม้วัดสอบเทียบ + อุปกรณ์ calibrate | 1 ชุด | — | 3,000 |
| ค่าติดตั้ง/ช่างไฟ Ex certified | — | — | 20,000 |
| **รวม** | | | **~154,000** |

ลดต้นทุนได้ถ้า: ใช้ probe SYW-A (~8,000) → เหลือ ~138,000
เทียบระบบแบรนด์ (Veeder-Root TLS-450PLUS + 4 mag probe + Doms PSS): **450,000–800,000 ฿**

---

## 7. แผนดำเนินการเป็นเฟส

| เฟส | ขอบเขต | ผลลัพธ์ | ระยะเวลา |
|---|---|---|---|
| **0. Lab** | ซื้อ probe 1 ตัว + PTS-2 + จำลองถังด้วยถัง 200 ล. | อ่านค่า Modbus ได้, เข้าใจ jsonPTS | 3–4 สัปดาห์ |
| **1. ATG read-only** | ติดตั้ง probe จริง 1 ถัง, edge gateway, dashboard | เห็นระดับน้ำมัน real-time, alarm พื้นฐาน | 4–6 สัปดาห์ |
| **2. Pump read-only** | ต่อ PTS-2 เข้าหัวจ่าย, อ่าน transaction + totalizer | ยอดขายเข้า UDOM Next อัตโนมัติ | 4–6 สัปดาห์ |
| **3. Reconciliation** | strapping table, VCF, delivery detection, recon engine | รายงานกระทบยอดรายวัน/เดือน | 4 สัปดาห์ |
| **4. Pump control** | authorize/preset/price change | สั่งจ่ายจากระบบได้ (prepaid, fleet card) | 4–6 สัปดาห์ |
| **5. Scale-out** | เพิ่มถัง/ตู้จ่ายให้ครบ, multi-site, OTA update | ใช้งานเต็มสถานี ขยายหลายสาขา | ต่อเนื่อง |

**เกณฑ์ยอมรับเฟส 1–3 (ต้องผ่านจริง):**
- อ่านค่า probe เทียบไม้วัด คลาดเคลื่อน ≤ 0.3% ของปริมาตรถัง
- Delivery variance เทียบ BOL ≤ 0.5%
- ยอดขายจาก transaction เทียบ totalizer delta ต่างกัน = 0 ลิตร
- Reconciliation variance รายเดือน อยู่ใน ±0.5%
- ทดสอบเน็ตหลุด 24 ชม. แล้วข้อมูลไม่หายและไม่ซ้ำ

---

## 8. สิ่งที่ "ห้ามทำ" — เช็คลิสต์ความปลอดภัย/กฎหมาย

- ❌ เอาเซนเซอร์ที่ไม่มี Ex certification ลงถัง
- ❌ ต่อสายเข้าถังโดยไม่ผ่าน IS barrier
- ❌ ถอด/ทำลายซีลของสำนักชั่งตวงวัดบนมาตรวัด
- ❌ ปรับ calibration factor ของหัวจ่ายด้วยตัวเอง
- ❌ ตัดต่อสาย pulser ที่อยู่ในส่วนที่ผนึกซีล
- ❌ ติดตั้ง edge PC / controller ในระยะ Zone 1–2
- ❌ ใช้ค่าจากระบบ DIY อ้างเป็น leak detection ตามกฎหมายโดยไม่ได้รับรอง
- ❌ ใช้ SD card เป็น storage หลักบน edge
- ✅ จ้างช่างที่มีใบรับรองงานพื้นที่อันตรายเป็นผู้ติดตั้งฝั่ง field เสมอ
- ✅ ทำเอกสาร IS loop calculation + hazardous area classification drawing เก็บไว้

---

## 9. อ้างอิงมาตรฐาน

**ความปลอดภัย**
- `IEC 60079-0` / `-11` / `-14` — Explosive atmospheres, intrinsic safety, installation
- `NFPA 30` / `NFPA 30A` — Flammable liquids code / Motor fuel dispensing facilities
- กฎกระทรวง สถานีบริการน้ำมันเชื้อเพลิง — กรมธุรกิจพลังงาน

**มาตรวิทยา**
- `พ.ร.บ. มาตราชั่งตวงวัด พ.ศ. 2542` และที่แก้ไขเพิ่มเติม — สำนักชั่งตวงวัด กรมการค้าภายใน
- `OIML R117` — Dynamic measuring systems for liquids other than water
- `API MPMS Ch. 3.1B` — Standard practice for level measurement (automatic tank gauging)
- `API MPMS Ch. 11.1` / `ASTM D1250` Table 54B — Volume correction factors
- `API MPMS Ch. 13` — Statistical aspects / reconciliation

**โปรโตคอล / ระบบ**
- IFSF Standard Forecourt Protocol (Dispenser device application, TCP/IP หรือ LonWorks)
- Conexxus Forecourt Device Controller (FDC) Specification — XML schema ระหว่าง POS ↔ FDC
- Veeder-Root TLS-350/450 serial command set (`i20100` in-tank inventory ฯลฯ) — สำหรับ interoperate กับระบบเดิม
- Modbus RTU (`Modbus Application Protocol V1.1b3`)
- `PEI RP1200` — Testing and verification of spill/overfill/leak detection equipment

---

## 10. คำถามที่ต้องเคลียร์ก่อนเริ่มเฟส 0

1. หัวจ่ายที่หน้างานเป็น **ยี่ห้อ/รุ่นอะไร** และมีพอร์ตสื่อสารว่างไหม (สำคัญที่สุด)
2. ถังใต้ดิน: จำนวน, ขนาด, ทรงกระบอกนอนหรืออื่น, **มี strapping table ไหม**, จำนวน manhole
3. UDOM Next: stack อะไร (ภาษา/ฐานข้อมูล/มี message broker ไหม), รับข้อมูลทาง REST หรือ MQTT
4. มี POS เดิมที่ต้องอยู่ร่วมกันไหม (ถ้ามี PTS-2 ต้องต่อขนานหรือ pass-through)
5. เป้าหมายจริง: แค่ monitoring + ยอดขาย หรือจะทำ prepaid/fleet card ที่ต้อง authorize ด้วย
6. จำนวนสาขาที่จะขยาย (มีผลต่อการออกแบบ multi-tenant และ OTA)
