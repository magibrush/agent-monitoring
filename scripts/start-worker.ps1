$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location $projectRoot
if (-not (Test-Path '.secrets')) { New-Item -ItemType Directory -Path '.secrets' | Out-Null }
if (-not (Test-Path '.secrets/anthropic.key')) { New-Item -ItemType File -Path '.secrets/anthropic.key' | Out-Null }
& .venv/Scripts/python.exe -m backend.safety_worker --workers 2
