param(
    [string]$ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) ".acme.json"),
    [switch]$Staging
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = if ([System.IO.Path]::IsPathRooted($ConfigPath)) { $ConfigPath } else { Join-Path $projectRoot $ConfigPath }

if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "ACME configuration not found: $configPath. Copy config/acme.example.json to .acme.json first."
}

$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
function Resolve-ProjectPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
    return Join-Path $projectRoot $Path
}

$wacsPath = Resolve-ProjectPath ([string]$config.wacsPath)
if (-not $wacsPath) { $wacsPath = Get-Command wacs.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1 }
if (-not $wacsPath -or -not (Test-Path -LiteralPath $wacsPath -PathType Leaf)) {
    throw "win-acme was not found. Set wacsPath in $configPath or add wacs.exe to PATH."
}

$domains = @($config.domains | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
$commonName = [string]$config.commonName
$validation = [string]$config.validation
if ($domains.Count -eq 0 -or [string]::IsNullOrWhiteSpace($commonName)) { throw "domains and commonName are required in $configPath" }
if ($validation -notin @("Tencent")) { throw "Only Tencent DNS validation is currently supported; set validation to Tencent" }
if (-not $config.tencent -or [string]::IsNullOrWhiteSpace([string]$config.tencent.apiId) -or [string]::IsNullOrWhiteSpace([string]$config.tencent.apiKey)) { throw "tencent.apiId and tencent.apiKey are required for Tencent validation" }

$certificateDirectory = Resolve-ProjectPath ([string]$config.directory)
if (-not $certificateDirectory) { throw "directory is required in $configPath" }
New-Item -ItemType Directory -Path $certificateDirectory -Force | Out-Null
$reloadScript = Resolve-ProjectPath ([string]$config.reloadScript)
$pemFileName = if ([string]::IsNullOrWhiteSpace([string]$config.pemFileName)) { $commonName } else { [string]$config.pemFileName }

$arguments = @(
    "--source", "manual",
    "--host", ($domains -join ","),
    "--commonname", $commonName,
    "--validation", $validation,
    "--tencentapiid", ([string]$config.tencent.apiId),
    "--tencentapikey", ([string]$config.tencent.apiKey),
    "--store", "pemfiles",
    "--pemfilespath", $certificateDirectory,
    "--pemfilesname", $pemFileName,
    "--installation", "none",
    "--accepttos"
)

$useStaging = $Staging -or ([bool]$config.staging)
$createRenewalTask = [bool]$config.createRenewalTask
if ($useStaging) {
    $arguments += @("--baseuri", "https://acme-staging-v02.api.letsencrypt.org/", "--notaskscheduler")
} elseif ($createRenewalTask) {
    if (-not $reloadScript) { throw "reloadScript is required when createRenewalTask is enabled" }
    $arguments[($arguments.IndexOf("none"))] = "script"
    $arguments += @("--script", $reloadScript, "--setuptaskscheduler")
} else {
    $arguments += "--notaskscheduler"
}

& $wacsPath @arguments
exit $LASTEXITCODE
