<#
.SYNOPSIS
  Thinis POS V1 Windows acceptance: installer lifecycle checks on a DISPOSABLE Windows VM.

.DESCRIPTION
  Runs one phase of the installer lifecycle as the signed-in (cashier) Windows user and writes the
  results to <Evidence>\windows-acceptance-<phase>.json. Nothing here signs in, sells or prints; the
  business checks are tests/playwright/journeys/wintill.mjs and tests/windows/README.md.

  Phases (run in this order, each after the README's steps for it):
    preflight  OS, architecture, account type, installer hash and signature; refuses an existing till
    install    silent per-user install of -Installer; program, shortcuts, uninstall entry, native module
    profile    after the first launch and activation: data folder, database, no plain test credential
    upgrade    silent install of -Installer (version B) over A; one uninstall entry, data folder kept
    uninstall  silent uninstall; program and shortcuts gone, database KEPT byte-identical
    reinstall  silent install of -Installer again; the kept database is still there

  Safety:
    - Refuses to run unless POS_WINDOWS_ACCEPTANCE_DISPOSABLE=1 (the operator confirms this is a
      disposable VM snapshot, never a real till).
    - 'preflight' refuses if %APPDATA%\pos-desktop already exists (it could be a real till's data).
    - Never deletes the data folder. Never edits the registry. Never prints.

  ASCII only: Windows PowerShell 5.1 reads a file without a BOM in the ANSI code page.

.EXAMPLE
  $env:POS_WINDOWS_ACCEPTANCE_DISPOSABLE = '1'
  .\Test-WindowsPackage.ps1 -Phase preflight -Installer C:\pos\A\pos-desktop-1.0.0-setup.exe -Evidence C:\pos\evidence
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('preflight', 'install', 'profile', 'upgrade', 'uninstall', 'reinstall')]
  [string] $Phase,
  [string] $Installer,
  [Parameter(Mandatory = $true)]
  [string] $Evidence,
  [string] $ExpectedVersion,
  # Known TEST values typed into the till (activation code, cashier password), never real ones.
  [string[]] $PlainSecrets = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$InformationPreference = 'Continue'
Import-Module (Join-Path $PSScriptRoot 'WindowsAcceptance.psm1') -Force

Assert-DisposableMachine -Flag $env:POS_WINDOWS_ACCEPTANCE_DISPOSABLE

$ProductName = 'Thinis POS'
$ProgramDir = Join-Path $env:LOCALAPPDATA "Programs\$ProductName"
$ProgramExe = Join-Path $ProgramDir 'pos-desktop.exe'
$Uninstaller = Join-Path $ProgramDir "Uninstall $ProductName.exe"
$DataDir = Join-Path $env:APPDATA 'pos-desktop'
$Database = Join-Path $DataDir 'pos-desktop.sqlite'
$NativeModule = Join-Path $ProgramDir 'resources\app.asar.unpacked\node_modules\better-sqlite3\build\Release\better_sqlite3.node'
$StartMenuShortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$ProductName.lnk"
$DesktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) "$ProductName.lnk"
$UninstallKeys = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
$SnapshotPath = Join-Path $Evidence 'data-snapshot.json'

New-Item -ItemType Directory -Force -Path $Evidence | Out-Null
$results = New-Object System.Collections.ArrayList

function Add-Check {
  param([string] $Name, [bool] $Passed, $Detail = $null)
  $entry = New-CheckResult -Phase $Phase -Name $Name -Passed $Passed -Detail $Detail
  [void] $results.Add($entry)
  Write-Information ('[{0}] {1}: {2}' -f $entry.result, $Name, ($Detail | ConvertTo-Json -Compress -Depth 5))
}

function Get-UninstallEntry {
  return @(Get-ItemProperty $UninstallKeys -ErrorAction SilentlyContinue | Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq $ProductName })
}

function Invoke-Installer {
  param([string] $Path, [string[]] $Arguments)
  $process = Start-Process -FilePath $Path -ArgumentList $Arguments -PassThru -Wait
  return $process.ExitCode
}

function Stop-Till {
  # A silent install does not start the till, but a till the operator left open must close before files
  # are compared. CloseMainWindow is the normal quit path (the app drains and closes SQLite).
  [CmdletBinding(SupportsShouldProcess = $true)]
  param()
  foreach ($process in @(Get-Process -Name 'pos-desktop' -ErrorAction SilentlyContinue)) {
    if (-not $PSCmdlet.ShouldProcess("pos-desktop ($($process.Id))", 'close the till window')) { continue }
    [void] $process.CloseMainWindow()
    if (-not $process.WaitForExit(20000)) {
      Add-Check -Name 'till quit within 20 s' -Passed $false -Detail @{ pid = $process.Id }
    }
  }
}

