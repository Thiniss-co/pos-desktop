# Windows validation kit (V1)

**Status: NOT RUN.** No Windows environment was available for the V1 Windows-readiness work, so no
item below has been executed on Windows. Windows support is claimed for a version
(`docs/release/windows.md`) only after this kit passes on it. Linux results (journeys, the .deb
container test, the AppImage upgrade) are supporting evidence only.

`Test-WindowsPackage.ps1` has not been executed. PowerShell is not available on the build host, so it
has not even been parsed. Treat its first run as part of the validation.

## What is needed

| Need                                           | Detail                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A **disposable** Windows VM                    | Windows 11 23H2+ x64 and/or Windows 10 22H2 x64, fresh, with a snapshot to revert to. **Never a real till or a cashier's machine.** The data folder is fixed at `%APPDATA%\pos-desktop`, so isolation comes from the disposable VM and account, not from a path                                                                                                                                                 |
| A standard (non-administrator) Windows account | The "cashier". Per-user install needs no elevation; this proves it                                                                                                                                                                                                                                                                                                                                              |
| Installers A and B                             | Two builds of the same commit with versions A < B (for example `1.0.0` and `1.0.1`), built by the release process with the test API origin and test feed below. A loopback-origin package is a **test package**, never a release candidate                                                                                                                                                                      |
| A guarded disposable backend                   | `tests/playwright/support/sandbox.mjs` on the build host (disposable SQLite Laravel, guarded entry points; never a normal database), plus `proxy.mjs` in front of it for offline and lost-response simulation                                                                                                                                                                                                   |
| Network between the VM and the host            | The test package's API origin is `http://127.0.0.1:<port>` (opt-in `MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN=true`). In the VM, forward that port to the host's proxy, for example `ssh -N -L <port>:127.0.0.1:<port> <host>`. The same applies to the update feed port. The alternative is a TLS test origin with a test CA trusted only inside the VM (as `tests/playwright/support/tlsBackend.mjs` does on Linux) |
| An isolated update feed                        | `tests/playwright/support/staticFeed.mjs` serving B's `pos-desktop-<B>-setup.exe`, `.blockmap` and `latest.yml`. Never a public or production feed                                                                                                                                                                                                                                                              |
| A test printer (optional)                      | Only for the hardware items, and only with the operator's explicit authorization for each physical print                                                                                                                                                                                                                                                                                                        |

Build the test installers on the build host (Linux cross-builds NSIS; the afterPack hook installs the
Windows native module and fails the build if it does not match):

```
MAIN_VITE_POS_API_ORIGIN=http://127.0.0.1:<apiPort> MAIN_VITE_POS_ALLOW_LOOPBACK_ORIGIN=true \
MAIN_VITE_POS_UPDATE_FEED_URL=http://127.0.0.1:<feedPort>/ npx electron-vite build
npx electron-builder --win nsis --x64 --publish never -c.extraMetadata.version=1.0.0 -c.directories.output=dist-win/1.0.0
npx electron-builder --win nsis --x64 --publish never -c.extraMetadata.version=1.0.1 -c.directories.output=dist-win/1.0.1
sha256sum dist-win/*/pos-desktop-*-setup.exe
```

Record the commit, both versions and both SHA-256s in the evidence.

## Procedure

