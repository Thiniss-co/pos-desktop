# POS workspace — implementation and acceptance report

**Tested repository identity (closeout):** `/var/www/html/thinis-pos/pos-desktop-pos-workspace` (registry
slot **desktop-1**), branch `feat/pos-workspace`, `HEAD` = `7d3a59c9d21d588021b5f51f5500b941a6f99f9d` plus
uncommitted work. Diffstat: 46 modified, 2 deleted, 20 untracked; 48 tracked files changed, +3036 / −1602.
SHA-256 of (`git diff` + all untracked file contents) = `496d4130…5d0f15d` (`closeout-identity.txt`). It was
identical before and after the closeout sweep, the build and the checks.
Journeys ran against a detached backend fixture worktree `../pos-backend-pos-workspace` @ `991bc1e`
(own `composer install --no-scripts`, an APP_KEY-only `.env`, and an owner-SPA asset build for
`qc6receipts`; **no backend source changes**). Nothing is staged, committed, pushed or merged.

Scope note: this is the explicitly requested enhancement of the existing selling screen (presentation
plus a local, presentation-only preference). It adds no payment, refund, sync or backend capability.

## What changed for the cashier

- **Three presets.** *Cart first* (default, recommended) gives the cart 64% of the workspace with
  compact product tiles. *Balanced* gives it 45% with full product cards. *Scanner focused* gives the
  cart the whole workspace, a large scan entry, and products in a side rail.
- **Ledger cart.** Each line is one row: name, quantity stepper, unit price, line total and a line
  menu.
  - Columns share one grid with the header, numbers are tabular, and RTL mirrors.
  - Compact rows are 34px with 28px steppers. Comfortable rows are 57px (61px in touch mode) with
    steppers of at least 44px.
  - Names wrap and are never truncated; offers stay visible under the name. A narrow cart moves the
    unit price under the name instead of dropping it.
  - Only the lines scroll. Totals, Exact cash (Shift+F9) and Pay (F9) are pinned in one band, with
    the amount due as the screen's single large figure.
  - The band (closeout change) shows the summary amounts as one compact label/value line. A cart
    ≥900px wide keeps summary, total and actions on one row; narrower carts put the summary line above
    the total and the two payment buttons; carts under 540px stack them. Comfortable rows use 4px
    padding, so adjacent 44–48px targets stay ≥8px apart.
- **Less clutter.** One toolbar holds Customer (shows the name), Discount (shows the amount), Hold,
  Recall (with count) and Return / Refund (only when permitted).
  - What does not fit moves, in order, into More.
  - More always holds: +1 last item, Clear cart (existing confirmation), Quick create… (existing
    dialog), Shortcuts and help, Refresh workstation data, Customize layout.
  - Touch mode uses the same single row with ≥44px labelled buttons and a labelled **More** (closeout
    change: it no longer wraps onto a second row). Overflowed actions keep their labels and 44px targets
    inside More. The old 60px tile row and the touch bar are gone; existing handlers and permission
    rules are reused.
- **Small windows.** Below 900px the cart stays visible. Products collapse to a 64px rail whose
  browser opens beside a minimum-width cart, never over it. The old cart sheet and summary bar are
  retired.
- **Customize layout.** Two entry points open the editor: the icon in the cart's column header, and
  More → Customize layout. Settings → *POS workspace* adds a schematic preview and the same controls.
  - Choices: preset, cart side, density, collapse products, product tiles, cart width, and section
    order (cart: actions / scan / lines / totals; products: categories / search).
  - Dragging works with pointer and touch on visible handles and the separator.
  - Every drag has a keyboard equivalent: separator arrows/Home/End, Move up / Move down buttons,
    − / + width steps.
  - Apply / Cancel / Restore defaults; Esc cancels. Only supported orders are accepted, and totals
    are always last.
  - Handles and the separator exist **only while editing**.

## Persistence (main process)

- **Storage:** migration `0033_user_workspace_layouts`, primary key (company_uuid, user_uuid,
  device_uuid). The JSON is checked for validity and a 2048-byte limit, `schema_version` must be 1,
  and the table is `STRICT`.
  - The owner always comes from the main-process session (`SqliteSessionMetadataRepository`).
  - The renderer sends only `{ layout | null, contextToken }` on the fixed channels
    `preferences:get-pos-workspace` / `preferences:set-pos-workspace`. These go through the trusted
    sender check and strict Zod validation (`posWorkspace.contract.ts`).
