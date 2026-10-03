[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$BackendRoot)
$ErrorActionPreference='Stop'
$backendRootPath=(Resolve-Path -LiteralPath $BackendRoot).Path
$backendPath=Join-Path $backendRootPath 'apps\administration-console\server.mjs'
if(-not (Test-Path -LiteralPath $backendPath -PathType Leaf)){throw 'Cheverton backend not found.'}
$node=(Get-Command node.exe -ErrorAction Stop).Source
$env:CHIEF_WORKDIR=$backendRootPath
$env:CHIEF_BACKEND_PATH=$backendPath
if(-not $env:CHEVERTON_CODEX_EXECUTABLE){
  $codex=Get-Command codex.exe -ErrorAction SilentlyContinue
  if(-not $codex){
    $codexRoot=Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if(Test-Path -LiteralPath $codexRoot -PathType Container){
      $codex=Get-ChildItem -LiteralPath $codexRoot -Filter codex.exe -File -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    }
  }
  if($codex){$env:CHEVERTON_CODEX_EXECUTABLE=$codex.Source -as [string];if(-not $env:CHEVERTON_CODEX_EXECUTABLE){$env:CHEVERTON_CODEX_EXECUTABLE=$codex.FullName}}
}
& $node (Join-Path $PSScriptRoot 'the-chief.mjs')
exit $LASTEXITCODE
