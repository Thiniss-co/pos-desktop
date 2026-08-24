# Design System — Modern Ledger

Narrative and evidence behind [.ai/guidelines/design-system.md](../../.ai/guidelines/design-system.md).
This is the pre–Phase 3 design checkpoint: token system, `light | dark | system` theming, restyled
current screens, and the Phase 3 presentational component library the next phase will assemble.

## Skills used

| Skill                 | What it changed about the work                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui-ux-pro-max`       | Set the priority order — accessibility and touch/interaction targets (44px minimum, no hover-only actions, visible feedback) before visual polish; pushed semantic tokens over raw hex and `role="alert"`/no-color-only-status as hard requirements, not suggestions.     |
| `frontend-design`     | Kept the system specific to a cashier ledger rather than a generic admin-panel default: one signature move (the container-based status system driven directly by the contrast gate) instead of scattered decoration, and copy in the interface's own active voice.        |
| `modern-web-guidance` | Confirmed Electron's bundled Chromium is a fixed, modern target, so `light-dark()`, CSS nesting-free `color-scheme`, and logical properties are safe to use with no fallback — recorded as the browser-support policy below instead of hand-rolled dark-mode duplication. |

**Browser support policy:** Electron 39 ships a modern Chromium; Baseline-newly-available CSS
(`light-dark()`, `color-scheme`, `:focus-visible`, logical properties) is used with no fallback.

## Token architecture

| File                                         | Contents                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/assets/tokens.css`         | Type scale, font stacks, spacing (4px base), radius, sizing, motion, z-index. No color.                                       |
| `src/renderer/src/assets/themes/palette.css` | All semantic color tokens, defined **once each** via `light-dark(<light>, <dark>)`.                                           |
| `src/renderer/src/assets/base.css`           | Reset, `:focus-visible` ring, `.numeric` utility, `prefers-reduced-motion`.                                                   |
| `src/renderer/src/assets/main.css`           | Cross-page layout composition only (`.readiness-list`). Everything page-specific moved into each page's own `<style scoped>`. |

### Why `light-dark()` instead of a `light.css` / `dark.css` split

The original plan (before implementation) called for `themes/light.css` + `themes/dark.css`, each
holding a `:root` / `:root[data-theme="dark"]` block. Implementing that literally would have meant
defining the same ~50 semantic tokens twice, with a third `@media (prefers-color-scheme: dark)`
block needed to make `system` mode work without JavaScript — three copies of every token to keep in
sync. `light-dark()` (Baseline since Chromium 123, safe per the browser-support policy above) takes
both values in one declaration and resolves per the element's computed `color-scheme` — which
`theme.store.ts` already needs to set for the `color-scheme` CSS property itself. One file, one
declaration per token, and `system` mode requires no `@media` duplication at all: the browser
re-evaluates `light-dark()` live against `prefers-color-scheme` whenever `color-scheme` is
`light dark`. This is a **disclosed deviation from the literal file-layout suggestion**, not from
its intent — every semantic token, every approved hex value, and the "define once" requirement
(design brief Checkpoint 3, item 1) are all still delivered, more simply.

## Contrast gate

Both palettes were checked with a relative-luminance WCAG calculation. All pairs below pass at
their required ratio, with four conflicts resolved by usage rule or an added outline rather than by
changing an approved base color (see `.ai/guidelines/design-system.md` for the resulting rules).

### Verified-passing pairs (selection)

| Pair                               |     Light |       Dark | Need |
| ---------------------------------- | --------: | ---------: | ---: |
| body text / background             |     16.34 |      14.39 |  4.5 |
| primary button label / face        |     21.00 |      13.11 |  4.5 |
| secondary button label / face      |      6.46 |       8.59 |  4.5 |
| transaction button label / face    |      8.26 |       8.26 |  4.5 |
| focus ring / background            |      3.90 |       8.65 |  3.0 |
| focus ring / surface-container     |      3.51 |       7.67 |  3.0 |
| `*-container` text pairs           | 4.57–8.49 | 6.95–11.11 |  4.5 |
| outline / surface (control border) |      4.25 |       5.84 |  3.0 |

### Conflict 1 — decorative-only tokens fail 3:1

| Token                             | vs surface | Verdict   |
| --------------------------------- | ---------: | --------- |
| light `outline-variant` `#c6c6cd` |       1.62 | fails 3:1 |
| dark `outline-variant` `#444749`  |       1.98 | fails 3:1 |
| dark `border-strong` `#374151`    |       1.80 | fails 3:1 |
| dark `divider-subtle` `#273244`   |       1.43 | fails 3:1 |