- **Context token:** each read returns a non-secret token covering company, user, device, server
  device id and session epoch. A write whose token no longer matches is refused (`conflict`), so a
  save started by one cashier can never land on the next cashier's row.
- **Read and write rules:**
  - Reads normalize field by field, and corrupted rows fall back to defaults; reads never write.
  - Restore defaults deletes the row.
  - Window resizes clamp only the applied layout; the stored one never changes.
- **What it never stores:** cart contents, credentials or business state.
- **Old width preference:** the renderer store for the workstation-wide `ui.posCartWidth` is
  retired. The main channel stays for compatibility, and the stored value is left untouched and
  ignored.

## Scanner and keyboard safety while editing

- **Router mode:** the scan router has a `layout-edit` mode (documented in
  `docs/architecture/pos-ux-architecture.md`).
  - A scanner burst and its Enter/Tab/Space terminator are consumed wherever focus is.
  - A stray terminator within 300ms of a burst is consumed too.
  - F9 and Shift+F9 are consumed and do nothing.
  - A standalone Enter or Space keeps native activation, so the editor stays keyboard-operable.
- **Page guards:**
  - The page refuses adds while editing, both before and after the catalog lookup.
  - Customize stays disabled while a scan or product lookup is pending.
  - Shortcuts are disabled, and Exact cash and Pay are disabled.
  - Business content is `inert`, except the lines, which keep scrolling with their controls disabled.
- **Settings:** while editing, Settings mounts the same router in `layout-edit` mode.
- **Proof:**
  - `ws2checkout` part C, run in the real renderer: a scan on Apply/Restore/Cancel with Enter, Tab,
    a Space inside the code, and no suffix; F9; Shift+F9; and a scan racing the editor's opening. None
    changed the cart, opened payment, activated the focused control or wrote the stored row (compared
    byte for byte).
  - Unit tests: `scanInputRouter.test.ts` (layout-edit) and `PosPage.offlineShiftAuthority.test.ts`
    (a delayed lookup resolving after editing begins).

## Measured density (real DOM geometry, `ws1measure`)

- **Display:** real Electron renderer on a nested Xephyr display (2000×1200, no window manager), so the
  content size is exact. The user's monitor clamps windows to 1919×1043. The viewport, DPR 1 and zoom 1
  are asserted for every size.
- **Two 25-line carts, built through the scan field, never through the store:**
  - **Stress cart**, unchanged fixture and order: WS-01…WS-25 from `create-named-products`. Realistic
    EN/AR names, three very long (many wrap in narrow carts); three fractional quantities keyed as
    `1.250*…`; a live offer on WS-03.
  - **Ordinary cart**, added in the closeout: the stress cart is cleared through the UI (More →
    Clear cart → confirm), then PL-01…PL-25 from the new test-support operation
    `create-plain-products` are scanned. Short single-line EN/AR names; PL-06 and PL-07 fractional.
- **"Fully visible":** the whole row rectangle lies inside the viewport and every clipping ancestor,
  measured at scrollTop 0.
- **"Ordinary":** the name fits on one line and the row has no offer.
- **Standard state:** no shell notice, recovery banner or cart error.

### Final counts (closeout run `result-2026-10-06T16-59-06-326Z`): fully visible rows (ordinary rows)

| Cart | Viewport | Compact | Comfortable | Touch |
|---|---|---|---|---|
| Stress | 1920×1080 | **22 (21)** ✔ gate ≥ 20 ordinary | 13 (12) | 12 (11) |
| Stress | 1366×768 | 12 (10) | 7 (5) | 7 (5) |
| Stress | 1024×768 | 10 (4) | 5 (3) | 6 (3) |
| Stress | 800×600 | 6 (3) | 3 (2) | 3 (2) |
| Ordinary | 1920×1080 | 22 (22) | 13 (13) | 12 (12) |
| Ordinary | 1366×768 | 12 (12) | 7 (7) | 7 (7) |
| Ordinary | 1024×768 | 12 (12) | 7 (7) | 7 (7) |
| Ordinary | 800×600 | 7 (7) ✔ gate ≥ 3 | 4 (4) | **4 (4)** ✔ gate ≥ 3 |
| Stress, offline banners (`backend_unreachable`, 114px) | 1920×1080 | 19 (18) | — | — |
| Stress, offline banners | 1366×768 | 9 (8) | — | — |

