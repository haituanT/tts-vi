$ErrorActionPreference = 'Stop'

$frontendDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$logsDir = Join-Path $frontendDir '.dubflow\logs'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdoutLog = Join-Path $logsDir "desktop-$timestamp.out.log"
$stderrLog = Join-Path $logsDir "desktop-$timestamp.err.log"
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$pythonPathFile = Join-Path $frontendDir '.dubflow\python-path.txt'

if (Test-Path -LiteralPath $pythonPathFile) {
  $configuredPython = (Get-Content -LiteralPath $pythonPathFile -Raw).Trim()
  if ($configuredPython -and (Test-Path -LiteralPath $configuredPython)) {
    $env:DUBFLOW_PYTHON = $configuredPython
  }
}

New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

Start-Process `
  -FilePath $nodePath `
  -ArgumentList @('electron/start-app.js') `
  -WorkingDirectory $frontendDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog
