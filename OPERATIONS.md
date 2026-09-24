# Operations: backups and recovery

## Create a backup

Run from the repository root in PowerShell while `saving-mysql` and `saving-api` are running:

```powershell
./scripts/backup.ps1
```

The script briefly stops `saving-web` while it captures both files, leaving API background work available to archive the private receipt volume; it restarts the web service afterward. The pause prevents browser requests from changing attached receipts during capture. It writes a timestamped folder under `backups/` with a MySQL dump, a compressed archive of receipt images, and a manifest. The folder is ignored by Git because it contains private financial data. Store a copy on encrypted storage with access limited to the family owner. The script does not encrypt the backup itself.

Use an external schedule to run it regularly and keep more than one dated copy. Before upgrades, create an extra backup and confirm both files exist and have nonzero size.

## Restore a backup

Recovery replaces the live financial database and receipt archive. First make a new backup of the current state. Then use a known-good backup folder and run each command from the repository root in PowerShell. Keep the Cloudflare Tunnel profile stopped throughout recovery.

```powershell
$backup = (Resolve-Path '.\backups\YYYYMMDD-HHMMSS').Path
if (!(Test-Path (Join-Path $backup 'mysql.sql')) -or !(Test-Path (Join-Path $backup 'receipts.tar.gz'))) { throw 'Backup files are missing.' }
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

- A backup was restored into a disposable MySQL container and the schema migrations and row counts matched. The bundled receipt archive was readable and extracted; the live backup had no receipt rows or image files, so recovery of a real attached image still needs a fixture-based drill.
- Backups are not encrypted by the script. Protect them with encrypted host storage and access controls.
- There is no automated scheduler or offsite backup destination configured by the application.