- **Before the change** (desktop / touch, stress cart): 2 / 1 rows at 1920×1080; 1 / 0 at 1366×768
  and 1024×768, with Pay off screen; 0 at 800×600 (cart hidden; the opened sheet showed 1 / 0).
- **The 800×600 touch requirement is met with the ordinary cart:** 4 fully visible ordinary rows, with
  the scanner, its feedback line, the whole checkout band and no horizontal or page overflow. The
  `ws1measure` gate enforces it.
- **The stress cart at 800×600 touch shows 3 rows, 2 of them ordinary.** That is because the long
  names wrap in a 700px cart. It is reported as measured; the fixture order and content are unchanged
  and nothing is hidden or truncated. `ws5matrix` shows the same 3 (2) in EN/AR × light/dark.
- **20 rows only fit at 1920×1080 compact.** Smaller sizes report their real counts.

Full table (every region, row height range, chrome, overflow; before and after):

| Phase | Cart | Mode | Size | State | Catalog px | Cart px | Lines px | Cart chrome px | Row px | Fully visible | …ordinary | Footer visible | H-overflow | Page overflow px |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| before | stress | desktop | 1920x1080 | standard | 1437 | 420 | 250 | 738.3 | 101–129.8 | 2 | 2 | yes | no | — |
| before | stress | desktop | 1366x768 | standard | 923 | 380 | 120 | 556 | 101–150 | 1 | 0 | no | no | — |
| before | stress | desktop | 1024x768 | standard | 621 | 340 | 120 | 556 | 101–170.3 | 1 | 0 | no | no | — |
| before | stress | desktop | 800x600 | standard | 776 | hidden | — | — | 0–0 | 0 | 0 | no | no | — |
| before | stress | desktop | 800x600 | cart-sheet-open | 776 | 800 | 120 | 480 | 101–109.5 | 1 | 1 | no | no | — |
| before | stress | touch | 1920x1080 | standard | 1437 | 420 | 126 | 861.7 | 121–137.8 | 1 | 1 | yes | no | — |
| before | stress | touch | 1366x768 | standard | 923 | 380 | 120 | 556 | 121–158 | 0 | 0 | no | no | — |
| before | stress | touch | 1024x768 | standard | 621 | 340 | 120 | 556 | 121–178.3 | 0 | 0 | no | no | — |
| before | stress | touch | 800x600 | standard | 776 | hidden | — | — | 0–0 | 0 | 0 | no | no | — |
| before | stress | touch | 800x600 | cart-sheet-open | 776 | 800 | 120 | 480 | 121–121 | 0 | 0 | no | no | — |
| before | stress | desktop | 1920x1080 | offline-notice | 1437 | 420 | 250 | 738.3 | 101–129.8 | 2 | 2 | yes | no | — |
| before | stress | desktop | 1366x768 | offline-notice | 923 | 380 | 120 | 556 | 101–150 | 1 | 0 | no | no | — |
| after | stress | compact | 1920x1080 | standard | 671 | 1213 | 768 | 228 | 34–41.3 | 22 | 21 | yes | no | 0 |
| after | stress | compact | 1366x768 | standard | 471 | 859 | 432 | 252 | 34–45.5 | 12 | 10 | yes | no | 0 |
| after | stress | compact | 1024x768 | standard | 348 | 640 | 432 | 252 | 34–86 | 10 | 4 | yes | no | 0 |
| after | stress | compact | 800x600 | standard | rail 64 | 700 | 264 | 252 | 34–65.8 | 6 | 3 | yes | no | 0 |
| after | stress | comfortable | 1920x1080 | standard | 671 | 1213 | 728 | 268 | 56–56 | 13 | 12 | yes | no | 0 |
| after | stress | comfortable | 1366x768 | standard | 471 | 859 | 392 | 292 | 56–73.8 | 7 | 5 | yes | no | 0 |
| after | stress | comfortable | 1024x768 | standard | 348 | 640 | 392 | 292 | 56–113.4 | 5 | 3 | yes | no | 0 |
| after | stress | comfortable | 800x600 | standard | rail 64 | 700 | 224 | 292 | 56–91.8 | 3 | 2 | yes | no | 0 |
| after | stress | touch | 1920x1080 | standard | 671 | 1213 | 738 | 258 | 57–57 | 12 | 11 | yes | no | 0 |
| after | stress | touch | 1366x768 | standard | 471 | 859 | 402 | 282 | 57–73.8 | 7 | 5 | yes | no | 0 |
| after | stress | touch | 1024x768 | standard | 348 | 640 | 402 | 282 | 57–113.4 | 6 | 3 | yes | no | 0 |
| after | stress | touch | 800x600 | standard | rail 64 | 700 | 234 | 282 | 57–91.8 | 3 | 2 | yes | no | 0 |
| after | stress | compact | 1920x1080 | offline-notice | 671 | 1213 | 654 | 228 | 34–41.3 | 19 | 18 | yes | no | 0 |
| after | stress | compact | 1366x768 | offline-notice | 471 | 859 | 318 | 252 | 34–45.5 | 9 | 8 | yes | no | 0 |
| after | ordinary | compact | 1920x1080 | standard | 671 | 1213 | 768 | 228 | 34–34 | 22 | 22 | yes | no | 0 |
| after | ordinary | compact | 1366x768 | standard | 471 | 859 | 432 | 252 | 34–34 | 12 | 12 | yes | no | 0 |
| after | ordinary | compact | 1024x768 | standard | 348 | 640 | 432 | 252 | 34–34 | 12 | 12 | yes | no | 0 |
| after | ordinary | compact | 800x600 | standard | rail 64 | 700 | 264 | 252 | 34–34 | 7 | 7 | yes | no | 0 |
| after | ordinary | comfortable | 1920x1080 | standard | 671 | 1213 | 728 | 268 | 56–56 | 13 | 13 | yes | no | 0 |
| after | ordinary | comfortable | 1366x768 | standard | 471 | 859 | 392 | 292 | 56–56 | 7 | 7 | yes | no | 0 |
| after | ordinary | comfortable | 1024x768 | standard | 348 | 640 | 392 | 292 | 56–56 | 7 | 7 | yes | no | 0 |
| after | ordinary | comfortable | 800x600 | standard | rail 64 | 700 | 224 | 292 | 56–56 | 4 | 4 | yes | no | 0 |
| after | ordinary | touch | 1920x1080 | standard | 671 | 1213 | 738 | 258 | 57–57 | 12 | 12 | yes | no | 0 |
| after | ordinary | touch | 1366x768 | standard | 471 | 859 | 402 | 282 | 57–57 | 7 | 7 | yes | no | 0 |
| after | ordinary | touch | 1024x768 | standard | 348 | 640 | 402 | 282 | 57–57 | 7 | 7 | yes | no | 0 |
| after | ordinary | touch | 800x600 | standard | rail 64 | 700 | 234 | 282 | 57–57 | 4 | 4 | yes | no | 0 |

