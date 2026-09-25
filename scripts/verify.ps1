$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent

Push-Location $repoRoot
try {
  node --check api/server.js
  if ($LASTEXITCODE -ne 0) { throw 'API syntax check failed.' }

  node --test api/receipt-ocr.test.js
  if ($LASTEXITCODE -ne 0) { throw 'Receipt OCR parser tests failed.' }

  node --test scripts/tunnel-preflight.test.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Tunnel preflight tests failed.' }

  & (Join-Path $PSScriptRoot 'test-tunnel-compose.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'Compose tunnel preflight test failed.' }

  & (Join-Path $PSScriptRoot 'integration.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'Disposable MySQL integration suite failed.' }

  Push-Location (Join-Path $repoRoot 'web')
  try {
    npm run lint
    if ($LASTEXITCODE -ne 0) { throw 'Web lint failed.' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Web production build failed.' }
  } finally {
    Pop-Location
  }

  podman compose --profile tunnel config --quiet
  if ($LASTEXITCODE -ne 0) { throw 'Podman Compose configuration is invalid.' }
} finally {
  Pop-Location
}
