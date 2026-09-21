param(
    [ValidateRange(1, 65535)][int]$Port = 8001,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $projectRoot

foreach ($command in @('uv', 'node', 'npm.cmd')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Missing $command. Install uv and Node.js 22.12+ (including npm 10+), then rerun this command. See docs/demo.md."
    }
}
$nodeVersion = & node --version
if ($LASTEXITCODE -ne 0 -or [version]($nodeVersion.TrimStart('v')) -lt [version]'22.12.0') {
    throw 'Node.js 22.12+ is required. Update Node and open a new terminal.'
}
$npmVersion = & npm.cmd --version
if ($LASTEXITCODE -ne 0 -or [int]($npmVersion.Split('.')[0]) -lt 10) { throw 'npm 10+ is required.' }

Write-Host 'Preparing the synthetic Relay demo. First run downloads locked dependencies.'
$previousEnvironment = $env:UV_PROJECT_ENVIRONMENT
try {
    $env:UV_PROJECT_ENVIRONMENT = Join-Path $projectRoot 'data/demo/venv'
    & uv sync --locked --python 3.11
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed. Check the error above and rerun.' }
} finally { $env:UV_PROJECT_ENVIRONMENT = $previousEnvironment }
Push-Location frontend
try {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Dashboard build failed.' }
} finally { Pop-Location }

$demoArgs = @('-m', 'backend.demo', '--port', "$Port")
if ($NoBrowser) { $demoArgs += '--no-browser' }
& data/demo/venv/Scripts/python.exe @demoArgs
if ($LASTEXITCODE -ne 0) { throw 'Demo stopped with an error. See the message above.' }