Screenshots: `playwright/ws1measure/before-*.png` (original screen) and
`playwright/ws1measure/after-<cart>-<mode>-<WxH>.png`. Raw data: `measure-before.json`,
`measure-after.json`.

## Acceptance journeys (real Electron renderer, Playwright, screenshots inspected)

| Journey | Covers | Result |
|---|---|---|
| `ws1measure` | Stress and ordinary 25-line carts, row counts per viewport and density, warning state. Gates: ≥ 20 ordinary rows at 1920×1080 compact (stress cart); ≥ 3 ordinary rows with scanner, checkout band and no overflow at 800×600 compact and touch (ordinary cart) | passed |
| `ws2checkout` | Scans (Enter, Tab, no suffix, focused fractional entry). A sale with a new customer, 10% discount and a held draft stays **identical** through preset, side and density changes, keyboard and pointer resize, Apply and Cancel. Scanner/F9/race safety while editing. Exact cash from the page (Shift+F9) and from the dialog; 2 sales uploaded | passed |
| `ws3persist` | Section dragged (pointer), section moved (keyboard), panel dragged across, separator dragged. Apply, restart, restored. Cancel and Restore→Cancel write nothing; Restore→Apply deletes and survives restart. Cashier/manager isolation (real sign-out). 800×600 shrink and 1920 grow recover 70% with storage unchanged. Settings tab apply | passed |
| `ws4touch` | Touch only: cards, keypad 1.5, +1, line-menu remove, Exact cash, upload. Refund by touch accepted. Rail browser at 800×600 keeps the cart. Finger drag across the region boundary and swipe through the lines move nothing. Touch resize then Cancel. Every control ≥ 44×44 in selling, More menu, line menu, rail and editor | passed |
| `ws5matrix` | EN/AR × light/dark × 4 sizes × compact/touch (32 states), each preset × both sides, rail open, More menu, editor, offline warning at 2 sizes (43 states). No horizontal or page overflow, totals and Pay fully visible, nothing off-screen, no overlapping controls, touch targets ≥ 44. Scanner focus works after menu close, outside click, preset+Apply, Cancel and resize | passed |

