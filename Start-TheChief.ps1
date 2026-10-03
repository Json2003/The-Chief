[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$BackendRoot)
$ErrorActionPreference='Stop'
$backendRootPath=(Resolve-Path -LiteralPath $BackendRoot).Path
$backendPath=Join-Path $backendRootPath 'apps\administration-console\server.mjs'
if(-not (Test-Path -LiteralPath $backendPath -PathType Leaf)){throw 'Cheverton backend not found.'}
$node=(Get-Command node.exe -ErrorAction Stop).Source
$env:CHIEF_WORKDIR=$backendRootPath
$env:CHIEF_BACKEND_PATH=$backendPath
& $node (Join-Path $PSScriptRoot 'the-chief.mjs')
exit $LASTEXITCODE