**Resolution:** WCAG 1.4.11 requires 3:1 only for boundaries that identify a control or state.
These three tokens are restricted to non-essential separators; every control boundary uses
`outline` instead, which passes everywhere it's needed (4.25/4.05 light, 5.84/4.63 dark).

### Conflict 2 — dark secondary button doesn't separate from any dark surface

Face-vs-background is 2.16, and worse elevated (1.91 / 1.71 / 1.67 / 1.44). Label contrast is fine
(8.59) — the button is readable but hard to _locate_.

**Resolution:** every dark secondary button carries a mandatory 1px `#91d5b1` border
(`--color-secondary-outline`) — 10.90 vs page background, 5.05 vs the button's own face. `#91d5b1`
is never used as a background (white text on it is 1.70, a fail).

### Conflict 3 — transaction-accent pressed face fails under its label color

`#111827` on `#b45309` (the approved `transaction-accent-active`) is 3.53, short of 4.5.

**Resolution:** the pressed state renders as a 2px inset ring over the
`transaction-accent-hover` face (`#d97706`, label contrast 5.57), never as a label-bearing
background. Both approved values stay in use.

### Conflict 4 — bare status text fails at high elevation, both themes

| Theme | Failing pairs                                                                         |
| ----- | ------------------------------------------------------------------------------------- |
| light | `success`/`warning`/`information` text on `surface-container` and above (4.30 → 3.58) |
| dark  | `error` `#f87171` on `surface-selected`/`container-highest`/`bright` (4.33 → 4.16)    |

**Resolution:** bare status text is allowed only on `surface`, `surface-container-lowest`, and
`surface-container-low`. At `surface-container` and above, status renders through its paired
container tokens instead — the reason `AppStatusChip` and `AppBanner` are container-based
components rather than colored-text spans.

### Accepted exemption

Disabled text is 3.60 (light) / 3.01 (dark) — WCAG 1.4.3 explicitly exempts inactive controls.
Accepted, with the compensating rule that disabled state is never color-only (see the enforceable
guideline).

## Theme preference architecture

Mirrors the existing locale preference hop-for-hop:

```
ThemeSwitcher.vue → theme.store.ts → PreferencesService → window.posApi.preferences →
preload/posApi.ts → IPC_CHANNELS.preferencesGetTheme/SetTheme → main/ipc/preferences.ipc.ts →
themePreferenceSchema (zod) → AppSettingsRepository → SQLite (`ui.theme` in `app_settings`)
```

- **Pre-mount resolution:** `main.ts` awaits `useThemeStore(pinia).initialize()` right after the
  locale store, before `.mount('#app')` — same pattern, same file, same failure handling
  (`applyThemeToDocument('system')` as the catch-branch fallback).
- **Zero-flash `system` mode:** `applyThemeToDocument()` sets `color-scheme: light dark` and
  leaves `data-theme` unset for `system`; `palette.css`'s default `:root { color-scheme: light
