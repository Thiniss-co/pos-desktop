# Thinis POS V3 — Claude Design reference

This folder is the durable, local copy of the Claude Design project the V3 redesign is built
from, so implementation can resume without network access to the design tool.

- Design project: `claude.ai/design/p/661a182c-5ba2-4dcb-81ca-4b3ec2752ad2`, titled "V3 ZIP upload
  request". Its primary file is `Thinis POS Prototype.dc.html`.
- Imported on 2026-09-28 through the `DesignSync` design tool with read-only `get_project`,
  `list_files` and `get_file` calls. Nothing was written back to the design project.

## Contents

| Path                                  | What it is                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `source/Thinis POS Prototype.dc.html` | The connected prototype, verbatim. It is the visual authority: all screens, dialogs, states, EN/AR, light/dark, and the resize logic. |
| `source/pos-proto-data.js`            | Its UI strings (EN + AR) and **synthetic** sample data. The data is never used in the app.                                            |
| `source/support.js`                   | The design-component runtime that renders the prototype. It loads React from unpkg and is used only for reference rendering.          |
| `reference/*.png`                     | Screenshots of the prototype, rendered locally. See "Reference renders" below.                                                        |
| `IMPLEMENTATION.md`                   | The implementation guide, the page-by-page matrix, deviations and verification status.                                                |
| `ACCEPTANCE.md`, `acceptance/`        | The acceptance record: verified desktop content digest, backend HEAD and dirty set, fixtures, gate results and known limitations.     |
| `verification/final-2026-09-28/`      | The acceptance screenshots (134 real captures) with `manifest.json`. The older files directly in `verification/` are superseded.      |

Design-project files that were **not** copied, and why:

- `export/*/code.html` holds the 101 original Stitch screens, which the prototype consolidates.
  Their audit is summarised below and was read from the project.
- `export/*/screen.png` holds 8 screenshots, larger than the design tool's 256 KiB file limit, so
  they arrive truncated. The local renders replace them.
- `uploads/*.zip` holds the source archives.
- `uploads/pos-1.webp` is a third-party layout reference only; it was not used as a source.

### Findings from the design project's own audit and progress record

The audit is `handoff/01-export-audit.md`; the progress record is `PROGRESS.md`.

- The prototype is the connected, audited consolidation of the Stitch export. Where the two
  disagree, the prototype wins.
- It fixes the export's defects:
  - Wrong receipt maths and mixed receipt sample data.
  - Clipped "Confirm" labels.
  - Arabic-Indic digits, where the rules require Latin digits in both languages.
  - The wrong Arabic brand.
  - Jargon on the print-outcome screens.
  - All-caps eyebrows, where the rules require sentence case.
  - Unsupported receipt-profile sub-navigation ("Barcode & scanner", "Payment terminals").
- The dark primary is `#5B57E8`, not `#6366F1`, so white text reaches at least 4.5:1.
- Product cards may show a backend product image, but the endpoint was an _assumption_. The app
  has no product-image contract, so V3 cards use the monogram band (see IMPLEMENTATION.md, D-05).

## Reference renders

`reference/` is produced by rendering the prototype off-screen in Electron. The renderer:

- serves `source/` over localhost;
- patches a temporary copy so the component instance is exposed as `window.__proto`;
- sets `lang` and `theme` through that instance, and drives routes and dialogs with the
  prototype's own state and buttons;
- captures each page.

The renderer lives outside the repository. Its shot list names each file
`<screen>_<lang>_<theme>[_<size>].png`. Sizes default to 1366×768; 1920×1080, 1024×768 and
800×600 are named explicitly.

## Icons

`src/renderer/src/shared/components/common/icons.generated.ts` embeds path data from
`@material-symbols/svg-400@0.47.5` (Outlined, weight 400, Apache-2.0), limited to the glyphs the
app uses. To add an icon:

1. `npm pack @material-symbols/svg-400@0.47.5` into a scratch folder and extract it.
2. Copy the `d` attribute of `package/outlined/<name>.svg` into `ICON_PATHS`.

`expand_more` and `expand_less` are the font-ligature aliases of `keyboard_arrow_down` and
`keyboard_arrow_up`.

## Fonts

The fonts are bundled from `@fontsource` (see `src/renderer/src/assets/fonts.css`):

- Plus Jakarta Sans
- IBM Plex Sans Arabic
- JetBrains Mono

No remote font or icon request exists in the app.
