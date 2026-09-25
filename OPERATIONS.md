# Operations: backups and recovery

## Create a backup

Run from the repository root in PowerShell while `saving-mysql` and `saving-api` are running:

```powershell
./scripts/backup.ps1
```

The script stops `saving-web` and then `saving-api`. The API waits for in-flight requests to finish before closing its MySQL pool, and Compose allows up to 45 seconds for graceful shutdown. It takes the database snapshot with the API stopped, restarts the API and waits for its health check, then archives receipt files while the web remains stopped. This keeps browser uploads, deletes, and the recurring worker from changing receipt files during capture.

It writes a timestamped folder under `backups/` with a MySQL dump, a compressed archive of receipt images, a manifest, and SHA-256 hashes for both payload files. It restarts the API before the web; if the API does not become healthy, it leaves the web stopped and reports the recovery step. The folder is ignored by Git because it contains private financial data. Store a copy on encrypted storage with access limited to the family owner. The script does not encrypt the backup itself.

Use an external schedule to run it regularly and keep more than one dated copy. Before upgrades, create an extra backup and confirm both files exist and have nonzero size.

## Restore a backup

Recovery replaces the live financial database and receipt archive. First make a new backup of the current state. Then use a known-good backup folder and run each command from the repository root in PowerShell. Keep the Cloudflare Tunnel profile stopped throughout recovery.

New backups include SHA-256 values in `manifest.txt`; the restore snippet checks them before prompting to replace live data. Earlier backup folders without these values can still be restored, but their payloads are not checksum-verified by this snippet.

```powershell
$backup = (Resolve-Path '.\backups\YYYYMMDD-HHMMSS-fff').Path
if (!(Test-Path (Join-Path $backup 'mysql.sql')) -or !(Test-Path (Join-Path $backup 'receipts.tar.gz'))) { throw 'Backup files are missing.' }
$manifest = Join-Path $backup 'manifest.txt'
if (Test-Path $manifest) {
  $expectedMysql = (Get-Content $manifest | Where-Object { $_ -like 'SHA256_mysql.sql=*' } | Select-Object -First 1) -replace '^SHA256_mysql.sql=', ''
  $expectedReceipts = (Get-Content $manifest | Where-Object { $_ -like 'SHA256_receipts.tar.gz=*' } | Select-Object -First 1) -replace '^SHA256_receipts.tar.gz=', ''
  if ($expectedMysql -and (Get-FileHash (Join-Path $backup 'mysql.sql') -Algorithm SHA256).Hash -ne $expectedMysql) { throw 'MySQL backup checksum does not match.' }
  if ($expectedReceipts -and (Get-FileHash (Join-Path $backup 'receipts.tar.gz') -Algorithm SHA256).Hash -ne $expectedReceipts) { throw 'Receipt archive checksum does not match.' }
}
$confirmation = Read-Host 'This replaces live financial data. Type RESTORE saving to continue'
if ($confirmation -cne 'RESTORE saving') { throw 'Restore cancelled.' }
podman compose stop web api
podman cp (Join-Path $backup 'mysql.sql') saving-mysql:/tmp/saving-restore.sql
podman exec saving-mysql sh -c 'umask 077; printf "[client]\nuser=root\npassword=%s\n" "$MYSQL_ROOT_PASSWORD" > /tmp/saving-restore-client.cnf; mysql --defaults-extra-file=/tmp/saving-restore-client.cnf "$MYSQL_DATABASE" < /tmp/saving-restore.sql; status=$?; rm -f /tmp/saving-restore-client.cnf; exit $status'
if ($LASTEXITCODE -ne 0) { throw 'MySQL restore failed; leave web and api stopped.' }
podman cp (Join-Path $backup 'receipts.tar.gz') saving-api:/tmp/saving-receipts-restore.tar.gz
podman start saving-api
podman exec saving-api sh -c 'find "$RECEIPT_STORAGE_PATH" -mindepth 1 -delete && tar -xzf /tmp/saving-receipts-restore.tar.gz -C "$RECEIPT_STORAGE_PATH" && rm -f /tmp/saving-restore.sql /tmp/saving-receipts-restore.tar.gz'
if ($LASTEXITCODE -ne 0) { throw 'Receipt restore failed; keep web stopped and investigate before continuing.' }
podman start saving-web
Invoke-RestMethod http://localhost:5173/api/health
```

Replace `YYYYMMDD-HHMMSS` with the chosen backup folder. Do not restore an unknown dump. MySQL and receipt files must come from the same backup folder. After recovery, inspect accounts, transactions, and receipt images before reconnecting any public tunnel.

## Cloudflare Tunnel preflight

Do not start the `tunnel` profile until the owner has approved public access and all security-gate items are closed. After approval, put production values in the ignored `.env` file and run:

