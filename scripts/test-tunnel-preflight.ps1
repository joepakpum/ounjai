$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
Push-Location $repoRoot
try {
  node --test scripts/tunnel-preflight.test.mjs
  if ($LASTEXITCODE -ne 0) { throw "Tunnel preflight tests failed (exit $LASTEXITCODE)." }
} finally {
  Pop-Location
}
