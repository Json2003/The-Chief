<#
.SYNOPSIS
  Sets up private phone access to The Chief through Tailscale. Run it yourself.
.DESCRIPTION
  1. Installs Tailscale with winget if it is missing (asks first).
  2. Signs in (a browser opens for you to approve) and starts Tailscale Serve,
     which publishes The Chief to your own tailnet over HTTPS. It never uses Funnel.
  3. Saves your tunnel hostname so The Chief accepts it (no restart needed for this).
  4. Restarts The Chief only if the console reports ready-to-restart, because
     your AGENTS.md says to restart only when paused and idle.
  It does not print or move your intake key or console key.
#>
[CmdletBinding()]
param([switch]$SkipInstall,[switch]$NoRestart)
$ErrorActionPreference='Stop'

function Find-Tailscale {
  $cmd=Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if($cmd){return $cmd.Source}
  $default=Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
  if(Test-Path -LiteralPath $default -PathType Leaf){return $default}
  return $null
}

$ts=Find-Tailscale
if(-not $ts){
  if($SkipInstall){throw 'Tailscale is not installed. Install it from https://tailscale.com/download and run this again.'}
  $answer=Read-Host 'Tailscale is not installed. Install it now with winget? (y/N)'
  if($answer -notmatch '^(y|yes)$'){throw 'Cancelled. Install Tailscale, then run this script again.'}
  winget install --id Tailscale.Tailscale -e --accept-package-agreements --accept-source-agreements
  $ts=Find-Tailscale
  if(-not $ts){throw 'Tailscale installed but tailscale.exe was not found. Open a new PowerShell window and run this again.'}
}

function Get-TsStatus {
  try{return (& $ts status --json 2>$null | ConvertFrom-Json)}catch{return $null}
}
$status=Get-TsStatus
if(-not $status -or $status.BackendState -ne 'Running'){
  Write-Output 'Signing in to Tailscale. Approve the sign-in in the browser window that opens.'
  & $ts up
  $status=Get-TsStatus
}
if(-not $status -or $status.BackendState -ne 'Running'){throw 'Tailscale is not connected. Sign in, then run this again.'}

$hostname=([string]$status.Self.DNSName).TrimEnd('.').ToLowerInvariant()
if($hostname -notmatch '^[a-z0-9-]+(\.[a-z0-9-]+)+$'){
  throw 'Could not read this PC''s tailnet name. In the Tailscale admin console (DNS page), turn on MagicDNS and HTTPS certificates, then run this again.'
}

# Serve The Chief to your tailnet only. Funnel (public internet) is never enabled.
& $ts serve --bg http://127.0.0.1:4175
Write-Output ''
& $ts serve status

# Let The Chief accept this exact hostname. It re-reads this file on every request.
$keyDir=Join-Path $env:LOCALAPPDATA 'Cheverton\console'
New-Item -ItemType Directory -Force -Path $keyDir | Out-Null
$hostsFile=Join-Path $keyDir 'chief-allowed-hosts.txt'
Set-Content -LiteralPath $hostsFile -Value $hostname -Encoding ascii

# Restart The Chief to load the new gateway code, but only when the console is paused and idle.
$restarted=$false
if(-not $NoRestart){
  $state=$null
  try{$state=(Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/runtime-control' -TimeoutSec 5).state}catch{}
  if($state -eq 'ready-to-restart'){
    Stop-ScheduledTask -TaskName 'The Chief' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName 'The Chief'
    $restarted=$true
  }else{
    Write-Output ''
    Write-Output "Not restarting The Chief: the console state is '$state', not 'ready-to-restart'."
    Write-Output 'Pause work in the console, wait for it to go idle, then run:'
    Write-Output '  Stop-ScheduledTask -TaskName ''The Chief''; Start-ScheduledTask -TaskName ''The Chief'''
  }
}

Write-Output ''
Write-Output "Phone address:  https://$hostname"
Write-Output "Intake key file: $keyDir\chief-intake.key  (open it on this PC and paste the key on your phone once)"
if($restarted){Write-Output 'The Chief was restarted and is ready.'}
Write-Output 'On your phone: install Tailscale, sign in to the same account, then open the address above.'
