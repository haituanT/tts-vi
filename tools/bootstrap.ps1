[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$backendDir = Join-Path $projectRoot 'Backend'
$frontendDir = Join-Path $projectRoot 'Frontend'
$requirementsPath = Join-Path $backendDir 'requirements.txt'
$runtimeDir = Join-Path $frontendDir '.dubflow'
$pythonPathFile = Join-Path $runtimeDir 'python-path.txt'

function Write-Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Refresh-ProcessPath {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $parts = @($userPath, $machinePath) | Where-Object { $_ } | ForEach-Object { $_ -split ';' } | Where-Object { $_ }
  $env:Path = ($parts -join ';')
}

function Command-Path([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  return ''
}

function Invoke-WingetInstall([string]$PackageId) {
  $winget = Command-Path 'winget.exe'
  if (-not $winget) {
    throw "winget is not available. Install App Installer from Microsoft Store, then run this file again. Missing package: $PackageId"
  }

  Write-Host "Installing $PackageId with winget ..." -ForegroundColor Yellow
  & $winget install --id $PackageId --exact --accept-source-agreements --accept-package-agreements --silent
  if ($LASTEXITCODE -ne 0) {
    throw "winget could not install $PackageId (exit code $LASTEXITCODE)."
  }
  Refresh-ProcessPath
}

function Resolve-Node {
  Refresh-ProcessPath
  $node = Command-Path 'node.exe'
  $npm = Command-Path 'npm.cmd'
  if (-not $node -or -not $npm) {
    Invoke-WingetInstall 'OpenJS.NodeJS.LTS'
    $node = Command-Path 'node.exe'
    $npm = Command-Path 'npm.cmd'
  }
  if (-not $node -or -not $npm) {
    throw 'Node.js/npm is not available after installation.'
  }
  Write-Host "Node: $(& $node --version); npm: $(& $npm --version)"
  return @{ Node = $node; Npm = $npm }
}

function Invoke-NpmInstall([string]$Directory, [string]$Label, [string]$ProbePackage, [string]$NpmPath) {
  $packageLock = Join-Path $Directory 'package-lock.json'
  $nodeModules = Join-Path $Directory 'node_modules'
  $probePath = Join-Path $nodeModules $ProbePackage
  $modulesLock = Join-Path $nodeModules '.package-lock.json'
  $ready = $false
  if ((Test-Path -LiteralPath $packageLock) -and (Test-Path -LiteralPath $probePath) -and (Test-Path -LiteralPath $modulesLock)) {
    $ready = (Get-Item -LiteralPath $modulesLock).LastWriteTimeUtc -ge (Get-Item -LiteralPath $packageLock).LastWriteTimeUtc
  }

  if ($ready) {
    Write-Host "$Label dependencies are already installed."
    return
  }

  if (-not (Test-Path -LiteralPath $packageLock)) {
    throw "$Label is missing package-lock.json."
  }

  Write-Step "Installing $Label dependencies with npm ci"
  Push-Location $Directory
  try {
    & $NpmPath ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
      throw "npm ci failed for $Label (exit code $LASTEXITCODE)."
    }
  } finally {
    Pop-Location
  }
}

function Test-PythonExecutable([string]$Path) {
  if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $false }
  try {
    & $Path --version *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Resolve-Python {
  $bundled = Join-Path $projectRoot 'python_embed\python.exe'
  if (Test-PythonExecutable $bundled) {
    return $bundled
  }

  Refresh-ProcessPath
  $system = Command-Path 'python.exe'
  if (Test-PythonExecutable $system) {
    return $system
  }

  $pyLauncher = Command-Path 'py.exe'
  if ($pyLauncher) {
    $resolved = (& $pyLauncher -3.11 -c 'import sys; print(sys.executable)' 2>$null | Select-Object -Last 1).Trim()
    if (Test-PythonExecutable $resolved) {
      return $resolved
    }
  }

  Invoke-WingetInstall 'Python.Python.3.11'
  Refresh-ProcessPath
  $system = Command-Path 'python.exe'
  if (Test-PythonExecutable $system) {
    return $system
  }

  $pyLauncher = Command-Path 'py.exe'
  if ($pyLauncher) {
    $resolved = (& $pyLauncher -3.11 -c 'import sys; print(sys.executable)' 2>$null | Select-Object -Last 1).Trim()
    if (Test-PythonExecutable $resolved) {
      return $resolved
    }
  }

  throw 'Python 3.11 is not available after installation.'
}

function Invoke-Python([string]$PythonPath, [string[]]$Arguments) {
  & $PythonPath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Python command failed (exit code $LASTEXITCODE): $($Arguments -join ' ')"
  }
}

function Find-YtDlpExecutable([string]$PythonPath) {
  $candidates = @()
  $command = Command-Path 'yt-dlp.exe'
  if ($command) { $candidates += $command }

  $pythonDir = Split-Path -Parent $PythonPath
  $candidates += Join-Path $pythonDir 'Scripts\yt-dlp.exe'
  $scriptsPath = (& $PythonPath -c "import sysconfig; print(sysconfig.get_path('scripts'))" 2>$null | Select-Object -Last 1).Trim()
  if ($scriptsPath) { $candidates += Join-Path $scriptsPath 'yt-dlp.exe' }

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  return ''
}

try {
  Write-Host 'DubFlow first-run setup' -ForegroundColor Green
  Write-Host "Project: $projectRoot"

  $node = Resolve-Node
  Invoke-NpmInstall $backendDir 'Backend' 'express\package.json' $node.Npm
  Invoke-NpmInstall $frontendDir 'Frontend' 'next\package.json' $node.Npm

  Write-Step 'Preparing FFmpeg and ffprobe from the installed Node packages'
  $ffmpegSource = Join-Path $backendDir 'node_modules\ffmpeg-static\ffmpeg.exe'
  $ffprobeSource = Join-Path $backendDir 'node_modules\ffprobe-static\bin\win32\x64\ffprobe.exe'
  if (-not (Test-Path -LiteralPath $ffmpegSource) -or -not (Test-Path -LiteralPath $ffprobeSource)) {
    throw 'FFmpeg static binaries were not found after Backend npm install.'
  }
  $ffmpegBin = Join-Path $projectRoot 'tools\ffmpeg\dist\bin'
  New-Item -ItemType Directory -Force -Path $ffmpegBin | Out-Null
  Copy-Item -LiteralPath $ffmpegSource -Destination (Join-Path $ffmpegBin 'ffmpeg.exe') -Force
  Copy-Item -LiteralPath $ffprobeSource -Destination (Join-Path $ffmpegBin 'ffprobe.exe') -Force

  Write-Step 'Preparing Python runtime and local Python packages'
  $python = Resolve-Python
  $isBundledPython = $python.StartsWith((Join-Path $projectRoot 'python_embed'), [StringComparison]::OrdinalIgnoreCase)
  try {
    Invoke-Python $python @('-m', 'pip', '--version')
  } catch {
    Invoke-Python $python @('-m', 'ensurepip', '--upgrade')
  }
  $pipArgs = @('-m', 'pip', 'install', '--disable-pip-version-check', '-r', $requirementsPath)
  if (-not $isBundledPython) { $pipArgs += '--user' }
  Invoke-Python $python $pipArgs
  New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
  Set-Content -LiteralPath $pythonPathFile -Value $python -Encoding UTF8
  $env:DUBFLOW_PYTHON = $python
  Write-Host "Python: $python"

  Write-Step 'Preparing yt-dlp'
  $ytDlpDir = Join-Path $projectRoot 'tools\yt-dlp'
  New-Item -ItemType Directory -Force -Path $ytDlpDir | Out-Null
  $ytDlp = Find-YtDlpExecutable $python
  if (-not $ytDlp) {
    $ytDlpPipArgs = @('-m', 'pip', 'install', '--disable-pip-version-check', 'yt-dlp')
    if (-not $isBundledPython) { $ytDlpPipArgs += '--user' }
    Invoke-Python $python $ytDlpPipArgs
    Refresh-ProcessPath
    $ytDlp = Find-YtDlpExecutable $python
  }
  if ($ytDlp) {
    Copy-Item -LiteralPath $ytDlp -Destination (Join-Path $ytDlpDir 'yt-dlp.exe') -Force
  } else {
    throw 'yt-dlp was not found after installation.'
  }

  Write-Host "`nDubFlow setup completed. Starting the app ..." -ForegroundColor Green
  exit 0
} catch {
  Write-Host "`nDubFlow setup failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Fix the message above and run Start DubFlow App.bat again.' -ForegroundColor Yellow
  exit 1
}
