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

## Current limitations

- A backup was restored into a disposable MySQL container and the schema migrations and row counts matched. A synthetic receipt was uploaded, attached, archived with a database dump, deleted, then both files were restored into new MySQL/API/volume containers; authenticated download and SHA-256 matched. The live backup had no receipt rows or images, so visual/OCR quality with a real receipt remains unverified.
- Backups are not encrypted by the script. Protect them with encrypted host storage and access controls.
- There is no automated scheduler or offsite backup destination configured by the application.