Runtime recorded by `ws5matrix`: Electron 39.8.10 / Chromium 142.0.7444.265. Native Popover,
container queries and CSS anchor positioning are all available (`playwright/ws5matrix/matrix.json`).

### Existing journeys updated and re-run

Selectors only; no business or security assertion was removed:
- `qc3actions`: More → Quick create….
- `qc4mixedtaxe2e`: Remove via the line menu; discount, hold and recall via the toolbar.
- `qc5touch`: the band's Exact cash; the rail instead of the cart sheet; overflow-aware Refund by touch.
- `qc2offline`: More → Quick create….
- `qc4mixedtax`, `qc6receipts`: overflow-aware Refund.

**Closeout sweep on the final code** (`closeout-sweep.log`, one run, all against the fingerprint
above):

| Journey | Result |
|---|---|
| `ws1measure` | passed |
| `ws4touch` | passed |
| `ws5matrix` | passed |
| `ws2checkout` | passed |
| `qc4mixedtaxe2e` | passed |
| `qc5touch` | passed |
| `smoke` | passed |
| `qc3actions` | passed |

Earlier in the session, before the closeout changes, `e2offers`, `qc4mixedtax`, `qc2offline` and
`qc6receipts` passed. The closeout changes only touch-toolbar overflow, the checkout band layout and
comfortable row padding, and `ws5matrix` covers those. Those four journeys were **not** re-run on the
final fingerprint.

### The mixed-tax journey failure (diagnosed)

**What failed.** One earlier run of `qc4mixedtaxe2e` passed parts L and A–E, then failed at part F with
`F: upload attempted: {"ok":false}` after 120 s.
- Logs preserved, read-only: `qc4mixedtaxe2e-failure/failed-run-result.json` (incl. the main-process
  trace), `failed-run-console.log`, and the passing re-run's files next to them.

**Mechanism, from the trace.**
- Part F restarts the disposable backend (`restartServer`: stop, then poll `/up` until it answers).
- Only after that does the journey register `proxy.hold('lost-upload', …)` to capture and delay the
  next upload.
- After part E's refusal, the queued sale has an exponential-backoff retry scheduled in the main-process
  sync worker.
- In the failed run the trace shows that retry firing in the gap: the register's `/up` probe fails,
  `/up` answers 200, then `POST /invoices/upload` returns **201 `DESKTOP_INVOICE_UPLOADED`**, all before
  the hold exists.
- The queue becomes `synced`, so the journey's later `uploadNow()` calls have nothing to send and the
  hold can never capture anything.

**Equivalent baseline evidence (unmodified `main`).**
- Where: registry slot **desktop-2**, claimed, detached at `7d3a59c`, then released and switched back to
  `docs/workspace-policy`.
- Setup: the same guarded disposable backend fixture, an isolated profile and the virtual print
  boundary.
- Probe: an untracked copy of the **baseline** journey changed in one place, a 15 s pause between the
  part-F restart and the hold registration that widens the window. Diff:
  `qc4mixedtaxe2e-failure/baseline-7d3a59c/probe-vs-baseline.diff`.
- Result on `main`: the register's own retry sent **1 upload before the hold existed**. The queue went to
  `synced` (attempt 2), and part F failed with the **identical** error, `F: upload attempted:
  {"ok":false}`. Evidence: `baseline-7d3a59c/console.log`, `baseline-7d3a59c/playwright/`,
  `repository-identity.txt`.

**Classification.** A harness / server-restart race in the journey itself, present on `main`. It is not
a product regression and not caused by this work. Neither the sync worker nor part F is touched by
this change.
- The harness fix is to register the hold before restarting the server (the proxy survives backend
  restarts).
- That fix is **not applied**, because the brief limits fixes to defects caused by this work. The race
  remains, so the journey can still fail intermittently.

