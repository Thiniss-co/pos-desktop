# Pester 5 tests for WindowsAcceptance.psm1 and the safety refusal of Test-WindowsPackage.ps1.
# Runs on Windows PowerShell 5.1, PowerShell 7 on Windows, and PowerShell 7 on Linux (the helpers are
# pure). With POS_WIN_UNPACKED set to an NSIS build's win-unpacked folder, the real Windows binaries are
# checked too; without it those cases are reported as skipped, never as passed.
#   Invoke-Pester -Path tests/windows/WindowsAcceptance.Tests.ps1 -Output Detailed

BeforeAll {
  Import-Module (Join-Path $PSScriptRoot 'WindowsAcceptance.psm1') -Force

  function Get-SyntheticPeImage {
    param([UInt16] $Machine, [UInt16] $Magic, [UInt32] $SecuritySize)
    $bytes = New-Object byte[] 512
    $bytes[0] = 0x4D; $bytes[1] = 0x5A
    [BitConverter]::GetBytes([Int32] 0x80).CopyTo($bytes, 0x3C)
    $bytes[0x80] = 0x50; $bytes[0x81] = 0x45
    [BitConverter]::GetBytes($Machine).CopyTo($bytes, 0x84)
    $optional = 0x80 + 24
    [BitConverter]::GetBytes($Magic).CopyTo($bytes, $optional)
    $directories = if ($Magic -eq 0x20b) { $optional + 112 } else { $optional + 96 }
    [BitConverter]::GetBytes([UInt32] 0x1000).CopyTo($bytes, $directories + 32)
    [BitConverter]::GetBytes($SecuritySize).CopyTo($bytes, $directories + 36)
    return , $bytes
  }

  $script:Work = Join-Path ([IO.Path]::GetTempPath()) ('pos-win-pester-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $script:Work | Out-Null
}

AfterAll {
  Remove-Item -LiteralPath $script:Work -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'Assert-DisposableMachine' {
  It 'refuses unless the operator set the disposable-machine flag to 1' {
    { Assert-DisposableMachine -Flag $null } | Should -Throw '*disposable Windows VM*'
    { Assert-DisposableMachine -Flag 'yes' } | Should -Throw
    { Assert-DisposableMachine -Flag '1' } | Should -Not -Throw
  }
}

Describe 'Test-WindowsPackage.ps1 safety' {
  It 'refuses to run any phase without the disposable-machine flag, before touching anything' {
    $previous = $env:POS_WINDOWS_ACCEPTANCE_DISPOSABLE
    try {
      $env:POS_WINDOWS_ACCEPTANCE_DISPOSABLE = $null
      $evidence = Join-Path $script:Work 'refused-evidence'
      { & (Join-Path $PSScriptRoot 'Test-WindowsPackage.ps1') -Phase preflight -Evidence $evidence } |
        Should -Throw '*disposable Windows VM*'
      Test-Path -LiteralPath $evidence | Should -BeFalse
    } finally {
      $env:POS_WINDOWS_ACCEPTANCE_DISPOSABLE = $previous
    }
  }

  It 'is ASCII only (Windows PowerShell 5.1 reads BOM-less files in the ANSI code page)' {
    foreach ($name in 'Test-WindowsPackage.ps1', 'WindowsAcceptance.psm1', 'WindowsAcceptance.Tests.ps1', 'Set-AcceptanceGuest.ps1') {
      $path = Join-Path $PSScriptRoot $name
      if (-not (Test-Path -LiteralPath $path)) { continue }
      $nonAscii = @([IO.File]::ReadAllBytes($path) | Where-Object { $_ -gt 0x7F }).Count
      $nonAscii | Should -Be 0 -Because $name
    }
  }
}

Describe 'Get-PeMachine and Test-PeSigned' {
  It 'reads an x64 PE32+ image and whether it carries a signature' {
    $unsigned = Join-Path $script:Work 'unsigned.exe'
    $signed = Join-Path $script:Work 'signed.exe'
    [IO.File]::WriteAllBytes($unsigned, (Get-SyntheticPeImage -Machine 0x8664 -Magic 0x20b -SecuritySize 0))
    [IO.File]::WriteAllBytes($signed, (Get-SyntheticPeImage -Machine 0x8664 -Magic 0x20b -SecuritySize 4096))
    Get-PeMachine -Path $unsigned | Should -Be '0x8664'
    Test-PeSigned -Path $unsigned | Should -BeFalse
    Test-PeSigned -Path $signed | Should -BeTrue
  }

  It 'reads a 32-bit (PE32) image' {
    $x86 = Join-Path $script:Work 'x86.exe'
    [IO.File]::WriteAllBytes($x86, (Get-SyntheticPeImage -Machine 0x014c -Magic 0x10b -SecuritySize 16))
    Get-PeMachine -Path $x86 | Should -Be '0x014c'
    Test-PeSigned -Path $x86 | Should -BeTrue
  }

  It 'returns $null for a file that is not a PE image (a Linux ELF, text, a truncated header)' {
    $elf = Join-Path $script:Work 'module.node'
    [IO.File]::WriteAllBytes($elf, [byte[]](0x7F, 0x45, 0x4C, 0x46) + (New-Object byte[] 60))
    $text = Join-Path $script:Work 'text.txt'
    Set-Content -LiteralPath $text -Value 'MZ but not a PE image'
    $truncated = Join-Path $script:Work 'truncated.exe'
    [IO.File]::WriteAllBytes($truncated, [byte[]](0x4D, 0x5A))
    Get-PeMachine -Path $elf | Should -BeNullOrEmpty
    Get-PeMachine -Path $text | Should -BeNullOrEmpty
    Get-PeMachine -Path $truncated | Should -BeNullOrEmpty
    Test-PeSigned -Path $elf | Should -BeFalse
  }
}

Describe 'Real NSIS build (POS_WIN_UNPACKED)' {
  BeforeAll { $script:Unpacked = $env:POS_WIN_UNPACKED }

  It 'packages the Windows x64 SQLite module' -Skip:(-not $env:POS_WIN_UNPACKED) {
    $module = Join-Path $script:Unpacked 'resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
    Get-PeMachine -Path $module | Should -Be '0x8664'
  }

  It 'records whether pos-desktop.exe is signed (an unsigned exe is an internal test build)' -Skip:(-not $env:POS_WIN_UNPACKED) {
    $exe = Join-Path $script:Unpacked 'pos-desktop.exe'
    Get-PeMachine -Path $exe | Should -Be '0x8664'
    $expected = $env:POS_WIN_EXPECT_SIGNED -eq '1'
    Test-PeSigned -Path $exe | Should -Be $expected
  }
}

Describe 'Find-PlainSecret' {
  It 'finds a secret stored as UTF-8 or UTF-16LE and ignores ciphertext' {
    $dir = Join-Path $script:Work 'profile'
    New-Item -ItemType Directory -Path $dir | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $dir 'utf8.bin'), [Text.Encoding]::UTF8.GetBytes('x Password123! y'))
    [IO.File]::WriteAllBytes((Join-Path $dir 'utf16.bin'), [Text.Encoding]::Unicode.GetBytes('ACTIVATE-DESKTOP-MVP'))
    [IO.File]::WriteAllBytes((Join-Path $dir 'cipher.bin'), [byte[]](1..200 | ForEach-Object { ($_ * 37) % 251 }))
    $found = @(Find-PlainSecret -Directory $dir -Secrets @('Password123!', 'ACTIVATE-DESKTOP-MVP', ''))
    @($found | Sort-Object) | Should -Be @('utf16.bin', 'utf8.bin')
    @(Find-PlainSecret -Directory $dir -Secrets @('not-there')).Count | Should -Be 0
  }
}

