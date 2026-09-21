$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $projectRoot
$bundledNode = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin'
if (Test-Path (Join-Path $bundledNode 'node.exe')) { $env:PATH = "$bundledNode;$env:PATH" }
$env:UV_CACHE_DIR = Join-Path $projectRoot '.uv-cache'
$env:npm_config_cache = Join-Path $projectRoot '.npm-cache'
foreach ($command in @('uv', 'node', 'npm.cmd')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Missing $command. Install uv and Node.js 22.12+ (including npm 10+). See docs/setup.md."
    }
}
$nodeVersion = & node --version
if ($LASTEXITCODE -ne 0 -or [version]($nodeVersion.TrimStart('v')) -lt [version]'22.12.0') {
    throw 'Node.js 22.12+ is required.'
}
$npmVersion = & npm.cmd --version
if ($LASTEXITCODE -ne 0 -or [int]($npmVersion.Split('.')[0]) -lt 10) { throw 'npm 10+ is required.' }
Write-Host 'Preparing Relay. First run downloads locked dependencies.'
$previousEnvironment = $env:UV_PROJECT_ENVIRONMENT
try {
    $env:UV_PROJECT_ENVIRONMENT = Join-Path $projectRoot '.venv'
    & uv sync --locked --python 3.11
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
} finally { $env:UV_PROJECT_ENVIRONMENT = $previousEnvironment }
if (-not (Test-Path '.secrets')) { New-Item -ItemType Directory -Path '.secrets' | Out-Null }
if (-not (Test-Path '.secrets/anthropic.key')) { New-Item -ItemType File -Path '.secrets/anthropic.key' | Out-Null }
& .venv/Scripts/python.exe -m alembic upgrade head
if ($LASTEXITCODE -ne 0) { throw 'Database migration failed.' }
Push-Location frontend
try {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
    & node node_modules/typescript/bin/tsc -b
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript check failed.' }
    & node node_modules/vite/bin/vite.js build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
} finally { Pop-Location }
Write-Host 'Relay is available at http://127.0.0.1:8000. Press Ctrl+C to stop.'
$safetyWorker = Start-Process -FilePath (Join-Path $projectRoot '.venv/Scripts/python.exe') -ArgumentList '-m', 'backend.safety_worker', '--workers', '2' -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
try {
    & .venv/Scripts/python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
} finally {
    # The Windows venv launcher can own a second Python process.
    Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $safetyWorker.Id -and $_.CommandLine -match 'backend\.safety_worker' } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
    if (-not $safetyWorker.HasExited) { Stop-Process -Id $safetyWorker.Id }
}