switch ($Phase) {
  'preflight' {
    $os = Get-CimInstance Win32_OperatingSystem
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $isAdmin = (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    Add-Check -Name 'Windows version recorded' -Passed $true -Detail @{ caption = $os.Caption; version = $os.Version; build = $os.BuildNumber }
    Add-Check -Name 'x64 Windows' -Passed ($env:PROCESSOR_ARCHITECTURE -eq 'AMD64') -Detail @{ architecture = $env:PROCESSOR_ARCHITECTURE }
    Add-Check -Name 'standard (cashier) account, not an administrator' -Passed (-not $isAdmin) -Detail @{ user = $identity.Name }
    Add-Check -Name 'no existing till data on this machine' -Passed (-not (Test-Path -LiteralPath $DataDir)) -Detail @{ path = $DataDir }
    if ($Installer) {
      $signature = Get-AuthenticodeSignature -FilePath $Installer
      Add-Check -Name 'installer hash recorded' -Passed $true -Detail @{ file = (Split-Path $Installer -Leaf); sha256 = (Get-FileSha256 -Path $Installer) }
      # Recorded, not required: an unsigned installer is an internal test build and is reported as such.
      Add-Check -Name 'installer signature recorded' -Passed $true -Detail @{
        status    = "$($signature.Status)"
        signed    = (Test-PeSigned -Path $Installer)
        signer    = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null })
        buildKind = $(if ("$($signature.Status)" -eq 'Valid') { 'signed' } else { 'INTERNAL TEST BUILD (not validly signed)' })
      }
    }
  }
  'install' {
    if (-not $Installer) { throw '-Installer is required' }
    $exit = Invoke-Installer -Path $Installer -Arguments @('/S')
    Add-Check -Name 'silent per-user install without elevation' -Passed ($exit -eq 0) -Detail @{ exitCode = $exit }
    Stop-Till
    Add-Check -Name 'program installed per-user' -Passed (Test-Path -LiteralPath $ProgramExe) -Detail @{ path = $ProgramExe }
    Add-Check -Name 'Start menu shortcut' -Passed (Test-Path -LiteralPath $StartMenuShortcut) -Detail @{ path = $StartMenuShortcut }
    Add-Check -Name 'desktop shortcut' -Passed (Test-Path -LiteralPath $DesktopShortcut) -Detail @{ path = $DesktopShortcut }
    $entries = Get-UninstallEntry
    Add-Check -Name 'one per-user uninstall entry (HKCU)' -Passed ($entries.Count -eq 1) -Detail @{ entries = $entries.Count; version = $(if ($entries.Count -gt 0) { $entries[0].DisplayVersion } else { $null }) }
    if ($ExpectedVersion) {
      Add-Check -Name 'installed version' -Passed ($entries.Count -eq 1 -and $entries[0].DisplayVersion -eq $ExpectedVersion) -Detail @{ expected = $ExpectedVersion }
    }
    $machine = if (Test-Path -LiteralPath $NativeModule) { Get-PeMachine -Path $NativeModule } else { $null }
    Add-Check -Name 'native SQLite module is a Windows x64 image' -Passed ($machine -eq '0x8664') -Detail @{ machine = $machine }
    $exeSignature = Get-AuthenticodeSignature -FilePath $ProgramExe
    Add-Check -Name 'program signature recorded' -Passed $true -Detail @{ status = "$($exeSignature.Status)"; signed = (Test-PeSigned -Path $ProgramExe) }
  }
  'profile' {
    Stop-Till
    Add-Check -Name 'data folder is %APPDATA%\pos-desktop' -Passed (Test-Path -LiteralPath $DataDir) -Detail @{ path = $DataDir }
    Add-Check -Name 'database created by the native module' -Passed (Test-Path -LiteralPath $Database) -Detail @{ path = $Database }
    $snapshot = Get-DataSnapshot -DataDir $DataDir
    Add-Check -Name 'data folder contents recorded' -Passed ($null -ne $snapshot) -Detail $snapshot
    # Credentials are DPAPI (safeStorage) ciphertext in the database: the test values typed during
    # activation and sign-in must not appear in any profile file.
    $found = @(Find-PlainSecret -Directory $DataDir -Secrets $PlainSecrets)
    Add-Check -Name 'no plain test credential in the profile' -Passed ($PlainSecrets.Count -gt 0 -and $found.Count -eq 0) -Detail @{ secretsChecked = $PlainSecrets.Count; foundIn = $found }
    $snapshot | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath $SnapshotPath
  }
  'upgrade' {
    if (-not $Installer) { throw '-Installer is required (version B)' }
    Stop-Till
    $before = Get-Content -LiteralPath $SnapshotPath -Raw | ConvertFrom-Json
    $exit = Invoke-Installer -Path $Installer -Arguments @('/S')
    Add-Check -Name 'silent upgrade without elevation' -Passed ($exit -eq 0) -Detail @{ exitCode = $exit }
    Stop-Till
    $entries = Get-UninstallEntry
    Add-Check -Name 'one uninstall entry after the upgrade' -Passed ($entries.Count -eq 1) -Detail @{ entries = $entries.Count }
    if ($ExpectedVersion) {
      Add-Check -Name 'upgraded version' -Passed ($entries.Count -eq 1 -and $entries[0].DisplayVersion -eq $ExpectedVersion) -Detail @{ expected = $ExpectedVersion }
    }
    Add-Check -Name 'database kept' -Passed (Test-Path -LiteralPath $Database) -Detail @{ path = $Database }
    $after = Get-DataSnapshot -DataDir $DataDir
    $sameFiles = $null -ne $after -and ((@($before.profileFiles) -join '|') -eq (@($after.profileFiles) -join '|'))
    Add-Check -Name 'same profile files after the upgrade' -Passed $sameFiles -Detail @{ before = $before.profileFiles; after = $(if ($after) { $after.profileFiles } else { $null }) }
  }
  'uninstall' {
    Stop-Till
    $before = Get-DataSnapshot -DataDir $DataDir
    if (-not (Test-Path -LiteralPath $Uninstaller)) { throw "Uninstaller not found: $Uninstaller" }
    $exit = Invoke-Installer -Path $Uninstaller -Arguments @('/S')
    # The NSIS uninstaller copies itself to %TEMP% and continues there: wait for the program to go.
    $removed = Wait-Until -TimeoutSeconds 120 -Condition { -not (Test-Path -LiteralPath $ProgramExe) }
    Add-Check -Name 'silent uninstall' -Passed ($exit -eq 0 -and $removed) -Detail @{ exitCode = $exit; programRemoved = $removed }
    Add-Check -Name 'shortcuts removed' -Passed (-not (Test-Path -LiteralPath $StartMenuShortcut) -and -not (Test-Path -LiteralPath $DesktopShortcut))
    Add-Check -Name 'uninstall entry removed' -Passed ((Get-UninstallEntry).Count -eq 0)
    $after = Get-DataSnapshot -DataDir $DataDir
    Add-Check -Name 'database KEPT byte-identical (no silent data deletion)' -Passed ($null -ne $before -and $null -ne $after -and $after.databaseSha256 -eq $before.databaseSha256) -Detail @{ before = $(if ($before) { $before.databaseSha256 } else { $null }); after = $(if ($after) { $after.databaseSha256 } else { $null }) }
  }
  'reinstall' {
    if (-not $Installer) { throw '-Installer is required' }
    $before = Get-DataSnapshot -DataDir $DataDir
    $exit = Invoke-Installer -Path $Installer -Arguments @('/S')
    Add-Check -Name 'silent reinstall' -Passed ($exit -eq 0) -Detail @{ exitCode = $exit }
    Stop-Till
    Add-Check -Name 'program installed again' -Passed (Test-Path -LiteralPath $ProgramExe) -Detail @{ path = $ProgramExe }
    $after = Get-DataSnapshot -DataDir $DataDir
    Add-Check -Name 'kept database untouched by the reinstall' -Passed ($null -ne $before -and $null -ne $after -and $after.databaseSha256 -eq $before.databaseSha256) -Detail @{ path = $Database }
  }
}

$reportPath = Join-Path $Evidence ("windows-acceptance-{0}.json" -f $Phase)
ConvertTo-Json -InputObject @($results) -Depth 6 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
$failed = @($results | Where-Object { $_.result -eq 'FAIL' }).Count
Write-Information ('{0}: {1} checks, {2} failed -> {3}' -f $Phase, $results.Count, $failed, $reportPath)
if ($failed -gt 0) { exit 1 }
