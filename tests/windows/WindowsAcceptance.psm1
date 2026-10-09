# Thinis POS V1 Windows acceptance: helpers for Test-WindowsPackage.ps1.
# Pure functions only (no registry, no installer, no process control), so that Pester can test them on
# any platform: tests/windows/WindowsAcceptance.Tests.ps1.
# ASCII only: Windows PowerShell 5.1 reads a file without a BOM in the ANSI code page.

Set-StrictMode -Version Latest

function Assert-DisposableMachine {
  # The operator confirms, per session, that this is a disposable VM snapshot and never a real till.
  [CmdletBinding()]
  param([string] $Flag)
  if ($Flag -ne '1') {
    throw 'Refusing: set POS_WINDOWS_ACCEPTANCE_DISPOSABLE=1 only on a disposable Windows VM snapshot.'
  }
}

function Get-FileSha256 {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)] [string] $Path)
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-PeMachine {
  # IMAGE_FILE_HEADER.Machine of a PE image ('0x8664' = x64), or $null when the file is not a PE image.
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)] [string] $Path)
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 64 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) { return $null }
  $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
  if ($peOffset -lt 0 -or $peOffset + 6 -gt $bytes.Length) { return $null }
  if ($bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45) { return $null }
  return ('0x{0:x4}' -f [BitConverter]::ToUInt16($bytes, $peOffset + 4))
}

function Test-PeSigned {
  # True when the PE image carries an Authenticode signature (a non-empty security data directory).
  # Presence only; whether Windows trusts it is Get-AuthenticodeSignature's Status.
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)] [string] $Path)
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($null -eq (Get-PeMachine -Path $Path)) { return $false }
  $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
  $optional = $peOffset + 24
  $magic = [BitConverter]::ToUInt16($bytes, $optional)
  $directories = if ($magic -eq 0x20b) { $optional + 112 } else { $optional + 96 }
  $securitySize = [BitConverter]::ToUInt32($bytes, $directories + 4 * 8 + 4)
  return ($securitySize -gt 0)
}

function Find-PlainSecret {
  # Names of files under $Directory whose bytes contain any of $Secrets, read as UTF-8 or UTF-16LE.
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)] [string] $Directory,
    [string[]] $Secrets = @()
  )
  $found = New-Object System.Collections.Generic.List[string]
  foreach ($file in @(Get-ChildItem -LiteralPath $Directory -Recurse -File -ErrorAction SilentlyContinue)) {
    $bytes = [IO.File]::ReadAllBytes($file.FullName)
    $texts = @([Text.Encoding]::UTF8.GetString($bytes), [Text.Encoding]::Unicode.GetString($bytes))
    foreach ($secret in $Secrets) {
      if ([string]::IsNullOrEmpty($secret)) { continue }
      foreach ($text in $texts) {
        if ($text.Contains($secret)) {
          if (-not $found.Contains($file.Name)) { $found.Add($file.Name) }
        }
      }
    }
  }
  return $found.ToArray()
}

function Get-DataSnapshot {
  # The till's database files and their hashes, or $null when there is no database yet.
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)] [string] $DataDir)
  $database = Join-Path $DataDir 'pos-desktop.sqlite'
  if (-not (Test-Path -LiteralPath $database)) { return $null }
  $files = [ordered] @{}
  foreach ($file in @(Get-ChildItem -LiteralPath $DataDir -File | Where-Object { $_.Name -like 'pos-desktop.sqlite*' } | Sort-Object Name)) {
    $files[$file.Name] = Get-FileSha256 -Path $file.FullName
  }
  return [ordered] @{
    databaseSha256 = $files['pos-desktop.sqlite']
    files          = $files
    profileFiles   = @(Get-ChildItem -LiteralPath $DataDir -File | Select-Object -ExpandProperty Name | Sort-Object)
  }
}

function New-CheckResult {
  # Builds a result object; it changes no system state.
  [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '', Justification = 'Builds an object; changes no state')]
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)] [string] $Phase,
    [Parameter(Mandatory = $true)] [string] $Name,
    [Parameter(Mandatory = $true)] [bool] $Passed,
    $Detail = $null
  )
  return [ordered] @{
    phase  = $Phase
    check  = $Name
    result = $(if ($Passed) { 'PASS' } else { 'FAIL' })
    detail = $Detail
  }
}

function Wait-Until {
  # Polls $Condition every 500 ms until it returns true or $TimeoutSeconds pass; returns the last value.
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)] [scriptblock] $Condition,
    [int] $TimeoutSeconds = 60
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (& $Condition) { return $true }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  return [bool](& $Condition)
}

function Get-FileSha512Base64 {
  # The digest electron-updater compares with the feed metadata (base64 SHA-512).
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)] [string] $Path)
  $sha = [Security.Cryptography.SHA512]::Create()
  $stream = [IO.File]::OpenRead($Path)
  try { return [Convert]::ToBase64String($sha.ComputeHash($stream)) } finally { $stream.Dispose(); $sha.Dispose() }
}

function Update-FeedManifest {
  # Rewrites the sha512 and size of $Installer in electron-builder's latest.yml text after the installer
  # was re-signed for a test (signing changes its bytes). Returns the new text; writes nothing.
  [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '', Justification = 'Returns text; changes no state')]
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)] [string] $Metadata,
    [Parameter(Mandatory = $true)] [string] $Installer
  )
  $sha512 = Get-FileSha512Base64 -Path $Installer
  $size = (Get-Item -LiteralPath $Installer).Length
  $lines = $Metadata -split "`r?`n"
  $out = foreach ($line in $lines) {
    if ($line -match '^(\s*)sha512:\s') { '{0}sha512: {1}' -f $Matches[1], $sha512 }
    elseif ($line -match '^(\s*)size:\s') { '{0}size: {1}' -f $Matches[1], $size }
    else { $line }
  }
  return ($out -join "`n")
}

Export-ModuleMember -Function Assert-DisposableMachine, Get-FileSha256, Get-FileSha512Base64, Update-FeedManifest, Get-PeMachine, Test-PeSigned, Find-PlainSecret, Get-DataSnapshot, New-CheckResult, Wait-Until
