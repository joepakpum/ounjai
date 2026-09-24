# อุ่นใจ — ระบบบันทึกรายรับรายจ่าย

## เริ่มระบบด้วย Podman Compose

ต้องติดตั้ง Podman และ Compose provider ไว้ก่อน ตรวจได้ด้วย `podman compose version`

```powershell
podman compose up --build -d
```

เปิดเว็บที่ <http://localhost:5173> ระบบจะสร้างคอนเทนเนอร์ `saving-web`, `saving-api` และ `saving-mysql` พร้อมฐานข้อมูล MySQL ใน named volume ที่คงข้อมูลแม้หยุดคอนเทนเนอร์ เว็บ/API ใช้พอร์ตภายในของ Compose network

## เปิดผ่าน Cloudflare Tunnel

**อย่าเปิด Tunnel หรือชี้โดเมนสาธารณะมาที่แอปในตอนนี้** จนกว่าระบบบัญชี สิทธิ์ และการตรวจรับความปลอดภัยจะเสร็จ เมื่อพร้อมแล้ว สร้าง remotely-managed tunnel ใน Cloudflare Zero Trust ตั้ง Public Hostname ให้ชี้ไปที่ `http://web:8080` คัดลอก `.env.example` เป็น `.env` ใส่ Tunnel token ใน `CLOUDFLARE_TUNNEL_TOKEN` (อย่า commit ไฟล์ `.env`) และเปิดบริการด้วย:

ระบบบัญชีใช้อีเมลและรหัสผ่าน ต้องตั้ง `APP_BASE_URL` เป็น HTTPS domain ของคุณ, `COOKIE_SECURE=true` และตั้งค่า SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`) ใน `.env` เพื่อส่งลิงก์ยืนยันอีเมลและรีเซ็ตรหัสผ่าน เปิด profile หลังผ่านรายการเตรียมใช้งานจริงใน PLAN.md เท่านั้น

```powershell
podman compose --profile tunnel up --build -d
```

เว็บสร้างเป็น static production bundle และรับ API ผ่าน Nginx ภายในคอนเทนเนอร์ `saving-web`; บริการ `saving-cloudflared` เชื่อมไปยังเว็บผ่าน Compose network โดยไม่ต้องเปิดพอร์ตเว็บออกสู่อินเทอร์เน็ตโดยตรง หยุด tunnel ได้ด้วย `podman compose --profile tunnel stop cloudflared` ส่วนการเปิดแอปในเครื่องโดยไม่ใช้ tunnel ยังคงใช้ `podman compose up --build -d`

ดูสถานะและบันทึกการทำงาน:

```powershell
podman compose ps
podman compose logs -f
```

หยุดระบบโดยเก็บข้อมูลไว้:

```powershell
podman compose down
```

ค่าเริ่มต้นเป็นข้อมูลทดสอบในเครื่อง รหัสผ่านฐานข้อมูลตัวอย่างใน `compose.yaml` ใช้สำหรับเครื่อง local เท่านั้น; ก่อนใช้ domain ต้องตั้งรหัสผ่านสุ่มที่แข็งแรงใน `.env` เว็บและ MySQL bind เฉพาะ `127.0.0.1`; API เปิดเฉพาะบน Compose network

สคีมาและข้อมูลตัวอย่างเริ่มต้นจาก `database/init/001-schema.sql` และจะถูกใช้เมื่อสร้าง volume ฐานข้อมูลใหม่เท่านั้น

## ขอบเขตที่ยังไม่พร้อมใช้งานจริง

- หน้าเว็บเป็นต้นแบบ ข้อมูลรายการที่ส่งผ่านฟอร์มบันทึกลง MySQL แล้ว
- มีโครงสมัคร/ยืนยันอีเมล เข้าสู่ระบบ ออกจากระบบ และรีเซ็ตรหัสผ่าน; ยังต้องตรวจรับการทำงานจริงและทำระบบคำเชิญ/สิทธิ์สมาชิกครอบครัวให้ครบ ห้ามเปิดโดเมนสาธารณะหรือใช้ข้อมูลการเงินจริงจนกว่าจะผ่านแผนตรวจรับ
- migration เพิ่มเจ้าของและครอบครัวให้รายการเดิมแบบเว้นว่าง รายการเก่าจะยังอยู่ในฐานข้อมูลแต่ไม่แสดงแก่บัญชีใหม่จนกว่าจะมีขั้นตอนตรวจและนำเข้าที่ระบุเจ้าของอย่างชัดเจน
- การอ่านภาพสลิปเป็นข้อมูลตัวอย่าง ยังไม่เชื่อม OCR
- งบประมาณ บัญชีเงิน และยอดคงเหลือในหน้า dashboard ยังเป็นตัวอย่าง ไม่ได้คำนวณจาก MySQL