Describe 'Get-DataSnapshot' {
  It 'hashes every database file and is $null without a database' {
    $dir = Join-Path $script:Work 'data'
    New-Item -ItemType Directory -Path $dir | Out-Null
    Get-DataSnapshot -DataDir $dir | Should -BeNullOrEmpty
    Set-Content -LiteralPath (Join-Path $dir 'pos-desktop.sqlite') -Value 'db'
    Set-Content -LiteralPath (Join-Path $dir 'pos-desktop.sqlite-wal') -Value 'wal'
    Set-Content -LiteralPath (Join-Path $dir 'preferences.json') -Value '{}'
    $snapshot = Get-DataSnapshot -DataDir $dir
    $snapshot.databaseSha256 | Should -Be (Get-FileSha256 -Path (Join-Path $dir 'pos-desktop.sqlite'))
    @($snapshot.files.Keys) | Should -Be @('pos-desktop.sqlite', 'pos-desktop.sqlite-wal')
    $snapshot.profileFiles | Should -Contain 'preferences.json'
  }
}

Describe 'Wait-Until and New-CheckResult' {
  It 'returns true as soon as the condition holds and false after the timeout' {
    $script:count = 0
    Wait-Until -TimeoutSeconds 5 -Condition { $script:count += 1; $script:count -ge 2 } | Should -BeTrue
    Wait-Until -TimeoutSeconds 1 -Condition { $false } | Should -BeFalse
  }

  It 'labels a check PASS or FAIL' {
    (New-CheckResult -Phase 'install' -Name 'x' -Passed $true).result | Should -Be 'PASS'
    (New-CheckResult -Phase 'install' -Name 'x' -Passed $false -Detail @{ a = 1 }).result | Should -Be 'FAIL'
  }
}
