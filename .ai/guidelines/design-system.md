# Design System Rules — Thinis POS V3

These are the enforceable rules for the V3 renderer design system, which supersedes "Modern
Ledger". The design source, the implementation guide and the page matrix live in
[docs/design/claude-v3/](../../docs/design/claude-v3/IMPLEMENTATION.md). The Modern Ledger rationale
is kept, for history, in [docs/architecture/design-system.md](../../docs/architecture/design-system.md).

## Styling

- **Tailwind CSS v4** is loaded through `@tailwindcss/vite`, with its entry in
  `src/renderer/src/assets/main.css`.
  - Only `tailwindcss/theme.css` and `tailwindcss/utilities.css` are imported. **Preflight is never
    loaded.**
  - The minimal reset lives in `assets/base.css`, inside `@layer base`.
  - Class detection is limited to the renderer source.
  - Never add the Tailwind CDN, and never add a second CSS framework.
- Style with utility classes in templates.
  - Use `<style scoped>` only where utilities cannot express something, and there reference
    `var(--color-*)` tokens only.
  - Do not put page-specific rules in `main.css`.
- Use logical utilities only (`ms`/`me`/`ps`/`pe`/`start`/`end`/`text-start`/`border-s`, …).
- Mirror only directional icons, via `AppIcon mirror-rtl`.

## Tokens

- **Every colour literal lives in `src/renderer/src/assets/themes/palette.css`.** No other file may
  contain a raw hex, `rgb()` or `hsl()` value.
  - Each token is `light-dark(<light>, <dark>)` and is registered with Tailwind (`@theme static`), so
    `bg-surf`, `text-muted` and the like just work.
  - The old Modern Ledger token names remain as aliases of the V3 values, for un-migrated CSS.
- Non-colour tokens live in `assets/tokens.css`: type scale, radii, elevation, breakpoints and motion.
  - The root font size stays at the browser's 16px, because every rem token assumes it. Body copy is
    15px (`--text-base`).
- Breakpoints:

  | Variant     | Width        |
  | ----------- | ------------ |
  | `wide`      | 900          |
  | `pills`     | 1100         |
  | `cartlg`    | 1200         |
  | `navlabels` | 1500         |
  | `hd`        | 1600         |
  | `short`     | height < 700 |

## Contrast usage rules

1. Every control boundary (input, select, stepper, outline button, radio tile) uses `border-control`
   (≥ 3:1). `line` and `line-strong` are decorative separators only.
2. Exactly one filled primary (indigo) action per view. Everything else is `secondary`, `outline`,
   `soft` or `ghost`.
3. A solid destructive button uses `danger` (white text ≥ 4.5:1 in both themes), never `err`.
4. Status is always colour **plus** icon **plus** text, through `AppStatusChip`, `AppBanner` or the
   top-bar pills.
5. Disabled is never colour alone. The fill drops out, the cursor changes, and `disabled` or
   `aria-disabled` is set.

## Typography

- Fonts are **bundled** from `@fontsource` in `assets/fonts.css`, so there is never a remote font
  request:
  - Plus Jakarta Sans for Latin UI.
  - IBM Plex Sans Arabic for Arabic UI, swapped automatically under `html[dir='rtl']`.
  - JetBrains Mono for codes.
- Add `numeric` to money, quantities, totals and timestamps: tabular figures in the UI face, Latin
  digits in both languages.
- Add `code` to SKUs, barcodes, invoice and reference numbers, and trace IDs: mono, LTR-isolated.
- Sentence case everywhere. No all-caps labels.

## Icons

- Use `AppIcon` for Material Symbols Outlined as inline SVG paths, from `icons.generated.ts`.
- No icon font and no icon CDN. `docs/design/claude-v3/README.md` explains how to add a glyph.

## Theme preference

This is unchanged from the previous system.

- The preference is persisted through `preferences:get-theme` / `preferences:set-theme`.
- `system` resolves in CSS through `color-scheme` plus `light-dark()`.
- Never use `localStorage`, `sessionStorage` or cookies for the theme.
- Theme changes must never alter thermal receipts:
  - Receipt previews are main-process PNGs.
  - Receipt-like HTML previews use `bg-paper text-paper-ink`.

## Components

- Reuse `shared/components/{common,forms,feedback,layout}/*` before writing new markup. The catalog
  is in the implementation guide, §3.
- Do not restyle a raw `<button>`, `<input>` or `<select>` in a page.
- `shared/components/pos/` stays pure presentation. It must never import the preload bridge, HTTP,
  the local database, main-process code or a business Pinia store; `importBoundary.test.ts`
  enforces this.

## IPC payloads

- Renderer services pass request payloads through `shared/utils/ipcPayload.ts` (`toIpcPayload`).
- Stores keep inputs in Vue refs (Proxies), and Electron's preload bridge cannot clone a Proxy.
- `toIpcPayload` copies plain data exactly, including `undefined` optionals. It **throws**
  `IpcPayloadError` (naming the path) for anything else, rather than converting it: non-finite
  numbers, `Date`, `Map`, class instances, functions, bigint, symbols, and cycles.
  - Never replace it with a JSON round-trip, which silently changes those values.

## Dev-only preview

This is unchanged. The design gallery (`modules/devGallery/`) is reachable only behind
`import.meta.env.DEV`, is loaded with a dynamic `import()`, and is excluded from production builds.
