$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$envFile = Join-Path ([IO.Path]::GetTempPath()) "saving-tunnel-smoke-$([guid]::NewGuid().ToString('N')).env"
$fixture = @(
  'APP_BASE_URL=https://ounjai.finance'
  'COOKIE_SECURE=true'
  'MYSQL_PASSWORD=app-test-password-0123456789'
  'MYSQL_ROOT_PASSWORD=root-test-password-9876543210'
  'CLOUDFLARE_TUNNEL_TOKEN=synthetic-tunnel-token-for-test-only'
  'SMTP_HOST=smtp.example.test'
  'SMTP_PORT=587'
  'SMTP_SECURE=false'
  'SMTP_FROM=noreply@example.test'
  'SYSTEM_ADMIN_EMAIL=admin@example.test'
)

Push-Location $repoRoot
try {
  Set-Content -LiteralPath $envFile -Value $fixture -Encoding ascii
  podman compose --env-file $envFile --profile tunnel run --rm --no-deps tunnel-preflight
  if ($LASTEXITCODE -ne 0) { throw 'Compose preflight rejected a valid synthetic configuration.' }

  podman compose --env-file $envFile --profile tunnel run --rm --no-deps -e APP_BASE_URL=http://ounjai.finance tunnel-preflight
  if ($LASTEXITCODE -eq 0) { throw 'Compose preflight accepted an insecure synthetic configuration.' }
  $global:LASTEXITCODE = 0
  Write-Output 'PASS Compose preflight accepts valid and rejects insecure synthetic configurations.'
} finally {
  Remove-Item -LiteralPath $envFile -Force -ErrorAction SilentlyContinue
  Pop-Location
}
