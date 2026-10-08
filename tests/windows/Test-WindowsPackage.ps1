<#
.SYNOPSIS
  Thinis POS V1 Windows acceptance: installer lifecycle checks on a DISPOSABLE Windows VM.

.DESCRIPTION
  Runs one phase of the installer lifecycle as the signed-in (cashier) Windows user and appends the
  results to <Evidence>\windows-acceptance.json. Nothing here signs in, sells or prints; the business
  checks are in tests/windows/README.md.

  Phases (run in this order, each after the README's manual steps for it):
    preflight  OS, architecture, account type, installer hash and signature; refuses an existing till
    install    silent per-user install of -Installer; program, shortcuts, uninstall entry, native module
    profile    after the first launch and activation: data folder, database, protected credentials
    upgrade    silent install of -Installer (version B) over A; data folder and database kept
    uninstall  silent uninstall; program and shortcuts gone, data folder KEPT
    reinstall  silent install of -Installer again; the kept data folder is used as it was

  Safety:
    - Refuses to run unless POS_WINDOWS_ACCEPTANCE_DISPOSABLE=1 (you confirm this is a disposable VM
      snapshot, never a real till).
    - 'preflight' refuses if %APPDATA%\pos-desktop already exists (it could be a real till's data).
    - Never deletes the data folder. Never edits the registry. Never prints.

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
  # Known TEST values typed into the till (activation code, cashier password) — never real ones.
  [string[]] $PlainSecrets = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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

if ($env:POS_WINDOWS_ACCEPTANCE_DISPOSABLE -ne '1') {
  throw 'Refusing: set POS_WINDOWS_ACCEPTANCE_DISPOSABLE=1 only on a disposable Windows VM snapshot.'
}
New-Item -ItemType Directory -Force -Path $Evidence | Out-Null
$ReportPath = Join-Path $Evidence 'windows-acceptance.json'

$results = New-Object System.Collections.ArrayList
function Check([string] $Name, [bool] $Passed, $Detail) {
  [void] $results.Add([ordered] @{ phase = $Phase; check = $Name; result = $(if ($Passed) { 'PASS' } else { 'FAIL' }); detail = $Detail })
  $mark = if ($Passed) { 'PASS' } else { 'FAIL' }
  Write-Host ("[{0}] {1}: {2}" -f $mark, $Name, ($Detail | ConvertTo-Json -Compress -Depth 4))
}

function Sha256([string] $Path) { (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant() }

function PeMachine([string] $Path) {
  # IMAGE_FILE_HEADER.Machine: 0x8664 = x64. Returns $null when the file is not a PE image.
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 64 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) { return $null }
  $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
  if ($bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45) { return $null }
  return '0x{0:x4}' -f [BitConverter]::ToUInt16($bytes, $peOffset + 4)
}

function UninstallEntry { Get-ItemProperty $UninstallKeys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq $ProductName } }

function DataSnapshot {
  if (-not (Test-Path $Database)) { return $null }
  [ordered] @{
    databaseBytes = (Get-Item $Database).Length
    databaseSha256 = Sha256 $Database
    files = @(Get-ChildItem -Path $DataDir -File | Select-Object -ExpandProperty Name | Sort-Object)
  }
}

function RunInstaller([string] $Path, [string[]] $Arguments) {
  $process = Start-Process -FilePath $Path -ArgumentList $Arguments -PassThru -Wait
  return $process.ExitCode
}

function StopTill {
  # The one-click installer starts the till when it finishes (runAfterFinish); close it before checks
  # that compare files. CloseMainWindow is the normal quit path (the app drains and closes SQLite).
  foreach ($p in @(Get-Process -Name 'pos-desktop' -ErrorAction SilentlyContinue)) {
    [void] $p.CloseMainWindow()
    if (-not $p.WaitForExit(20000)) { Check 'till quit within 20 s' $false @{ pid = $p.Id } }
  }
}

$snapshotPath = Join-Path $Evidence 'data-snapshot.json'

switch ($Phase) {
  'preflight' {
    $os = Get-CimInstance Win32_OperatingSystem
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $isAdmin = (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    Check 'Windows version recorded' $true @{ caption = $os.Caption; version = $os.Version; build = $os.BuildNumber }
    Check 'x64 Windows' ($env:PROCESSOR_ARCHITECTURE -eq 'AMD64') @{ architecture = $env:PROCESSOR_ARCHITECTURE }
    Check 'runs as a standard (cashier) account, not an administrator' (-not $isAdmin) @{ user = $identity.Name }
    Check 'no existing till data on this machine' (-not (Test-Path $DataDir)) @{ path = $DataDir }
    if ($Installer) {
      $signature = Get-AuthenticodeSignature -FilePath $Installer
      Check 'installer hash recorded' $true @{ file = (Split-Path $Installer -Leaf); sha256 = Sha256 $Installer }
      # Recorded, not required: an unsigned candidate is reported as such in the readiness report.
      Check 'installer signature recorded' $true @{ status = "$($signature.Status)"; signer = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }) }
    }
  }
  'install' {
    if (-not $Installer) { throw '-Installer is required' }
    $exit = RunInstaller $Installer @('/S')
    Check 'silent per-user install without elevation' ($exit -eq 0) @{ exitCode = $exit }
    StopTill
    Check 'program installed per-user' (Test-Path $ProgramExe) @{ path = $ProgramExe }
    Check 'Start menu shortcut' (Test-Path $StartMenuShortcut) @{ path = $StartMenuShortcut }
    Check 'desktop shortcut' (Test-Path $DesktopShortcut) @{ path = $DesktopShortcut }
    $entry = UninstallEntry
    Check 'per-user uninstall entry (HKCU)' ($null -ne $entry) @{ version = $(if ($entry) { $entry.DisplayVersion } else { $null }) }
    if ($ExpectedVersion) { Check 'installed version' ($entry -and $entry.DisplayVersion -eq $ExpectedVersion) @{ expected = $ExpectedVersion } }
    $machine = if (Test-Path $NativeModule) { PeMachine $NativeModule } else { $null }
    Check 'native SQLite module is a Windows x64 image' ($machine -eq '0x8664') @{ machine = $machine }
    $exeSignature = Get-AuthenticodeSignature -FilePath $ProgramExe
    Check 'program signature recorded' $true @{ status = "$($exeSignature.Status)" }
  }
  'profile' {
    Check 'data folder is %APPDATA%\pos-desktop' (Test-Path $DataDir) @{ path = $DataDir }
    Check 'database created by the native module' (Test-Path $Database) @{ path = $Database }
    $snapshot = DataSnapshot
    Check 'data folder contents recorded' ($null -ne $snapshot) $snapshot
    # Credentials are DPAPI (safeStorage) ciphertext in the database. The test values typed during
    # activation and sign-in (-PlainSecrets) must not appear in any profile file, in UTF-8 or UTF-16.
    $found = @()
    foreach ($file in @(Get-ChildItem -Path $DataDir -Recurse -File -ErrorAction SilentlyContinue)) {
      $bytes = [IO.File]::ReadAllBytes($file.FullName)
      $texts = @([Text.Encoding]::UTF8.GetString($bytes), [Text.Encoding]::Unicode.GetString($bytes))
      foreach ($secret in $PlainSecrets) {
        if (@($texts | Where-Object { $_.Contains($secret) }).Count -gt 0) { $found += $file.Name }
      }
    }
    Check 'no plain test credential in the profile' ($PlainSecrets.Count -gt 0 -and $found.Count -eq 0) @{ secretsChecked = $PlainSecrets.Count; foundIn = $found }
    StopTill
    $snapshot | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $snapshotPath
  }
  'upgrade' {
    if (-not $Installer) { throw '-Installer is required (version B)' }
    StopTill
    $before = Get-Content $snapshotPath -Raw | ConvertFrom-Json
    $exit = RunInstaller $Installer @('/S')
    Check 'silent upgrade without elevation' ($exit -eq 0) @{ exitCode = $exit }
    StopTill
    $entry = UninstallEntry
    Check 'one uninstall entry after the upgrade' (@($entry).Count -eq 1) @{ entries = @($entry).Count }
    if ($ExpectedVersion) { Check 'upgraded version' ($entry -and $entry.DisplayVersion -eq $ExpectedVersion) @{ expected = $ExpectedVersion } }
    Check 'data folder kept' (Test-Path $Database) @{ path = $Database }
    $after = DataSnapshot
    Check 'same profile files after the upgrade' ((@($before.files) -join '|') -eq (@($after.files) -join '|')) @{ before = $before.files; after = $after.files }
  }
  'uninstall' {
    StopTill
    $before = DataSnapshot
    if (-not (Test-Path $Uninstaller)) { throw "Uninstaller not found: $Uninstaller" }
    $exit = RunInstaller $Uninstaller @('/S')
    Start-Sleep -Seconds 5  # the NSIS uninstaller re-launches itself from %TEMP% and returns at once
    Check 'silent uninstall' ($exit -eq 0) @{ exitCode = $exit }
    Check 'program removed' (-not (Test-Path $ProgramExe)) @{ path = $ProgramExe }
    Check 'shortcuts removed' (-not (Test-Path $StartMenuShortcut) -and -not (Test-Path $DesktopShortcut)) @{}
    Check 'uninstall entry removed' ($null -eq (UninstallEntry)) @{}
    $after = DataSnapshot
    Check 'data folder and database KEPT (no silent data deletion)' ($null -ne $after -and $after.databaseSha256 -eq $before.databaseSha256) @{ before = $before.databaseSha256; after = $(if ($after) { $after.databaseSha256 } else { $null }) }
  }
  'reinstall' {
    if (-not $Installer) { throw '-Installer is required' }
    $before = DataSnapshot
    $exit = RunInstaller $Installer @('/S')
    Check 'silent reinstall' ($exit -eq 0) @{ exitCode = $exit }
    StopTill
    Check 'program installed again' (Test-Path $ProgramExe) @{ path = $ProgramExe }
    Check 'kept database still present' ($null -ne $before -and (Test-Path $Database)) @{ path = $Database }
  }
}

$existing = @()
if (Test-Path $ReportPath) { $existing = @(Get-Content $ReportPath -Raw | ConvertFrom-Json) }
$all = @($existing) + @($results)
$all | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $ReportPath
$failed = @($results | Where-Object { $_.result -eq 'FAIL' }).Count
Write-Host ("{0}: {1} checks, {2} failed -> {3}" -f $Phase, $results.Count, $failed, $ReportPath)
if ($failed -gt 0) { exit 1 }
