# UDOM Next — pump agent (ตัวแทนหัวจ่าย)

โปรแกรมเล็ก ๆ ที่รันค้างบน Raspberry Pi / PC ในปั๊ม เชื่อมตู้จ่ายน้ำมันเข้ากับ UDOM Next
โครงสร้างล้อแบบ `tools/print-agent` ของ UDCS ทุกประการ (role `AGENT` + heartbeat + claim + finish)

```
RS-485 (ตู้จ่าย) <-> pump agent <-> Supabase <-> PWA (POS บนมือถือ/แท็บเล็ต)
```

## หน้าที่

| # | งาน | รายละเอียด |
|---|---|---|
| 1 | สถานะสด | poll ทุก 500 ms → ส่งขึ้น Supabase แบบ throttle → PWA ฟังผ่าน Realtime |
| 2 | รายการขาย | ตรวจจับตอนรายการจบ → ส่งเป็น transaction (กันซ้ำด้วย `client_ref`) |
| 3 | totalizer | อ่านตามรอบ → ความจริงสูงสุดของการกระทบยอด |
| 4 | สั่งจ่าย | รับคำสั่งจาก PWA → ยิงเข้าตู้จ่าย → รายงานผล |

## โครงสร้าง

```
agent.js              main loop + state machine ตรวจจับรายการ
bus.js                RS-485 หนึ่งเส้น = master ตัวเดียว = คิวเดียว (half-duplex ห้ามยิงชนกัน)
codec/sim.js          โปรโตคอลของ tools/rs485/sim_zc.py (ใช้พัฒนาไปก่อน)
codec/zc.js           ⚠️ ยังไม่มี — เขียนหลังถอดโปรโตคอลจริงของบอร์ด ZC ได้
transport/tcp.js      ต่อ simulator ตอน dev
transport/serial.js   RS-485 จริง (npm install serialport)
sink/console.js       dev: พิมพ์ออกจอ + รับคำสั่งจาก stdin
sink/supabase.js      จริง: RPC ของ UDOM Next
test/e2e.js           ทดสอบครบวงจรกับ simulator
```

**จุดสำคัญของการออกแบบ:** โปรโตคอลถูกแยกไว้ใน `codec/` ตัวเดียว
พอถอดโปรโตคอลจริงได้ → เขียน `codec/zc.js` ที่ export หน้าตาเดียวกัน → เปลี่ยน `"codec"` ใน config
**ที่เหลือทั้งระบบไม่ต้องแก้แม้แต่บรรทัดเดียว**

## ลองเลย (ไม่ต้องมีฮาร์ดแวร์)

```bash
# หน้าต่างที่ 1 — ตู้จ่ายจำลอง
python3 ../rs485/sim_zc.py --tcp 5000

# หน้าต่างที่ 2 — agent
cp config.example.json config.json      # ค่าเริ่มต้นชี้ไป tcp 5000 + sink console แล้ว
node agent.js config.json

# ในหน้าต่างที่ 2 พิมพ์คำสั่งได้เลย (จำลองสิ่งที่ PWA จะสั่ง)
amount diesel_west_front 500       # สั่งจ่าย 500 บาท
volume diesel_west_front 20        # สั่งจ่าย 20 ลิตร
free   diesel_west_front           # เต็มถัง
stop   diesel_west_front
price  diesel_west_front 33.50

# ในหน้าต่างที่ 1 จำลองพนักงาน/ลูกค้า
up 1        # ยกหัวจ่าย
down 1      # วางหัวจ่าย (ปิดรายการ)
```

## ทดสอบ

```bash
npm test          # = node test/e2e.js
```

ครอบคลุม: อ่าน totalizer ตั้งต้น · สั่งจ่ายตามยอดเงิน · ยอดวิ่งระหว่างจ่าย + throttle ·
ปิดรายการได้ยอดจริง (ไม่ใช่ยอด preset) · `ticket_ref` วิ่งจากคำสั่งไปถึง transaction ·
ส่วนต่าง totalizer ตรงกับลิตรที่จ่าย · กันสั่งซ้อน · คำสั่งหมดอายุ · ตู้จ่ายขาดการติดต่อ

