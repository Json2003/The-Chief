[CmdletBinding()]
param([string]$BackendRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path)
$ErrorActionPreference='Stop'
$backendRootPath=(Resolve-Path -LiteralPath $BackendRoot).Path
$backendPath=Join-Path $backendRootPath 'apps\administration-console\server.mjs'
if(-not (Test-Path -LiteralPath $backendPath -PathType Leaf)){throw 'Cheverton backend not found at the selected root.'}
$node=(Get-Command node.exe -ErrorAction Stop).Source
$entry=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'the-chief.mjs')).Path
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -BackendRoot "{1}"' -f (Join-Path $PSScriptRoot 'Start-TheChief.ps1'),$backendRootPath
$action=New-ScheduledTaskAction -Execute (Get-Command powershell.exe).Source -Argument $arguments -WorkingDirectory $backendRootPath
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $owner
$principal=New-ScheduledTaskPrincipal -UserId $owner -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'The Chief' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Independent Cheverton orchestration supervisor; does not open the console.' -Force | Out-Null
Start-ScheduledTask -TaskName 'The Chief'
Write-Output 'The Chief is installed for this Windows sign-in and started. The console task queue remains in its saved pause/resume state.'
