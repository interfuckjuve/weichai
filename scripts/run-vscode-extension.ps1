[CmdletBinding()]
param(
  [switch]$SkipSeekDb
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$extensionRoot = Join-Path $repoRoot 'apps/vscode-extension'
$composeFile = Join-Path $repoRoot 'services/retrieval-service/docker-compose.yml'
$retrievalEnvFile = Join-Path $repoRoot 'services/retrieval-service/.env'

Set-Location -LiteralPath $repoRoot

# The retrieval service and extension are separate processes but must share
# one module-index writer secret. Prefer explicit process environment, then
# mirror the retrieval service's local .env value into the extension host.
$extensionWriterToken = $env:FOREXPLORE_MODULE_INDEX_WRITER_TOKEN
$retrievalWriterToken = $env:RETRIEVAL_MODULE_INDEX_TOKEN
if ($extensionWriterToken -and $retrievalWriterToken -and
    $extensionWriterToken.Trim() -ne $retrievalWriterToken.Trim()) {
  throw 'FOREXPLORE_MODULE_INDEX_WRITER_TOKEN and RETRIEVAL_MODULE_INDEX_TOKEN must match.'
}
if (-not $extensionWriterToken -and $retrievalWriterToken) {
  $extensionWriterToken = $retrievalWriterToken.Trim()
}
if (-not $retrievalWriterToken -and $extensionWriterToken) {
  $retrievalWriterToken = $extensionWriterToken.Trim()
}
if (-not $extensionWriterToken -and (Test-Path -LiteralPath $retrievalEnvFile -PathType Leaf)) {
  $tokenReader = @'
const { config } = require('dotenv');
config({ path: process.argv[1], quiet: true });
process.stdout.write(process.env.RETRIEVAL_MODULE_INDEX_TOKEN || '');
'@
  $extensionWriterToken = [string](& node -e $tokenReader $retrievalEnvFile)
  $extensionWriterToken = $extensionWriterToken.Trim()
  $retrievalWriterToken = $extensionWriterToken
}
if ($extensionWriterToken) {
  $env:FOREXPLORE_MODULE_INDEX_WRITER_TOKEN = $extensionWriterToken
  $env:RETRIEVAL_MODULE_INDEX_TOKEN = $retrievalWriterToken
} else {
  Write-Warning 'Module-index writer token is unset; reviewed knowledge publication will fail closed.'
}

function Ensure-VsCodeExtension {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ExtensionId
  )

  $codeCommand = Get-Command code -ErrorAction Stop
  $installed = @(& $codeCommand.Source '--list-extensions') |
    ForEach-Object { $_.Trim().ToLowerInvariant() }

  if ($installed -contains $ExtensionId.ToLowerInvariant()) {
    return
  }

  Write-Host "Installing required VS Code extension: $ExtensionId"
  & $codeCommand.Source '--install-extension' $ExtensionId
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install required VS Code extension: $ExtensionId"
  }
}

Ensure-VsCodeExtension -ExtensionId 'redhat.java'

if (-not $SkipSeekDb) {
  docker compose -f $composeFile up -d
  if ($LASTEXITCODE -ne 0) {
    throw "SeekDB startup failed. Exit code: $LASTEXITCODE"
  }
}

# The extension host loads the already-installed workspace dependencies.
npm run build:extension
if ($LASTEXITCODE -ne 0) {
  throw "Extension build failed. Exit code: $LASTEXITCODE"
}

function Start-DevWindow {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Command
  )

  Start-Process -FilePath 'powershell.exe' -WorkingDirectory $repoRoot -ArgumentList @(
    '-NoExit',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    $Command
  ) | Out-Null
}

Start-DevWindow -Command 'npm run dev:retrieval'
Start-DevWindow -Command 'npm run dev:adaptation'

& code ('--extensionDevelopmentPath={0}' -f $extensionRoot)