## Checks (closeout, on the final fingerprint)

| Check | Baseline (unmodified `7d3a59c`) | Final |
|---|---|---|
| `npm run typecheck` | pass | pass (`closeout-typecheck.log`) |
| `npm run lint` | **fail**: 2 errors and 12 warnings in `tests/electron/support/cp3g5/seedReliability.mjs` and `tests/playwright/journeys/stage4ppcheckout.mjs` | **still fails** on exactly that baseline debt (2 errors, 12 warnings, same files); no problem in any changed file (`closeout-lint.log`). Repo-wide lint does **not** pass |
| `npx vitest run` | 175 files, 1844 tests pass | 178 files, **1865** tests pass (`closeout-test.log`) |
| `npm run test:sqlite:electron` | 466 pass, 62 skipped | **467** pass, 0 fail, 62 skipped (`closeout-sqlite.log`) |
| `node --test tests/sandboxGuard.test.mjs` | 33 pass (recorded after the first 2 new fixture refusals were added) | **34** pass, incl. 3 new fixture-argument refusals (`closeout-sandboxGuard.log`) |
| `npm run verify:print-boundary` | — | pass: production = OS boundary only, harness = virtual only |
| `npm run build` (typecheck + electron-vite build) | — | pass (`closeout-build.log`) |
| Acceptance and regression journeys | — | the 8 listed above, all passed in the closeout sweep |

Not run: `npm run test:cp3g5-harness`. Its lifecycle test runs the full live gate against a backend tree,
and this work does not touch the cp3g5 path.

No physical print job was possible: every journey build uses the virtual print boundary.

## Commits (local, not pushed)

- `3c15546` feat(pos): cart-first POS workspace with per-user layouts (54 files: source, unit and SQLite
  tests, architecture doc, two intentional deletions of the retired cart-width store).
- `2a384df` test(pos): POS workspace acceptance journeys and fixtures (14 files).
- This evidence set follows in a separate docs commit, as a curated subset (92 files, about 7 MB) of the
  ignored `docs/audits/pos-workspace/`. Full screenshot sets stay local.
- Recomputing the verified fingerprint from those two commits (the same paths diffed from `7d3a59c`
  plus the committed contents of the previously untracked files) gives
  `496d413050a8c41033a320e5082fa1912fcd8305a0cf88d2865b0d25b8d0f15d`, identical to the fingerprint
  that every closeout and integration check ran against.

## Pre-integration regression round (same fingerprint `496d4130…`)

Run before committing, with the same isolated setup:
- Journeys (`integration-regression.log`): `e2offers`, `qc4mixedtax`, `qc2offline` and `qc6receipts`
  all passed in one run.
- `npm run test:cp3g5-harness` with `POS_BACKEND_ROOT` = the fixture backend:
  - First run: 71 of 72. Test 18, the full live gate, exited 1 with "Electron SQLite suite failed with
    no child output forwarded" (`intermittent-failures/cp3g5-harness-failed-run.log`).
  - An immediate direct run of the official wrapper also failed
    (`intermittent-failures/cp3g5-live-gate-failed-direct-run.log`).
  - After that: 3 more official wrapper runs passed, 5 runs of an output-capturing copy (outside the
    repository) passed, a run right after a journey passed, and the **full harness passed 72/72**
    (`integration-cp3g5-harness-2.log`).
  - On `main` content (slot desktop-2, `1c3bcbf`), 1 run passed.
  - **Classification: intermittent, root cause unresolved.** The failing runs' suite output was
    discarded by the wrapper by design, and no failure recurred with output captured. The only pattern
    is that both failures were the first two runs after a long journey batch. A deliberate repeat of
    that sequence did not reproduce it. Not counted as fixed.
- `qc6receipts` re-runs:
  - Feature: passed, **failed once** (part 3, the 58mm print refused before dispatch with
    `RECEIPT_QR_INVALID`; `intermittent-failures/qc6receipts-failed-*`), then passed.
  - `main` content: 2 of 2 passed (`qc6receipts-main-1c3bcbf/`).
  - The check renders the receipt in a separate `data:`-URL window (no preload, no renderer bundle) and
    decodes its QR from the captured image. Nothing this feature changed is loaded there or feeds it.
  - **Classification: intermittent, root cause unresolved.** No evidence links it to this work, and it
    was not reproduced on `main`.