## Config: หนึ่ง bus = หนึ่ง baud/framing/codec

```jsonc
"buses": [
  { "id": "bus1", "codec": "zc",
    "transport": { "kind": "serial", "port": "/dev/ttyUSB0", "baud": 9600, "framing": "8N1" },
    "boards": [ { "addr": 1, "nozzles": [ {"code":"diesel_west_front","nozzle_no":1}, ... ] } ] },
  { "id": "bus2-gasohol95", "codec": "zc2",
    "transport": { "kind": "serial", "port": "/dev/ttyUSB1", "baud": 19200, "framing": "8E1" },
    "boards": [ ... ] }
]
```

> ⚠️ **บอร์ดที่ใช้ baud ต่างกัน อยู่บนสาย RS-485 เส้นเดียวกันไม่ได้**
> ถ้าตู้แก๊สโซฮอล์ 95 เป็นบอร์ดคนละรุ่นและตั้ง baud คนละค่า ต้องมี USB↔RS-485 แยกอีกตัว
> (โปรโตคอลต่างกันแต่ baud เดียวกัน อยู่เส้นเดียวกันได้ เพราะกรองด้วย address)

## กฎความปลอดภัยที่ฝังไว้ในโค้ดแล้ว

| กฎ | ที่มา |
|---|---|
| คำสั่งหมดอายุแล้วไม่ยิงเข้าตู้จ่าย | ถ้า authorize หลุดไปถึงตู้ช้า หัวจ่ายจะปลดล็อกตอนไม่มีใครอยู่ |
| หัวจ่ายกำลังจ่ายอยู่ → ปฏิเสธคำสั่งใหม่ | กันสั่งซ้อน (ฐานข้อมูลก็มี partial unique index กันอีกชั้น) |
| หัวจ่ายขาดการติดต่อ → ปฏิเสธคำสั่ง | ไม่ยิงคำสั่งเข้าไปในความมืด |
| เปลี่ยนราคาขณะกำลังจ่ายไม่ได้ | ราคาเปลี่ยนกลางคันทำให้ยอดเงินเพี้ยน |
| หนึ่งบัสหนึ่งคิว | RS-485 half-duplex ยิงชนกัน = ข้อมูลเสียหมด |
| เตือนเมื่อลิตร ≠ ส่วนต่าง totalizer | จับรายการหายหรือค่าเพี้ยนได้ทันที |

## ⚠️ กฎที่ต้องบังคับฝั่ง PWA

**คำสั่งสั่งจ่ายห้ามเข้า `js/offline_outbox.js` เด็ดขาด**

outbox เหมาะกับวัดถัง/มิเตอร์/โอนเงิน ที่ส่งช้าได้ แต่ถ้า authorize ถูกคิวไว้ตอนออฟไลน์
แล้ว flush ตอน 20 นาทีต่อมา **หัวจ่ายจะปลดล็อกโดยไม่มีใครอยู่**
→ ออฟไลน์ = ปุ่มสั่งจ่ายต้องเป็นสีเทา กดไม่ได้

## ติดตั้งจริง

```bash
mkdir -p ~/udom-pump-agent && cd ~/udom-pump-agent
cp -r /path/to/matali/tools/pump-agent/* .
npm install @supabase/supabase-js serialport
cp config.example.json config.json && nano config.json   # sink=supabase + ข้อมูล bus จริง
node agent.js config.json                                 # ทดสอบก่อน

sudo cp udom-pump-agent.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now udom-pump-agent
journalctl -u udom-pump-agent -f
```

สร้างบัญชีตัวแทนใน Supabase เหมือน print-agent: Authentication → Add user
`pump-agent@udom.local` แล้วใส่ `staff_profiles` role = **AGENT**

> แนะนำให้ **แยกเครื่องจาก print-agent** เพราะ agent หัวจ่ายต้องรันตลอด 24 ชม.
> ส่วน Chromium ของ print-agent กินแรมเป็นช่วง ๆ

SQL ที่ต้องรันก่อน: `sql/2026-09-15_pump_agent.sql` (ในรีโป matali — ข้อเสนอสำหรับย้ายเข้า UDCS)
