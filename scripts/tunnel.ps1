param(
  [ValidateSet('start', 'stop', 'validate')]
  [string]$Action = 'start',
  [string]$EnvFile = (Join-Path (Split-Path $PSScriptRoot -Parent) '.env')
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
Push-Location $repoRoot
try {
  if ($Action -eq 'stop') {
    podman compose --profile tunnel stop cloudflared
  } else {
    if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw 'Required .env file was not found.' }
    $resolvedEnvFile = (Resolve-Path -LiteralPath $EnvFile).Path
    if ($Action -eq 'validate') {
    podman compose --env-file $resolvedEnvFile --profile tunnel run --rm tunnel-preflight
    } else {
      podman compose --env-file $resolvedEnvFile --profile tunnel up -d --force-recreate tunnel-preflight cloudflared
    }
  }
  if ($LASTEXITCODE -ne 0) { throw "Podman Compose $Action command failed (exit $LASTEXITCODE)." }
} finally {
  Pop-Location
}
