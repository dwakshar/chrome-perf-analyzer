$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"
$artifacts = Join-Path $root "artifacts"
$archive = Join-Path $artifacts "chrome-perf-analyzer.zip"

if (-not (Test-Path $dist)) {
  throw "dist/ is missing. Run npm run build:prod first."
}

if (-not (Test-Path $artifacts)) {
  New-Item -ItemType Directory -Path $artifacts | Out-Null
}

if (Test-Path $archive) {
  Remove-Item $archive -Force
}

Compress-Archive -Path "$dist\*" -DestinationPath $archive -Force
Write-Output "Created $archive"
