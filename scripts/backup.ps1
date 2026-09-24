param(
  [string]$Destination = (Join-Path (Split-Path $PSScriptRoot -Parent) 'backups')
)

$ErrorActionPreference = 'Stop'
$mysqlContainer = 'saving-mysql'
$apiContainer = 'saving-api'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$backupDirectory = Join-Path $Destination $stamp

foreach ($container in @($mysqlContainer, $apiContainer)) {
  $running = podman inspect --format '{{.State.Running}}' $container
  if ($LASTEXITCODE -ne 0 -or $running -ne 'true') { throw "Container $container must be running before backup." }
}

New-Item -ItemType Directory -Path $backupDirectory | Out-Null
$webStopped = $false
try {
  podman compose stop web | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not stop web before backup.' }
  $webStopped = $true
  Start-Sleep -Seconds 2

  podman exec $mysqlContainer sh -c 'umask 077; printf "[client]\nuser=root\npassword=%s\n" "$MYSQL_ROOT_PASSWORD" > /tmp/saving-backup-client.cnf; mysqldump --defaults-extra-file=/tmp/saving-backup-client.cnf --single-transaction --routines --triggers --hex-blob "$MYSQL_DATABASE" > /tmp/saving-mysql-backup.sql'
  if ($LASTEXITCODE -ne 0) { throw 'MySQL dump failed.' }
  podman cp "${mysqlContainer}:/tmp/saving-mysql-backup.sql" (Join-Path $backupDirectory 'mysql.sql')
  if ($LASTEXITCODE -ne 0) { throw 'Could not copy MySQL dump from container.' }

  podman exec $apiContainer sh -c 'tar -czf /tmp/saving-receipts-backup.tar.gz -C "$RECEIPT_STORAGE_PATH" .'
  if ($LASTEXITCODE -ne 0) { throw 'Receipt volume archive failed.' }
  podman cp "${apiContainer}:/tmp/saving-receipts-backup.tar.gz" (Join-Path $backupDirectory 'receipts.tar.gz')
  if ($LASTEXITCODE -ne 0) { throw 'Could not copy receipt archive from container.' }

  podman exec $mysqlContainer rm -f /tmp/saving-mysql-backup.sql | Out-Null
  podman exec $apiContainer rm -f /tmp/saving-receipts-backup.tar.gz | Out-Null
  foreach ($file in @('mysql.sql', 'receipts.tar.gz')) {
    if ((Get-Item -LiteralPath (Join-Path $backupDirectory $file)).Length -eq 0) { throw "Backup file $file is empty." }
  }
  @(
    "CreatedAt=$((Get-Date).ToString('o'))"
    "DatabaseContainer=$mysqlContainer"
    "ReceiptContainer=$apiContainer"
    'Files=mysql.sql,receipts.tar.gz'
  ) | Set-Content -LiteralPath (Join-Path $backupDirectory 'manifest.txt') -Encoding utf8
  Write-Output "Backup created at $backupDirectory"
} catch {
  foreach ($file in @('mysql.sql', 'receipts.tar.gz', 'manifest.txt')) {
    Remove-Item -LiteralPath (Join-Path $backupDirectory $file) -Force -ErrorAction SilentlyContinue
  }
  Write-Error $_
  throw
} finally {
  podman exec saving-mysql rm -f /tmp/saving-mysql-backup.sql 2>$null | Out-Null
  podman exec saving-mysql rm -f /tmp/saving-backup-client.cnf 2>$null | Out-Null
  podman exec saving-api rm -f /tmp/saving-receipts-backup.tar.gz 2>$null | Out-Null
  if ($webStopped) {
    podman compose start web | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Error 'Backup finished, but web could not be restarted. Run podman compose up -d web.' }
  }
}