```powershell
.\scripts\tunnel.ps1 -Action validate
.\scripts\tunnel.ps1 -Action start
```

The Compose `tunnel-preflight` service also gates `cloudflared` when the profile is started directly. The gate checks HTTPS, secure cookies, separate long database passwords, a token, SMTP transport settings, and a valid Super Admin email. It reports setting names only and never prints their values. Stop public access with `./scripts/tunnel.ps1 -Action stop`.

## ขั้นตอนหลังแก้ไขโค้ดและก่อนปิดงาน

### ต้อง build ใหม่หรือไม่

- แก้เฉพาะ Markdown/เอกสาร: ไม่ต้อง build container
- แก้ `web/src`, CSS, asset, `web/Dockerfile`, Nginx config หรือ dependency ของเว็บ: `podman compose build web` แล้ว `podman compose up -d --no-deps web`
- แก้ `api/server.js`, `api/migrations`, `api/Dockerfile` หรือ dependency API: `podman compose build api` แล้ว `podman compose up -d --no-deps api`; API จะรัน migrations ตอนเริ่มระบบ
- แก้ `compose.yaml`, `.env` หรือบริการ/การตั้งค่า container: รัน `podman compose up --build -d` เพื่อให้ Compose สร้าง image และปรับ container ตาม config
- เปลี่ยน schema ห้ามลบ volume ฐานข้อมูลเพื่อบังคับให้เริ่มใหม่ ให้เพิ่ม migration แล้วตรวจ backup/restore ตามนโยบายก่อน

แยก `build` ออกจาก `up --no-deps` สำหรับการเปลี่ยนโค้ดบริการเดียว เพื่อไม่ให้ Compose ต้องตรวจ/รีสตาร์ต dependency ที่ไม่เกี่ยวข้อง การใช้ `podman compose up --build -d` แบบรวมสะดวกเมื่อต้องอัปเดต stack ทั้งหมด แต่อาจสร้าง image หรือแทนที่ container ของ dependency ที่ Compose เห็นว่า config เปลี่ยน ฐานข้อมูลคงอยู่ใน named volume ตราบใดที่ไม่ได้สั่ง `down --volumes` หรือ `volume rm` ส่วนการแก้เอกสารอย่างเดียวไม่ต้อง build

### Checklist ปิดงาน

รันจาก PowerShell ที่ repository root:

```powershell
git diff --check
./scripts/verify.ps1
# ตัวอย่างเมื่อแก้เว็บ
podman compose build web
podman compose up -d --no-deps web
podman compose ps
Invoke-RestMethod http://localhost:5173/api/health
podman compose logs --tail 100 web api
git status --short
```

เมื่อแก้ API ให้แทนสองคำสั่ง build/up ด้วย `podman compose build api` และ `podman compose up -d --no-deps api`; เมื่อแก้ทั้งคู่ ให้ build ทั้ง `web api` และสั่ง `up -d --no-deps api web`.

จากนั้นเปิดแอปใน browser ทดสอบหน้าหรือ flow ที่เปลี่ยนจริง รวมถึงการเลือกภาพจากคลังภาพ/ถ่ายภาพเมื่อแตะฟังก์ชันสลิป ตรวจว่าแสดงผลสแกนหรือข้อความ error ที่อ่านเข้าใจได้ แล้วบันทึกรายการทดสอบเฉพาะข้อมูลจำลองและลบทิ้งเมื่อเสร็จ ตรวจ diff อีกครั้งก่อน commit/push. `scripts/verify.ps1` ใช้ MySQL ชั่วคราวและลบ volumes ทดสอบเอง; ห้ามส่งฐานข้อมูลจริงหรือไฟล์ข้อมูลผู้ใช้เข้า test fixture.

ถ้าเปลี่ยนเฉพาะเว็บ/API แล้วไม่อยากอัปเดต service อื่น ให้ใช้คำสั่ง build เฉพาะ service ด้านบนแทนคำสั่งรวม. อย่าเปิด Cloudflare Tunnel เป็นส่วนหนึ่งของ checklist; ต้องผ่าน gate และได้รับอนุมัติแยกก่อนเสมอ.

## Current limitations

- A backup was restored into a disposable MySQL container and the schema migrations and row counts matched. A synthetic receipt was uploaded, attached, archived with a database dump, deleted, then both files were restored into new MySQL/API/volume containers; authenticated download and SHA-256 matched. The live backup had no receipt rows or images, so visual/OCR quality with a real receipt remains unverified.
- Backups are not encrypted by the script. Protect them with encrypted host storage and access controls.
- There is no automated scheduler or offsite backup destination configured by the application.
- The user has deferred backup destination, encryption/key custody, schedule, and retention decisions; do not treat the local backup script as a complete disaster-recovery setup.
