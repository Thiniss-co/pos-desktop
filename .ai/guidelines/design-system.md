# Design System Rules — Modern Ledger

Enforceable rules for the light/dark token system. Narrative, contrast tables, and rationale live
in [docs/architecture/design-system.md](../../docs/architecture/design-system.md).

## Tokens

- All color values live in `src/renderer/src/assets/themes/palette.css`, one definition per
  semantic token via `light-dark(<light>, <dark>)`. **No other file may contain a raw hex color,
  `rgb()`, or `hsl()` literal.** Components consume only `var(--color-*)`.
- Non-color primitives (type scale, spacing, radius, motion, sizing, z-index) live in
  `src/renderer/src/assets/tokens.css`.
- Every new component gets its own `<style scoped>` block. Do not add page-specific rules back
  into `main.css` — it holds only cross-page layout composition (currently: `.readiness-list`).

## Contrast usage rules (do not violate — see design-system.md for the numbers)

1. `--color-outline-variant`, `--color-border-strong`, `--color-divider-subtle` are **decorative
   separators only** (table rules, panel dividers). Every control boundary — input border,
   focusable edge, selected state, button outline — uses `--color-outline`.
2. The dark `secondary` button (`#0e573b`) always renders with its `--color-secondary-outline`
   border. `#91d5b1` is never a background.
3. The transaction-accent pressed state is a 2px inset ring using
   `--color-transaction-accent-active`, never a label-bearing background.
4. Bare semantic status text (`--color-success`, `--color-warning`, `--color-error`,
   `--color-information` used as a foreground) is permitted only on `--color-surface`,
   `--color-surface-container-lowest`, and `--color-surface-container-low`. On
   `--color-surface-container` and above, use the paired container tokens
   (`--color-success-container` + `--color-on-success-container`, etc.) — this is why
   `AppStatusChip`/`AppBanner` are container-based components, not colored text.
5. Disabled text/controls (3.60:1 light / 3.01:1 dark — WCAG 1.4.3-exempt) must never be the only
   signal of disabled state: pair with `aria-disabled`, `cursor: not-allowed`, and removed
   affordance.

## Typography

- `--font-ui` (Hanken Grotesk stack) swaps to `--font-ui-arabic` (Noto Sans Arabic stack)
  automatically under `html[dir="rtl"]`. Never hardcode a font-family in a component.
- Add class `numeric` (or use `--font-numeric` directly) on every money, quantity, total,
  timestamp, SKU, and barcode value, in both locales. `label-caps` uppercase/tracking is
  Latin-only — it resets under `[dir="rtl"]` automatically, do not override per-component.
- No bundled font files exist; the stacks resolve to system fonts. Do not add a font file or a
  remote font request without separate approval — the CSP blocks remote fonts anyway
  (`font-src 'self' data:` in the header policy, no `font-src` in the `index.html` meta policy).

## Theme preference

- Persisted via `preferences:get-theme` / `preferences:set-theme` IPC, mirroring the locale
  preference exactly (`ui.theme` in `app_settings`, validated to `light | dark | system` in main).
- Never use `localStorage`/`sessionStorage`/cookies for theme. Never expose `nativeTheme` or a
  generic settings channel to the renderer.
- `system` mode is resolved by CSS (`color-scheme: light dark` + `light-dark()`) with **zero
  JavaScript on the visual path** — `theme.store.ts`'s `matchMedia` listener only keeps the
  `resolvedTheme` ref accurate for JS consumers (e.g. `ThemeSwitcher`'s pressed state); it never
  re-applies anything to the document. Do not add a second mechanism.
- Resolve the theme in `main.ts` before `.mount('#app')`, exactly like locale.

## Components

- Reuse `shared/components/{common,forms,feedback,layout}/*` before writing new markup. Do not
  restyle a raw `<button>`/`<input>`/`<select>` in a page — use `AppButton`/`AppInput`/`AppSelect`.
- Phase 3 presentational components live in `shared/components/pos/`. They must never import the
  preload bridge, HTTP, the local database, main-process code, a business Pinia store, or a
  license/sync service — enforced by `importBoundary.test.ts`. They receive already-computed,
  pre-formatted values as props; they never calculate a total or a permission.

## Dev-only preview

- The design gallery (`modules/devGallery/`) is reachable only behind `import.meta.env.DEV`, is
  wired with a **dynamic** `import()` (never a static one) so a production build tree-shakes it
  entirely, and bypasses `startupGuard` via `meta.devOnly` rather than by weakening the guard for
  every route. Verify any change to it with `npm run build` and grep the output for a gallery-only
  string — see `devGallery.exclusion.test.ts` for the source-level half of this proof.
