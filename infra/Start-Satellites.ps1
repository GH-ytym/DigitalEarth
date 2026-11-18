$ErrorActionPreference = 'Stop'
$satelliteRepo = Split-Path -Parent $PSScriptRoot
$satelliteService = Join-Path $satelliteRepo 'services/satellites'
$satelliteUvCommand = Get-Command uv -ErrorAction SilentlyContinue
$satelliteUv = if ($satelliteUvCommand) { $satelliteUvCommand.Source } else { 'C:/Users/MyPC/AppData/Local/Microsoft/WinGet/Links/uv.exe' }
Push-Location -LiteralPath $satelliteService
try {
    & $satelliteUv sync --locked
    if ($LASTEXITCODE -ne 0) { throw 'Satellite dependency sync failed.' }
    & $satelliteUv run python initialize.py
    if ($LASTEXITCODE -ne 0) { throw 'Satellite storage initialization failed.' }
    $satelliteBuild = -not (Test-Path -LiteralPath 'build/satellites.dll')
    if (-not $satelliteBuild) {
        $satelliteStamp = (Get-Item -LiteralPath 'build/satellites.dll').LastWriteTimeUtc
        $satelliteBuild = @(Get-ChildItem native -Recurse -File | Where-Object { $_.Extension -in '.cpp','.h' -and $_.LastWriteTimeUtc -gt $satelliteStamp }).Count -gt 0
    }
    if ($satelliteBuild) {
        & $satelliteUv run python build_native.py
        if ($LASTEXITCODE -ne 0) { throw 'C++ SGP4 DLL build failed.' }
    }
    docker compose --env-file .env -f ../../infra/satellites.compose.yaml up -d --wait
    if ($LASTEXITCODE -ne 0) { throw 'Satellite storage containers failed to start.' }
    Write-Host 'Satellite API: 127.0.0.1:8093. Use the existing frontend at 127.0.0.1:5173, then select Satellites.'
    & $satelliteUv run uvicorn app:app --host 127.0.0.1 --port 8093
} finally {
    Pop-Location
}