dark; }` means the correct theme paints from the very first frame, before any JavaScript runs,
  and re-paints live on an OS theme change with no listener at all. `theme.store.ts`'s
  `matchMedia` listener exists only to keep the `resolvedTheme` ref accurate for JS-side display
  (e.g. `ThemeSwitcher`'s pressed state) — it starts on entering `system`, stops on leaving it, and
  is proven not to leak by `theme.store.test.ts`.
- **Last-write-wins:** `latestRequestedTheme` guards rapid switching exactly like
  `latestRequestedLocale` does for locale — covered by a deferred-promise race test.
- **Persistence failure:** caught, applied visually anyway (`persistenceFailed` ref goes true), the
  session is never blocked — no UI currently surfaces `persistenceFailed` beyond the ref existing
  for a future toast; see Known gaps below.
- **No new generic IPC:** only two narrowly-typed channels were added
  (`preferences:get-theme`/`set-theme`), validated main-side to exactly `light | dark | system`.

## Component inventory

| Component                                                                                                         | Existing/Created  | Production/Dev-only                                 | Presentational/Connected       | EN/AR | Light/Dark |
| ----------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------- | ------------------------------ | ----: | ---------: |
| AppButton, AppIconButton, AppPanel, AppDialog, AppConfirmDialog, AppDropdown, AppTable, AppListRow, ThemeSwitcher | Created           | Production                                          | Presentational                 |     ✓ |          ✓ |
| AppField-equivalents: AppInput, AppSelect, AppCheckbox                                                            | Created           | Production                                          | Presentational                 |     ✓ |          ✓ |
| AppBanner, AppToast, AppStatusChip, AppEmptyState, AppLoadingSkeleton, AppInlineError                             | Created           | Production                                          | Presentational                 |     ✓ |          ✓ |
| PageHeader                                                                                                        | Created           | Production                                          | Presentational                 |     ✓ |          ✓ |
| LocaleSwitcher, ConnectivityBanner                                                                                | Restyled in place | Production                                          | Connected (own store)          |     ✓ |          ✓ |
| All 12 routed pages + AppLayout + PublicLayout                                                                    | Restyled          | Production                                          | Connected                      |     ✓ |          ✓ |
| 21 components under `shared/components/pos/` (see list below)                                                     | Created           | **Dev-only** (no production route imports them yet) | Presentational, fixture-driven |     ✓ |          ✓ |
| `modules/devGallery/` (fixtures + gallery page + route)                                                           | Created           | Dev-only, tree-shaken from production build         | Presentational                 |     ✓ |          ✓ |

Phase 3 presentational set: `PosWorkspaceShell`, `ShiftStatusControl`, `ProductSearchBar`,
`CategorySelector`, `ProductCard`, `ProductRow`, `BarcodeFeedback`, `StockStatus`, `CartPanel`,
`CartLineItem`, `QuantityControl`, `CustomerSelector`, `OrderTotals`, `DiscountControl`,
`PaymentMethodTile`, `NumericAmountInput`, `PaymentDialog`, `SplitPaymentRow`, `ActionBar`,
`PermissionNotice`, `CommercialAccessNotice`, `SyncStateNotice`.

## Dev-only gallery — proof of production exclusion

Verified by running an actual production build and inspecting the output in this session:

```
$ npm run build
✓ 239 modules transformed.
../../out/renderer/assets/index-*.css   40.27 kB
../../out/renderer/assets/index-*.js   654.86 kB

$ grep -c "__dev/gallery\|Modern Ledger design gallery\|shift-status-control\|pos-workspace-shell\|dev-gallery" \
    out/renderer/assets/*.js out/renderer/assets/*.css
out/renderer/assets/index-*.css:0
out/renderer/assets/index-*.js:0
```

Zero matches, and only one JS/CSS chunk each — Rollup didn't just leave the gallery in an
unreferenced lazy chunk, it fully dead-code-eliminated the `import.meta.env.DEV`-gated array
(including the dynamic `import()`) because the condition folds to `false` at build time. The
route's `startupGuard` bypass (`meta.devOnly`) is covered by `guards.test.ts`; the exclusion
mechanism itself is covered by `devGallery.exclusion.test.ts` (source-level) plus the manual
build-and-grep above (this file, reproducible any time by running the same two commands).

## Known gaps / left out of scope

- **No bundled fonts.** Hanken Grotesk / Noto Sans Arabic / JetBrains Mono resolve to system
  fallbacks (`system-ui`, Tahoma/Arial, `ui-monospace`) on any machine without those fonts
  installed. Approved by the user rather than adding font files or a remote font request.
- **`persistenceFailed` has no visible UI yet.** `theme.store.ts` exposes the ref and `AppToast`
  exists as a primitive, but no page wires them together — flagged rather than silently
  guessed at, since the brief didn't specify exact toast copy/placement.
- **The 21 Phase 3 components are not imported by any production page.** That's intentional — this
  checkpoint is explicitly pre–Phase 3; wiring them to real cart/shift/payment state is Phase 3
  business logic, out of scope here per `no-go-rules.md`.
- **Visual/viewport matrix (1920×1080 → 1024×720, 4 theme/locale combinations) was not captured as
  screenshots** — this session has no way to launch the Electron GUI (see Manual verification
  below). `npm run typecheck`/`lint`/`test`/`build` all passed; the viewport matrix needs a human
  pass in a real window.

## Manual verification still owed

Electron cannot be launched headlessly from this environment in a way that proves anything — GUI
proof must come from the developer's own terminal running `npm run dev:linux` (or platform
equivalent), per this project's own session notes on `ELECTRON_RUN_AS_NODE` breaking `npm run dev`
under an agent shell. The checklist in `.ai/guidelines/design-system.md` and this file's contrast
tables are what a human tester should confirm against the running app.
