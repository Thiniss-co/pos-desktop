# POS workspace — baseline (before any production change)

Branch `feat/pos-workspace` at `7d3a59c` (desktop) / detached backend `991bc1e`. Recorded 2026-10-06.

## Checks (unmodified source)

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | **fail — pre-existing**: 2 errors in `tests/electron/support/cp3g5/seedReliability.mjs` (missing return types), 12 prettier warnings there and in `tests/playwright/journeys/stage4ppcheckout.mjs` |
| `npx vitest run` | pass — 175 files, 1844 tests |
| `npm run test:sqlite:electron` | pass (62 skipped) |
| `node --test tests/sandboxGuard.test.mjs` | pass (33, incl. the two new `create-named-products` refusals) |

Logs: `baseline/*.log`.

## Measured screen (ws1measure, phase `before`)

Real Electron renderer on a nested Xephyr display (2000×1200, no window manager) so the content size is
exact; the user's display clamps the window to its 1919×1043 work area. Viewport, DPR 1, zoom 1 are
asserted per size. 25 lines (WS-01…WS-25; three fractional, one offer line). Screenshots
`playwright/ws1measure/before-*.png`; raw numbers `playwright/ws1measure/measure-before.json`.

| Mode | Size | State | Viewport | Catalog px | Cart px | Lines px | Cart chrome px | Row px | Fully visible rows | …ordinary | Footer visible |
|---|---|---|---|---|---|---|---|---|---|---|---|
| desktop | 1920x1080 | standard | 1920×1080 | 1437 | 420 | 249.7 | 738.3 | 101–129.8 | 2 | 2 | true |
| desktop | 1366x768 | standard | 1366×768 | 923 | 380 | 120 | 556 | 101–150 | 1 | 0 | false |
| desktop | 1024x768 | standard | 1024×768 | 621 | 340 | 120 | 556 | 101–170.3 | 1 | 0 | false |
| desktop | 800x600 | standard | 800×600 | 776 | hidden | — | — | 0–0 | 0 | 0 | false |
| desktop | 800x600 | cart-sheet-open | 800×600 | 776 | 800 | 120 | 480 | 101–109.5 | 1 | 1 | false |
| touch | 1920x1080 | standard | 1920×1080 | 1437 | 420 | 126.3 | 861.7 | 121–137.8 | 1 | 1 | true |
| touch | 1366x768 | standard | 1366×768 | 923 | 380 | 120 | 556 | 121–158 | 0 | 0 | false |
| touch | 1024x768 | standard | 1024×768 | 621 | 340 | 120 | 556 | 121–178.3 | 0 | 0 | false |
| touch | 800x600 | standard | 800×600 | 776 | hidden | — | — | 0–0 | 0 | 0 | false |
| touch | 800x600 | cart-sheet-open | 800×600 | 776 | 800 | 120 | 480 | 121–121 | 0 | 0 | false |
| desktop | 1920x1080 | offline-notice | 1920×1080 | 1437 | 420 | 249.7 | 738.3 | 101–129.8 | 2 | 2 | true |
| desktop | 1366x768 | offline-notice | 1366×768 | 923 | 380 | 120 | 556 | 101–150 | 1 | 0 | false |

Note: the two `offline-notice` rows are NOT a warning state — the connectivity monitor still reported
Online when they were taken (see `before-offline-*.png`); the journey now waits for the notice.

## Actual causes

1. **Narrow cart.** 420 / 380 / 340px at ≥1600 / ≥1200 / <1200 while the catalog takes 1437 / 923 / 621px.
   Long names wrap to 2–3 lines inside the ~260px name column, so 16 of 25 lines wrap at 1920 and 24 of 25 at 1024.
2. **Two-row line layout.** Every line is name/remove on one grid row and unit price + 40px stepper +
   total on a second, with 24px padding: the *shortest* line is 101px (121px in touch mode).
3. **Cart chrome.** 738px of the 1020px cart column at 1920×1080 is not lines: title row, customer card,
   scan label + 56px field + multiplier row + result strip, 60px quick-action tiles, column header,
   framed totals with a 30px figure, a 56px Pay button and a hint line (862px in touch mode, with the touch bar).
4. **Floor, then the column scrolls.** At 768px tall the lines region hits its 120px minimum and the
   whole cart column scrolls: the totals and Pay are pushed below the fold (footer not fully visible).
5. **Below 900px** the cart is hidden (0 rows) behind the compact bar until the sheet is opened.
6. Catalog banners (refresh result, automatic-printing setup) take catalog height only; they do not
   affect the cart.
