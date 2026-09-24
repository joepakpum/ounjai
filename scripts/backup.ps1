param(
  [string]$Destination = (Join-Path (Split-Path $PSScriptRoot -Parent) 'backups')
)

$ErrorActionPreference = 'Stop'
$mysqlContainer = 'saving-mysql'
$apiContainer = 'saving-api'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDirectory = Join-Path $Destination $stamp

foreach ($container in @($mysqlContainer, $apiContainer)) {
  $running = podman inspect --format '{{.State.Running}}' $container
  if ($LASTEXITCODE -ne 0 -or $running -ne 'true') { throw "Container $container must be running before backup." }
}

New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
try {
  podman exec $mysqlContainer sh -c 'mysqldump --user=root --password="$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers --hex-blob "$MYSQL_DATABASE" > /tmp/saving-mysql-backup.sql'
  if ($LASTEXITCODE -ne 0) { throw 'MySQL dump failed.' }
  podman cp "${mysqlContainer}:/tmp/saving-mysql-backup.sql" (Join-Path $backupDirectory 'mysql.sql')
  if ($LASTEXITCODE -ne 0) { throw 'Could not copy MySQL dump from container.' }

  podman exec $apiContainer sh -c 'tar -czf /tmp/saving-receipts-backup.tar.gz -C "$RECEIPT_STORAGE_PATH" .'
  if ($LASTEXITCODE -ne 0) { throw 'Receipt volume archive failed.' }
  podman cp "${apiContainer}:/tmp/saving-receipts-backup.tar.gz" (Join-Path $backupDirectory 'receipts.tar.gz')
  if ($LASTEXITCODE -ne 0) { throw 'Could not copy receipt archive from container.' }

  podman exec $mysqlContainer rm -f /tmp/saving-mysql-backup.sql | Out-Null
  podman exec $apiContainer rm -f /tmp/saving-receipts-backup.tar.gz | Out-Null
  @(
    "CreatedAt=$((Get-Date).ToString('o'))"
    "DatabaseContainer=$mysqlContainer"
    "ReceiptContainer=$apiContainer"
    'Files=mysql.sql,receipts.tar.gz'
  ) | Set-Content -LiteralPath (Join-Path $backupDirectory 'manifest.txt') -Encoding utf8
  Write-Output "Backup created at $backupDirectory"
} catch {
  Write-Error $_
  throw
}
