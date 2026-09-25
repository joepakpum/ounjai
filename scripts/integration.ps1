$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$projectName = 'saving-integration-check'
$composeArgs = @('-p', $projectName, '-f', (Join-Path $repoRoot 'compose.integration.yaml'))
$testExitCode = 1

Push-Location $repoRoot
try {
  podman compose @composeArgs up --build --abort-on-container-exit --exit-code-from api-tests api-tests
  $testExitCode = $LASTEXITCODE
  if ($testExitCode -ne 0) { podman compose @composeArgs logs --no-color }
} finally {
  podman compose @composeArgs down --volumes --remove-orphans
  if ($LASTEXITCODE -ne 0 -and $testExitCode -eq 0) { $testExitCode = $LASTEXITCODE }
  Pop-Location
}

if ($testExitCode -ne 0) { throw "Disposable MySQL integration suite failed (exit $testExitCode)." }
Write-Host 'Disposable MySQL integration suite passed; its containers and volumes were removed.'