- The known `qc4mixedtaxe2e` part-F harness race (above) is unchanged and still unfixed.

## Findings outside the feature, fixed or recorded

- **Fixed:** a page-level scroll that already existed. Each cart line's visually hidden SKU text is
  `position: absolute`, and its containing block was the app's `main`, so the hidden texts escaped
  the lines scroller and stretched the page. This explains the scrollbar in the baseline screenshots
  and the 342–1475px measured mid-way.
  - The lines scroller and the product scroller are now positioned.
  - `ws5matrix` asserts page overflow is 0 in every state.
- **Recorded (harness only):** an in-page Playwright `waitForFunction` loop delayed the scanner
  detector's 60ms no-suffix completion timer by more than 10s.
  - Polled from Node, every suffix lands in 130–240ms (probe recorded during the session).
  - `scanBurst` now polls from Node. No product change was needed.

## Remaining limitations

- **Row counts below 1920×1080:** fewer than 20 rows at every smaller size (see above). The
  comfortable and touch densities show 11–13 ordinary rows at 1920×1080.
- **Not re-run on the final fingerprint:** `e2offers`, `qc4mixedtax`, `qc2offline` and `qc6receipts`
  passed before the closeout changes but were not re-run afterwards.
- **Long names at 800×600 touch:** 3 rows (2 ordinary) for the long-name/offer stress cart, because
  long names wrap in a 700px cart. The ordinary cart shows 4.
- **The `qc4mixedtaxe2e` part-F harness race** (above) is unfixed and can fail intermittently. It also
  exists on `main`.
- **Desktop fractional quantities:** a desktop (non-touch) cashier still sets fractional quantities
  only with the existing `qty*code` scan prefix. "Set quantity" stays a touch-mode keypad, unchanged,
  to preserve business behaviour.
- **Old cart width:** the previous workstation-wide `ui.posCartWidth` value is no longer applied.
  Every user starts on Cart first until they customize.
- **Session-context changes:** a company or device change under the same e-mail is caught by main's
  context token at Apply (the editor then re-reads and asks to apply again). There is no separate
  push event.
- **Unused i18n keys:** `pos.cart.viewCart`, `closeCart`, `payShort`, `shortcutsHint` and
  `pos.layout.*` are no longer used; they were left in place for other branches.

## Workspace policy compliance (closeout)

- `CLAUDE.md` §15 (fixed, reusable worktree slots; shared registry) appeared during the session.
- This work is in slot **desktop-1**, confirmed in `/var/www/html/thinis-pos/WORKSPACES.md`.
- One extra folder created for the baseline experiment (`pos-desktop-baseline-7d3a59c`) violated the
  policy. It was removed straight away with `git worktree remove` (it held no unique data: only a
  generated `node_modules`). The experiment then ran in the free slot **desktop-2**, claimed and
  released in the registry. That slot is back on `docs/workspace-policy` @ `1c3bcbf`, clean, with my
  probe file and build output removed.
- The backend fixture folder `../pos-backend-pos-workspace` stays listed in the registry until desktop-1
  is released.

## Changed files

**Added**

- `src/main/database/migrations/0033_user_workspace_layouts.ts`
- `src/main/repositories/workspaceLayout.repository.ts`
- `src/main/services/workspaceLayout.service.ts`
- `src/renderer/src/assets/workspace.css`
- `src/renderer/src/modules/preferences/components/WorkspaceLayoutControls.test.ts`
- `src/renderer/src/modules/preferences/components/WorkspaceLayoutControls.vue`
- `src/renderer/src/modules/preferences/components/WorkspaceLayoutPreview.vue`
- `src/renderer/src/modules/preferences/posWorkspace.store.test.ts`
- `src/renderer/src/modules/preferences/posWorkspace.store.ts`
- `src/renderer/src/modules/preferences/workspaceLayout.test.ts`
- `src/renderer/src/modules/preferences/workspaceLayout.ts`
- `src/shared/contracts/posWorkspace.contract.test.ts`
- `src/shared/contracts/posWorkspace.contract.ts`
- `tests/electron/suites/workspaceLayout.suite.ts`
- `tests/playwright/journeys/ws1measure.mjs`
- `tests/playwright/journeys/ws2checkout.mjs`
- `tests/playwright/journeys/ws3persist.mjs`
- `tests/playwright/journeys/ws4touch.mjs`
- `tests/playwright/journeys/ws5matrix.mjs`
- `tests/playwright/support/workspace.mjs`

