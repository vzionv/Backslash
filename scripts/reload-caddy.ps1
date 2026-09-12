param(
    [string]$ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) ".acme.json")
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = if ([System.IO.Path]::IsPathRooted($ConfigPath)) { $ConfigPath } else { Join-Path $projectRoot $ConfigPath }
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "ACME configuration not found: $configPath"
}
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
function Resolve-ProjectPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
    return Join-Path $projectRoot $Path
}

$caddyPath = Resolve-ProjectPath ([string]$config.caddyPath)
if (-not $caddyPath) { $caddyPath = Get-Command caddy.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1 }
$caddyConfig = Resolve-ProjectPath ([string]$config.caddyConfig)
if (-not $caddyConfig) { $caddyConfig = Join-Path $projectRoot ".backslash-caddy.json" }
if (-not $caddyPath -or -not (Test-Path -LiteralPath $caddyPath -PathType Leaf)) { throw "Caddy was not found; set caddyPath in $configPath or add caddy.exe to PATH" }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "scripts/create-caddy-config.mjs") -PathType Leaf)) { throw "Caddy configuration generator is missing" }

$env:BACKSLASH_HOST = [string]$config.domains[0]
$env:HTTPS_PORT = if ($config.httpsPort) { [string]$config.httpsPort } else { "443" }
$env:WEB_UPSTREAM_HOST = if ($config.webUpstreamHost) { [string]$config.webUpstreamHost } else { "127.0.0.1" }
$env:WEB_UPSTREAM_PORT = if ($config.webUpstreamPort) { [string]$config.webUpstreamPort } else { "3000" }
$env:WS_UPSTREAM_HOST = if ($config.wsUpstreamHost) { [string]$config.wsUpstreamHost } else { "127.0.0.1" }
$env:WS_UPSTREAM_PORT = if ($config.wsUpstreamPort) { [string]$config.wsUpstreamPort } else { "3001" }
$certificateDirectory = Resolve-ProjectPath ([string]$config.directory)
$pemFileName = if ($config.pemFileName) { [string]$config.pemFileName } else { [string]$config.commonName }
$env:CERTIFICATE_FILE = Join-Path $certificateDirectory "$pemFileName-chain.pem"
$env:PRIVATE_KEY_FILE = Join-Path $certificateDirectory "$pemFileName-key.pem"
$env:CADDY_ADMIN = if ($env:CADDY_ADMIN) { $env:CADDY_ADMIN } else { "127.0.0.1:2019" }

if ($caddyConfig -eq (Join-Path $projectRoot ".backslash-caddy.json")) {
    & node (Join-Path $projectRoot "scripts/create-caddy-config.mjs") $caddyConfig
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} elseif (-not (Test-Path -LiteralPath $caddyConfig -PathType Leaf)) {
    throw "Caddy configuration not found: $caddyConfig"
}

$adapter = [string]$config.caddyAdapter
if ([string]::IsNullOrWhiteSpace($adapter) -or $adapter -eq "json") {
    & $caddyPath reload --config $caddyConfig
} else {
    & $caddyPath reload --config $caddyConfig --adapter $adapter
}
exit $LASTEXITCODE
