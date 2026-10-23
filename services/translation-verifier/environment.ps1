[CmdletBinding()]
param(
    [string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'translation-verifier-runtime'),
    [switch]$Persist,
    [switch]$LiveModel
)

$ErrorActionPreference = 'Stop'
$runtimeDirectory = [System.IO.Path]::GetFullPath($RuntimeRoot)
$runtimeBins = @(
    (Join-Path $runtimeDirectory 'apache-maven-3.9.11\bin'),
    (Join-Path $runtimeDirectory 'gradle-8.14.3\bin'),
    (Join-Path $runtimeDirectory 'python\Scripts'),
    (Join-Path $runtimeDirectory 'node\node_modules\.bin'),
    (Join-Path $runtimeDirectory 'go\bin'),
    (Join-Path $runtimeDirectory 'cargo\bin')
)
foreach ($runtimeBin in $runtimeBins) {
    if (-not (Test-Path -LiteralPath $runtimeBin -PathType Container)) {
        throw "Runtime directory is missing: $runtimeBin"
    }
}

$runtimeVariables = @{
    TRANSLATION_VERIFIER_RUNNER_DEPS = $runtimeDirectory
    RUSTUP_HOME = (Join-Path $runtimeDirectory 'rustup')
    CARGO_HOME = (Join-Path $runtimeDirectory 'cargo')
    GOPATH = (Join-Path $runtimeDirectory 'go-work')
    CODE_INTELLIGENCE_SEEKDB_DATABASE = 'forexplore_asset_verifier_cpu_20261023'
    CODE_INTELLIGENCE_EMBEDDING_URL = 'http://127.0.0.1:4021/v1/embeddings'
    CODE_INTELLIGENCE_EMBEDDING_MODEL = 'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78'
    CODE_INTELLIGENCE_EMBEDDING_SUPPORTS_DIMENSIONS = 'false'
    CODE_INTELLIGENCE_EMBEDDING_QUERY_PREFIX = 'query: '
    CODE_INTELLIGENCE_EMBEDDING_DOCUMENT_PREFIX = 'passage: '
    CODE_INTELLIGENCE_EMBEDDING_VARIANT = 'cpu-q8'
    FOREXPLORE_EMBEDDING_DEVICE = 'cpu'
    FOREXPLORE_EMBEDDING_DTYPE = 'q8'
    CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION = '384'
    CODE_INTELLIGENCE_RERANK_URL = 'http://127.0.0.1:4022/v1/rerank'
    CODE_INTELLIGENCE_RERANK_MODEL = 'Xenova/bge-reranker-base@280bcc27a84e0b898c251e06fddb25171bd9b101'
}

$previousRuntimeValues = @{
    CODE_INTELLIGENCE_SEEKDB_DATABASE = @('forexplore_asset_verifier_20261022')
    CODE_INTELLIGENCE_EMBEDDING_VARIANT = @('dml-fp16')
    FOREXPLORE_EMBEDDING_DEVICE = @('dml', 'directml')
    FOREXPLORE_EMBEDDING_DTYPE = @('fp16')
}

$existingPaths = @($env:PATH -split ';' | Where-Object { $_ -and $_ -notin $runtimeBins })
$env:PATH = (@($runtimeBins) + $existingPaths) -join ';'
foreach ($runtimeVariable in $runtimeVariables.GetEnumerator()) {
    $currentValue = [Environment]::GetEnvironmentVariable($runtimeVariable.Key, 'Process')
    if (-not $currentValue -or ($previousRuntimeValues.ContainsKey($runtimeVariable.Key) -and $currentValue -in $previousRuntimeValues[$runtimeVariable.Key])) {
        [Environment]::SetEnvironmentVariable($runtimeVariable.Key, $runtimeVariable.Value, 'Process')
    }
}

if (($env:CODE_INTELLIGENCE_EMBEDDING_VARIANT -eq 'cpu-q8' -or $env:CODE_INTELLIGENCE_SEEKDB_DATABASE -eq 'forexplore_asset_verifier_cpu_20261023') -and
    ($env:FOREXPLORE_EMBEDDING_DEVICE -ne 'cpu' -or $env:FOREXPLORE_EMBEDDING_DTYPE -ne 'q8' -or $env:CODE_INTELLIGENCE_EMBEDDING_VARIANT -ne 'cpu-q8')) {
    throw 'The CPU database and cpu-q8 variant require FOREXPLORE_EMBEDDING_DEVICE=cpu and FOREXPLORE_EMBEDDING_DTYPE=q8. Use a separate database and matching variant for custom inference.'
}

if ($LiveModel -and -not $env:DEEPSEEK_MODEL) {
    $env:DEEPSEEK_MODEL = 'deepseek-flash'
}
if ($LiveModel -and -not $env:ADAPTATION_CODEX_MODEL) {
    $env:ADAPTATION_CODEX_MODEL = $env:DEEPSEEK_MODEL
}

if ($Persist) {
    $userPaths = @([Environment]::GetEnvironmentVariable('Path', 'User') -split ';' | Where-Object { $_ -and $_ -notin $runtimeBins })
    [Environment]::SetEnvironmentVariable('Path', (@($runtimeBins) + $userPaths) -join ';', 'User')
    foreach ($runtimeVariable in $runtimeVariables.GetEnumerator()) {
        $currentValue = [Environment]::GetEnvironmentVariable($runtimeVariable.Key, 'User')
        if (-not $currentValue -or ($previousRuntimeValues.ContainsKey($runtimeVariable.Key) -and $currentValue -in $previousRuntimeValues[$runtimeVariable.Key])) {
            [Environment]::SetEnvironmentVariable($runtimeVariable.Key, $runtimeVariable.Value, 'User')
        }
    }
}

Write-Host "Runtime environment ready: $runtimeDirectory"
