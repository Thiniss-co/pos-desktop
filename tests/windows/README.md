# Windows validation kit (V1)

**Windows execution: BLOCKED.** No Windows machine, VM or image was available. The owner's lab VMs
are not to be used, and a new Windows 11 VM needs a Microsoft download and licence acceptance by the
owner. No item below has run on Windows. Windows support is claimed for a version
(`docs/release/windows.md`) only after this kit passes on it.

What _has_ been validated, on Linux:

| Part                                                                                                                         | Validation                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Test-WindowsPackage.ps1`, `Set-AcceptanceGuest.ps1`, `WindowsAcceptance.psm1`, `WindowsAcceptance.Tests.ps1`                | PowerShell 7.4.6 parser: 0 errors. PSScriptAnalyzer 1.23.0: 0 errors or warnings. ASCII only (Windows PowerShell 5.1)                                               |
| Pure helpers (PE machine/signature, secrets scan, data snapshot, feed manifest)                                              | Pester 5.6.1 (13 tests), including the real NSIS build's `better_sqlite3.node` and unsigned `pos-desktop.exe`                                                       |
| `tests/playwright/journeys/wintill.mjs` (sale, touch keypad price, offline kill/restart/reconnect, refund, AR/dark, restart) | Passes with the **local** controller against the Linux package. The **vbox** controller (`tests/playwright/support/tillController.mjs`) has not run: there is no VM |
| Update signing policy and fail-closed Authenticode decision                                                                  | Unit tests (`src/main/update/*.test.ts`)                                                                                                                            |

## 1. A dedicated disposable Windows 11 VM

The option names below were checked against `VBoxManage` 7.2.6 help on the build host. The commands
have not been run.

Run on the build host by the owner, after accepting Microsoft's licence for the ISO they supply
(Windows 11 Enterprise evaluation or a licensed image). The name must start with
`thinis-pos-win11-acceptance`: the journey's controller refuses any other VM. The lab VMs are never
touched. It needs about 30 GB of disk (dynamic 64 GB disk) and 6 GB of RAM.

```bash
VM=thinis-pos-win11-acceptance
VBoxManage createvm --name $VM --ostype Windows11_64 --register
VBoxManage modifyvm $VM --memory 6144 --cpus 4 --firmware efi --tpm-type 2.0 \
  --nic1 nat --graphicscontroller vboxsvga --vram 128 --clipboard-mode disabled --drag-and-drop disabled
VBoxManage modifynvram $VM inituefivarstore
VBoxManage modifynvram $VM enrollmssignatures
VBoxManage modifynvram $VM enrollorclpk
VBoxManage modifynvram $VM secureboot --enable
VBoxManage modifyvm $VM --nat-pf1="cdp,tcp,127.0.0.1,9333,,9223"
VBoxManage createmedium disk --filename "$HOME/VirtualBox VMs/$VM/$VM.vdi" --size 65536
VBoxManage storagectl $VM --name SATA --add sata --controller IntelAhci
VBoxManage storageattach $VM --storagectl SATA --port 0 --type hdd --medium "$HOME/VirtualBox VMs/$VM/$VM.vdi"
# Administrator for setup only; the cashier is created below as a standard account.
VBoxManage unattended install $VM --iso=/path/to/Win11.iso --user=setupadmin --user-password-file=<file> \
  --full-user-name="Acceptance Setup" --locale=en_US --country=SA --time-zone=Arab_Standard_Time \
  --install-additions --start-vm=gui
```

Inside the VM, as `setupadmin`:

```powershell
$p = Read-Host -AsSecureString 'cashier password'
New-LocalUser -Name cashier -Password $p -PasswordNeverExpires   # a standard account (Users group only)
Add-LocalGroupMember -Group Users -Member cashier
Install-Language ar-SA     # optional: Arabic UI fonts for the AR checks
```

## 2. Test installers (build host)

Pick two free host ports: `API` for the disposable backend's proxy and `FEED` for the isolated update
feed. Then build A and B from the same commit:

```bash
export MAIN_VITE_POS_API_ORIGIN=http://127.0.0.1:$API MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN=true \
       MAIN_VITE_POS_UPDATE_FEED_URL=http://127.0.0.1:$FEED/
npx electron-vite build
for v in 1.0.0 1.0.1; do
  npx electron-builder --win nsis --x64 --publish never -c.extraMetadata.version=$v -c.directories.output=dist-win/$v \
    "-c.win.signtoolOptions.publisherName=CN=Thinis POS Acceptance Test Publisher"
done
sha256sum dist-win/*/pos-desktop-*-setup.exe
```

These are **internal test builds**: a loopback origin, unsigned binaries. `publisherName` names the VM's
test certificate (section 6), so A requires every update to carry that publisher's valid signature.
A build without `publisherName` would update only checksum-only, and only from its loopback test feed.
Record the commit, the versions and the SHA-256s.

## 3. Guest setup (once, then snapshot)

Copy `tests/windows/` and the installers into the VM (for example
`VBoxManage guestcontrol $VM copyto --username setupadmin ...`). As `setupadmin`:

```powershell
$env:POS_WINDOWS_ACCEPTANCE_DISPOSABLE = '1'
.\Set-AcceptanceGuest.ps1 -CashierUser cashier -ApiPort <API> -FeedPort <FEED>
```

The script makes three changes:

- guest `127.0.0.1:<API>` and `127.0.0.1:<FEED>` reach the host (`10.0.2.2`);
- the till's DevTools port is reachable from the host only (host `127.0.0.1:9333`, then guest `9223`,
  then `127.0.0.1:9222`);
- a scheduled task `ThinisPosTill` starts the till in the cashier's interactive session.

Sign in as `cashier` and take the snapshot `clean`. Revert to it before every run.

## 4. Install, credentials and data lifecycle (in the VM, as `cashier`)

```powershell
$env:POS_WINDOWS_ACCEPTANCE_DISPOSABLE = '1'
$kit = 'C:\pos\tests\windows\Test-WindowsPackage.ps1'; $ev = 'C:\pos\evidence\<run>'
```

| #   | Step                                                                                                               | Expected                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `& $kit -Phase preflight -Installer A.exe -Evidence $ev`                                                           | x64, standard account, no existing `%APPDATA%\pos-desktop`; installer hash and signature recorded ("INTERNAL TEST BUILD" while unsigned)     |
| A2  | Double-click A.exe; record the SmartScreen prompt                                                                  | Installs without a UAC prompt. SmartScreen warns about an unsigned build. Record it; never bypass it to claim a pass                         |
| A3  | `& $kit -Phase install -Installer A.exe -Evidence $ev -ExpectedVersion 1.0.0` (on a fresh snapshot, instead of A2) | Program under `%LOCALAPPDATA%\Programs\Thinis POS`, Start menu and desktop shortcuts, one HKCU uninstall entry, `better_sqlite3.node` PE x64 |
| A4  | Launch from the **Start menu shortcut**; launch again                                                              | "Thinis POS" window and taskbar group; the second launch focuses the first window                                                            |
| B1  | Run the automated journey (section 5) up to step A, or activate and sign in by hand                                | Activation, sign-in, bootstrap, shift                                                                                                        |
| B2  | Close the till; `& $kit -Phase profile -Evidence $ev -PlainSecrets 'ACTIVATE-DESKTOP-MVP','Password123!'`          | `%APPDATA%\pos-desktop\pos-desktop.sqlite` exists; no plain test credential in any profile file                                              |
| B3  | (Optional) copy the profile to a second Windows account and start the till there                                   | Credentials do not decrypt (DPAPI is per user): sign-in asked again; no crash, no data loss                                                  |
| E6  | `& $kit -Phase upgrade -Installer B.exe -Evidence $ev -ExpectedVersion 1.0.1`                                      | One uninstall entry; same profile files                                                                                                      |
| E7  | `& $kit -Phase uninstall -Evidence $ev`                                                                            | Program and shortcuts removed; the database **kept, byte-identical**                                                                         |
| E8  | `& $kit -Phase reinstall -Installer B.exe -Evidence $ev`, then start the till                                      | The kept database is used: same device; pending work intact                                                                                  |

## 5. The cashier journey, automated (build host → VM)

With the VM running from `clean`, the cashier signed in and A installed, run this on the build host.
The disposable backend's proxy listens on `$API`, and the VM reaches it through the portproxy.

```bash
PW_TILL_CONTROLLER=vbox PW_TILL_VM=thinis-pos-win11-acceptance PW_TILL_GUEST_USER=cashier \
PW_TILL_GUEST_PASSWORD_FILE=<file> PW_TILL_CDP_URL=http://127.0.0.1:9333 PW_TILL_API_PORT=$API \
PW_BACKEND_ROOT=<backend export> PW_EVIDENCE_ROOT=<dir> node tests/playwright/run.mjs wintill
```

It requires `platform: win32`, then covers:

- **A.** Activation, sign-in, bootstrap and shift.
- **B.** An exact-cash sale online, on the server exactly once.
- **C.** Touch mode switched on by touch, and a quick-created product priced on the on-screen keypad
  (1250 minor units on the server).
- **D.** An offline sale, a hard kill (`taskkill /F`) and a restart. The till must still be signed in
  with the sale pending; back online, the sale must upload exactly once.
- **E.** A refund of the first sale on the keypad: one refund on the server.
- **F.** Arabic + dark: right-to-left, with screenshots.
- **G.** A normal quit and restart: still signed in (DPAPI).

### Manual rows (not automated)

| #   | Step                                                                                               | Expected                                                                      |
| --- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| C2  | Barcode scanner (keyboard wedge) and typed input + Enter                                           | One line per scan; no duplicate on fast scans                                 |
| C4  | Split payment (cash + card)                                                                        | Totals and change correct; uploads once                                       |
| C5  | Line and invoice discounts                                                                         | Within the cashier's limits; refused above them                               |
| C6  | An offer product                                                                                   | Offer applied on the line and the receipt                                     |
| C7  | Mixed tax rates in one sale                                                                        | Per-rate tax lines match the backend's                                        |
| C9  | Catalog change while a cart is open                                                                | Not repriced silently; the rebuild/clear choice appears                       |
| C10 | Held sale; quit; start                                                                             | The held sale is still there                                                  |
| C11 | EN ↔ AR, light ↔ dark on payment, refund and Settings                                              | No clipped text; both themes legible                                          |
| D4  | Offline quick-create, `taskkill /F`, start online                                                  | Created once                                                                  |
| D5  | Refund with the answer lost (proxy `dropResponse`)                                                 | One refund                                                                    |
| D6  | Fractional refund on the keypad: part, the rest, then more than remains                            | Amounts correct; the over-refund is refused with a message                    |
| S1  | Startup error: in a copy of the profile, follow `tests/playwright/journeys/startupfail.mjs` step 2 | The error box shows the steps, folder, version and reason; database unchanged |

## 6. Automatic update A → B, and signature handling

As `setupadmin`, inside the VM only, once per snapshot:

```powershell
# A test code-signing certificate that only this disposable VM trusts.
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Thinis POS Acceptance Test Publisher' -CertStoreLocation Cert:\CurrentUser\My
foreach ($store in 'Root', 'TrustedPublisher') {
  $s = New-Object Security.Cryptography.X509Certificates.X509Store($store, 'LocalMachine'); $s.Open('ReadWrite'); $s.Add($cert); $s.Close()
}
$other = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Someone Else' -CertStoreLocation Cert:\CurrentUser\My
```

The host serves `C:\feed` through the isolated feed (`tests/playwright/support/staticFeed.mjs`
listening on `$FEED`). For each case, prepare B in `C:\feed` as shown. Rewrite `latest.yml` after
signing, because signing changes the installer's bytes and SHA-512:

```powershell
Import-Module C:\pos\tests\windows\WindowsAcceptance.psm1
$b = 'C:\feed\pos-desktop-1.0.1-setup.exe'
Set-AuthenticodeSignature -FilePath $b -Certificate $cert -HashAlgorithm SHA256   # or $other, or skip
Set-Content C:\feed\latest.yml (Update-FeedManifest -Metadata (Get-Content C:\feed\latest.yml -Raw) -Installer $b) -Encoding ascii
```

| #   | B in the feed                                                                | Expected in A (Settings → Software updates; `[pos-update]` in the main log)                                  |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| E2  | Signed by the trusted test publisher                                         | "Updates verified by: checksum and publisher signature"; downloads; ready                                    |
| E3  | Item in the cart → Restart to update                                         | Refused: "the sale or payment on screen"                                                                     |
| E4  | Cart empty (an offline sale pending) → Restart to update                     | Quits, installs silently (no UAC), B starts; version 1.0.1; signed in; the pending sale uploads exactly once |
| E9  | Unsigned (revert to `clean`, reinstall A)                                    | **Refused**: `error` with `ERR_UPDATER_INVALID_SIGNATURE` (status not Valid); nothing installed              |
| E10 | Signed by `CN=Someone Else`                                                  | **Refused**: another publisher                                                                               |
| E11 | Signed by the test publisher, then one byte changed (`latest.yml` rewritten) | **Refused**: status HashMismatch                                                                             |
| E12 | Signed, but `latest.yml` NOT rewritten after signing                         | **Refused**: sha512 checksum mismatch                                                                        |
| E13 | A built **without** `publisherName` but with an https feed URL               | "Automatic updates are off: this build is not signed by its publisher"; no check is made                     |

Never bypass SmartScreen, TLS or signature failures to make a row pass. These certificates are test
fixtures of the disposable VM; delete the VM after the run.

## 7. Hardware (separate evidence; explicit authorization for every physical print)

| #   | Step                                                                | Expected                                                                                                                           |
| --- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Settings → Printing lists the Windows printers (`getPrintersAsync`) | The thermal printer appears with its Windows name                                                                                  |
| F2  | **Authorized** test print                                           | One receipt. Check the width, margins, Arabic shaping and the logo. The till records `submitted` (spooler accepted), not "printed" |
| F3  | Printer offline / out of paper, **authorized**                      | The till records `outcome_unknown` or a failure; it never reprints automatically; a reprint is a cashier action                    |
| F4  | Cash drawer kick (if wired through the printer)                     | Opens once per cash sale                                                                                                           |
| F5  | Barcode scanner model(s) used in stores                             | C2 passes with each                                                                                                                |

## Recording the result

Keep one folder per run with:

- the Windows version and build;
- the installer SHA-256s and signature status;
- every `windows-acceptance-<phase>.json`;
- the journey's `result-*.json` and screenshots;
- each row's result: PASS, FAIL or NOT RUN.

Any FAIL or NOT RUN row keeps the verdict below READY FOR WINDOWS RELEASE.