**Modified**

- `docs/architecture/pos-ux-architecture.md`
- `src/main/app/applicationServices.ts`
- `src/main/database/migrations/index.ts`
- `src/main/ipc/preferences.ipc.test.ts`
- `src/main/ipc/preferences.ipc.ts`
- `src/preload/posApi.ts`
- `src/preload/posApiSurface.test.ts`
- `src/renderer/src/assets/main.css`
- `src/renderer/src/assets/touch.css`
- `src/renderer/src/i18n/locales/ar.json`
- `src/renderer/src/i18n/locales/en.json`
- `src/renderer/src/main.ts`
- `src/renderer/src/modules/pos/pages/PosPage.offlineShiftAuthority.test.ts`
- `src/renderer/src/modules/pos/pages/PosPage.v3Behaviour.test.ts`
- `src/renderer/src/modules/pos/pages/PosPage.vue`
- `src/renderer/src/modules/pos/scanInputRouter.test.ts`
- `src/renderer/src/modules/pos/scanInputRouter.ts`
- `src/renderer/src/modules/pos/usePosShortcuts.ts`
- `src/renderer/src/modules/preferences/service.ts`
- `src/renderer/src/modules/preferences/userPreferences.store.ts`
- `src/renderer/src/modules/settings/pages/SettingsPage.vue`
- `src/renderer/src/shared/components/common/AppDropdown.vue`
- `src/renderer/src/shared/components/common/icons.generated.ts`
- `src/renderer/src/shared/components/pos/CartLineItem.vue`
- `src/renderer/src/shared/components/pos/CartPanel.vue`
- `src/renderer/src/shared/components/pos/OrderTotals.vue`
- `src/renderer/src/shared/components/pos/PosWorkspaceShell.test.ts`
- `src/renderer/src/shared/components/pos/PosWorkspaceShell.vue`
- `src/renderer/src/shared/components/pos/ProductCard.vue`
- `src/renderer/src/shared/components/pos/QuantityControl.vue`
- `src/renderer/src/shared/components/pos/QuickActionsBar.vue`
- `src/renderer/src/shared/components/pos/ScanEntry.vue`
- `src/renderer/src/shared/components/pos/types.ts`
- `src/shared/constants/ipcChannels.ts`
- `src/shared/validators/ipc.validators.ts`
- `tests/electron/index.ts`
- `tests/electron/suites/schema.suite.ts`
- `tests/electron/support/realRepositories.ts`
- `tests/electron/support/sandbox/guiFixture.php`
- `tests/playwright/journeys/qc2offline.mjs`
- `tests/playwright/journeys/qc3actions.mjs`
- `tests/playwright/journeys/qc4mixedtax.mjs`
- `tests/playwright/journeys/qc4mixedtaxe2e.mjs`
- `tests/playwright/journeys/qc5touch.mjs`
- `tests/playwright/journeys/qc6receipts.mjs`
- `tests/sandboxGuard.test.mjs`

**Deleted** (the retired renderer cart-width store)

- `src/renderer/src/modules/preferences/cartLayout.store.test.ts`
- `src/renderer/src/modules/preferences/cartLayout.store.ts`

Outside git (ignored): `docs/audits/pos-workspace/` evidence. Fixture backend worktree `../pos-backend-pos-workspace`: no tracked changes; it has generated `vendor/`, `node_modules/`, `public/build/` and an APP_KEY-only `.env`.

No new dependencies. Six Material Symbols paths were added to `icons.generated.ts` by the documented process (`npm pack` into an isolated folder, `d` attributes copied).

## Evidence index

- `BASELINE.md`, `baseline/*.log`: unmodified checks and the before measurement.
- `playwright/ws1measure/`: `before-*.png`, `after-*.png`, `measure-before.json`,
  `measure-after.json`.
- `playwright/ws2checkout/`, `ws3persist/`, `ws4touch/`, `ws5matrix/` (incl. `matrix.json`):
  screenshots and `result-*.json`.
- `final-*.log`: final typecheck, tests, lint, SQLite, print boundary and sandbox guard.
- `run-journey.sh`: how the journeys were run (Xephyr display `:97`, backend fixture worktree).
