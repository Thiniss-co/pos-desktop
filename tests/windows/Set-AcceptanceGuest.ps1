<#
.SYNOPSIS
  One-time setup of a DISPOSABLE Windows acceptance VM for Thinis POS (run as an administrator inside
  the VM, before the snapshot the cashier tests start from).

.DESCRIPTION
  The test installer is built for a loopback API origin and update feed (http://127.0.0.1:<port>,
  with the explicit test opt-in), and the host drives the till over CDP. This script makes that work
  inside a VirtualBox NAT guest, where the host is 10.0.2.2:
    - forwards guest 127.0.0.1:<ApiPort> and 127.0.0.1:<FeedPort> to the host's disposable backend
      proxy and isolated update feed (netsh portproxy);
    - exposes the till's DevTools port (127.0.0.1:9222, which Chromium binds to loopback only) on
      the guest NIC at <CdpGuestPort>, allowed by the firewall only from the host (10.0.2.2);
    - creates the scheduled task 'ThinisPosTill' that starts the installed till with
      --remote-debugging-port=9222 in the cashier's interactive session (the host's controller runs
      it with schtasks /run).
  It creates no account, installs nothing and touches no till data. A remote debugging port belongs
  only on this disposable VM, never on a real till.

  ASCII only: Windows PowerShell 5.1 reads a file without a BOM in the ANSI code page.

.EXAMPLE
  $env:POS_WINDOWS_ACCEPTANCE_DISPOSABLE = '1'
  .\Set-AcceptanceGuest.ps1 -CashierUser cashier -ApiPort 47801 -FeedPort 47802
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)] [string] $CashierUser,
  [Parameter(Mandatory = $true)] [ValidateRange(1024, 65535)] [int] $ApiPort,
  [Parameter(Mandatory = $true)] [ValidateRange(1024, 65535)] [int] $FeedPort,
  [ValidateRange(1024, 65535)] [int] $CdpGuestPort = 9223,
  [string] $HostAddress = '10.0.2.2'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$InformationPreference = 'Continue'
Import-Module (Join-Path $PSScriptRoot 'WindowsAcceptance.psm1') -Force
Assert-DisposableMachine -Flag $env:POS_WINDOWS_ACCEPTANCE_DISPOSABLE

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this setup as an administrator (the cashier tests themselves run as the standard account).'
}
$cashier = Get-LocalUser -Name $CashierUser
$admins = @(Get-LocalGroupMember -Group 'Administrators' | Where-Object { $_.Name -like "*\$CashierUser" })
if ($admins.Count -gt 0) { throw "$CashierUser is an administrator; the cashier must be a standard account." }

$guestAddress = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '10.0.2.*' } | Select-Object -First 1).IPAddress
if (-not $guestAddress) { throw 'No VirtualBox NAT address (10.0.2.x) on this VM.' }

if ($PSCmdlet.ShouldProcess('netsh portproxy', 'forward the API, feed and DevTools ports')) {
  Set-Service -Name iphlpsvc -StartupType Automatic
  Start-Service -Name iphlpsvc
  foreach ($port in $ApiPort, $FeedPort) {
    netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=$port connectaddress=$HostAddress connectport=$port | Out-Null
  }
  netsh interface portproxy add v4tov4 listenaddress=$guestAddress listenport=$CdpGuestPort connectaddress=127.0.0.1 connectport=9222 | Out-Null
}

if ($PSCmdlet.ShouldProcess('Windows Firewall', "allow TCP $CdpGuestPort from $HostAddress only")) {
  Get-NetFirewallRule -DisplayName 'Thinis POS acceptance DevTools' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName 'Thinis POS acceptance DevTools' -Direction Inbound -Protocol TCP -LocalPort $CdpGuestPort -RemoteAddress $HostAddress -Action Allow | Out-Null
}

$exe = Join-Path "C:\Users\$($cashier.Name)\AppData\Local\Programs\Thinis POS" 'pos-desktop.exe'
if ($PSCmdlet.ShouldProcess('Task Scheduler', "create ThinisPosTill for $($cashier.Name)")) {
  $action = New-ScheduledTaskAction -Execute $exe -Argument '--remote-debugging-port=9222'
  $principal = New-ScheduledTaskPrincipal -UserId $cashier.Name -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName 'ThinisPosTill' -Action $action -Principal $principal -Settings $settings -Force | Out-Null
}

Write-Information ('Guest ready: API 127.0.0.1:{0} and feed 127.0.0.1:{1} -> {2}; DevTools {3}:{4} -> 127.0.0.1:9222; task ThinisPosTill -> {5}' -f $ApiPort, $FeedPort, $HostAddress, $guestAddress, $CdpGuestPort, $exe)
Write-Information 'Sign in as the cashier (the task runs in that interactive session), then take the snapshot.'
