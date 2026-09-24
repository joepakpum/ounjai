# อุ่นใจ — ระบบบันทึกรายรับรายจ่าย

## เริ่มระบบด้วย Podman Compose

ต้องติดตั้ง Podman และ Compose provider ไว้ก่อน ตรวจได้ด้วย `podman compose version`

```powershell
podman compose up --build -d
```

เปิดเว็บที่ <http://localhost:5173> ระบบจะสร้างคอนเทนเนอร์ `saving-web`, `saving-api` และ `saving-mysql` พร้อมฐานข้อมูล MySQL ใน named volume ที่คงข้อมูลแม้หยุดคอนเทนเนอร์ เว็บ/API ใช้พอร์ตภายในของ Compose network

## เปิดผ่าน Cloudflare Tunnel

สร้าง remotely-managed tunnel ใน Cloudflare Zero Trust แล้วกำหนด Public Hostname ให้ชี้ไปที่ `http://web:5173` จากนั้นคัดลอก `.env.example` เป็น `.env` และใส่ Tunnel token ใน `CLOUDFLARE_TUNNEL_TOKEN` (อย่า commit ไฟล์ `.env`) เปิดบริการ tunnel ด้วย:

```powershell
podman compose --profile tunnel up --build -d
```

บริการ `saving-cloudflared` จะเชื่อมไปยังเว็บผ่าน Compose network โดยไม่ต้องเปิดพอร์ตเว็บออกสู่อินเทอร์เน็ตโดยตรง หยุด tunnel ได้ด้วย `podman compose --profile tunnel stop cloudflared` ส่วนการเปิดแอปในเครื่องโดยไม่ใช้ tunnel ยังคงใช้ `podman compose up --build -d`

ดูสถานะและบันทึกการทำงาน:

```powershell
podman compose ps
podman compose logs -f
```

หยุดระบบโดยเก็บข้อมูลไว้:

```powershell
podman compose down
```

ค่าเริ่มต้นเป็นข้อมูลทดสอบในเครื่อง รหัสผ่านอยู่ใน `compose.yaml` เพื่อให้เริ่มระบบได้ทันที เปลี่ยนค่าด้วยการคัดลอก `.env.example` เป็น `.env` ก่อนใช้งานร่วมกับผู้อื่น เว็บและ MySQL bind เฉพาะ `127.0.0.1`; API เปิดเฉพาะบน Compose network เพราะระบบเข้าสู่ระบบและสิทธิ์สมาชิกยังไม่พร้อมใช้

สคีมาและข้อมูลตัวอย่างเริ่มต้นจาก `database/init/001-schema.sql` และจะถูกใช้เมื่อสร้าง volume ฐานข้อมูลใหม่เท่านั้น

## ขอบเขตที่ยังไม่พร้อมใช้งานจริง

- หน้าเว็บเป็นต้นแบบ ข้อมูลรายการที่ส่งผ่านฟอร์มบันทึกลง MySQL แล้ว
- ยังไม่มีระบบเข้าสู่ระบบหรือการแยกสิทธิ์ครอบครัว ห้ามใช้บันทึกข้อมูลการเงินจริงที่เป็นความลับหรือเปิดพอร์ตไปยังเครือข่ายอื่น
- การอ่านภาพสลิปเป็นข้อมูลตัวอย่าง ยังไม่เชื่อม OCR
- งบประมาณ บัญชีเงิน และยอดคงเหลือในหน้า dashboard ยังเป็นตัวอย่าง ไม่ได้คำนวณจาก MySQL
