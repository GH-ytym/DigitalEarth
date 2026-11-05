param()
$ErrorActionPreference = 'Stop'
$taskRepo = Split-Path -Parent $PSScriptRoot
foreach ($taskSecretName in @('db-password.local', 'api-password.local')) {
  $taskSecret = Join-Path $PSScriptRoot $taskSecretName
  if (-not (Test-Path -LiteralPath $taskSecret)) {
    $taskBytes = [byte[]]::new(32)
    $taskRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $taskRng.GetBytes($taskBytes) } finally { $taskRng.Dispose() }
    $taskPassword = [BitConverter]::ToString($taskBytes).Replace('-', '').ToLowerInvariant()
    [System.IO.File]::WriteAllText($taskSecret, $taskPassword)
    Write-Output ('Created ignored local password file: ' + $taskSecretName)
  }
}
$taskReports = [System.IO.Path]::GetFullPath((Join-Path $taskRepo '..\work\geonames'))
[System.IO.Directory]::CreateDirectory($taskReports) | Out-Null
Write-Output 'Local database files are ready. Run docker compose up -d --wait db from the repository root.'