Run every step as the cashier account. Keep the evidence (the script's JSON, screenshots, the main
log `%APPDATA%\pos-desktop\logs` if present, and the backend's report) in one folder per run. Mark
each row PASS / FAIL / NOT RUN; never leave a failed or skipped row unmarked.

```
$env:POS_WINDOWS_ACCEPTANCE_DISPOSABLE = '1'
$kit = 'C:\pos\tests\windows\Test-WindowsPackage.ps1'; $ev = 'C:\pos\evidence\<run>'
```

### A. Install and identity

| #   | Step                                                                                                                       | Expected                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `& $kit -Phase preflight -Installer A.exe -Evidence $ev`                                                                   | x64, standard account, no existing `%APPDATA%\pos-desktop`; hash and signature status recorded (unsigned today)                          |
| A2  | Double-click A.exe as the cashier and note any SmartScreen prompt                                                          | Installs without a UAC prompt. Unsigned builds show SmartScreen; record it                                                               |
| A3  | `& $kit -Phase install -Installer A.exe -Evidence $ev -ExpectedVersion 1.0.0` (or verify A2's result with the same checks) | Program in `%LOCALAPPDATA%\Programs\Thinis POS`, Start menu and desktop shortcuts, HKCU uninstall entry, `better_sqlite3.node` is PE x64 |
| A4  | Launch from the **Start menu shortcut**                                                                                    | Window title and taskbar show "Thinis POS"; one taskbar group; a second launch focuses the first window (single instance)                |
| A5  | Settings → About / runtime                                                                                                 | Version A; platform `win32`                                                                                                              |

### B. Activation, credentials and the native database

| #   | Step                                                                                      | Expected                                                                                        |
| --- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| B1  | Activate (`DESKTOP-MVP` / `ACTIVATE-DESKTOP-MVP`), sign in as the cashier fixture         | Bootstrap completes; the POS screen opens                                                       |
| B2  | `& $kit -Phase profile -Evidence $ev -PlainSecrets 'ACTIVATE-DESKTOP-MVP','Password123!'` | `%APPDATA%\pos-desktop\pos-desktop.sqlite` exists; no plain test credential in any profile file |
| B3  | Quit and relaunch                                                                         | Still signed in: the DPAPI-protected token decrypts for the same Windows user                   |
| B4  | (Optional) copy the profile to a second Windows account and launch there                  | Cannot use the credentials (DPAPI is per user): asks to sign in; no crash, no data loss         |

### C. Selling (the cashier journey)

Use the fixture catalog (COLA `6221000000011` and the other fixture products). The proxy provides
offline and lost-response conditions.

| #   | Step                                                                                                                        | Expected                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| C1  | Open a shift                                                                                                                | Shift open; drawer amount recorded                                          |
| C2  | Barcode: scan with a USB scanner (keyboard wedge) and with typed input + Enter                                              | Line added once per scan; no duplicate on fast scans                        |
| C3  | Exact cash sale                                                                                                             | Completes; receipt preview shown; uploaded (backend report shows 1 invoice) |
| C4  | Split payment (cash + card)                                                                                                 | Totals and change correct; uploads                                          |
| C5  | Line and invoice discounts                                                                                                  | Within the cashier's limits; refused above them                             |
| C6  | An offer product (fixture offer)                                                                                            | Offer applied and shown on the line and receipt                             |
| C7  | Mixed tax rates in one sale                                                                                                 | Per-rate tax lines match the backend's                                      |
| C8  | Touch only (touchscreen or Windows touch simulation): numeric keypad for quantity, cash tendered and the quick-create price | Every amount can be entered without a keyboard                              |
| C9  | Catalog change while a cart is open (change a price on the backend, refresh)                                                | The cart is not repriced silently; the rebuild/clear choice appears         |
| C10 | Held sale / workspace: put a sale on hold, quit, relaunch                                                                   | The held sale is still there                                                |
| C11 | EN ↔ AR and light ↔ dark on POS, payment, refund and Settings                                                               | RTL layout correct, no clipped text, both themes legible                    |

### D. Offline and recovery

| #   | Step                                                                                                                       | Expected                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| D1  | Proxy offline; sell (physical-presence policy fixture)                                                                     | Sale completes locally; shown as pending upload                                      |
| D2  | Kill the app during D1's pending state: `Stop-Process -Name pos-desktop -Force`                                            | Relaunch: sale still pending, same receipt number                                    |
| D3  | Proxy online                                                                                                               | The sale uploads **exactly once** (backend report count)                             |
| D4  | Offline quick-create of a product; kill (as D2); relaunch online                                                           | The request resumes and creates the product once                                     |
| D5  | Refund with the response lost (proxy `dropResponse` on the refund upload)                                                  | The refund is not duplicated; it reconciles as one refund                            |
| D6  | Refund with fractional quantities (weighed fixture product) via the keypad: partial, the remainder, then more than remains | Partial and remaining amounts are correct; the over-refund is refused with a message |

### E. Upgrade, reinstall and uninstall

| #   | Step                                                                                                                                                      | Expected                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Leave a pending offline sale (D1 without D3) and a held sale                                                                                              | —                                                                                                                                                         |
| E2  | Serve B on the isolated feed; Settings → Software updates → Check now                                                                                     | Downloads B; "ready to install"                                                                                                                           |
| E3  | Put an item in the cart; press Restart to update                                                                                                          | Refused: "the sale or payment on screen"                                                                                                                  |
| E4  | Clear the cart; Restart to update                                                                                                                         | The app quits, the installer runs silently with no UAC prompt, and B starts on its own. Record whether B's relaunch kept the window and taskbar identity  |
| E5  | In B                                                                                                                                                      | Version B; still signed in; the pending sale has the same receipt; going online uploads it exactly once; the held sale is still there; settings unchanged |
| E6  | Manual upgrade: install B.exe over A with `& $kit -Phase upgrade -Installer B.exe -Evidence $ev -ExpectedVersion 1.0.1` (on a fresh snapshot after A3–B2) | One uninstall entry; same profile files                                                                                                                   |
| E7  | `& $kit -Phase uninstall -Evidence $ev`                                                                                                                   | Program and shortcuts removed; `%APPDATA%\pos-desktop` and the database **kept, byte-identical**                                                          |
| E8  | `& $kit -Phase reinstall -Installer B.exe -Evidence $ev`, then launch                                                                                     | The kept data is used: same device, pending work intact (sign in again if prompted)                                                                       |

### F. Hardware (separate evidence; explicit authorization for every physical print)

| #   | Step                                                                | Expected                                                                                                                           |
| --- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Settings → Printing lists the Windows printers (`getPrintersAsync`) | The thermal printer appears with its Windows name                                                                                  |
| F2  | **Authorized** test print                                           | One receipt. Check the width, margins, Arabic shaping and the logo. The till records `submitted` (spooler accepted), not "printed" |
| F3  | Printer offline / out of paper, **authorized**                      | The till records `outcome_unknown` or a failure; it never reprints automatically; a reprint is a cashier action                    |
| F4  | Cash drawer kick (if wired through the printer)                     | Opens once per cash sale                                                                                                           |
| F5  | Barcode scanner model(s) used in stores                             | C2 passes with each                                                                                                                |

## Recording the result

Attach the run folder to the readiness report with the Windows version and build, the installer
SHA-256s and signature status, and every row's result. Any FAIL or NOT RUN row keeps the verdict below
READY FOR WINDOWS RELEASE.
