# Thinis POS V3 — implementation guide and matrix

The redesign of the existing Electron + Vue 3 app from the Claude Design prototype (see
[README.md](README.md)). **The design is authoritative for visual composition. The existing
application contracts — stores, services, preload bridge and main process — are authoritative
for behaviour.** No business logic, IPC contract, main-process code or backend call changes as
part of this work.

Branch: `feat/claude-design-v3-redesign`.

---

## 1. Where the design lives

Primary: `source/Thinis POS Prototype.dc.html`. The template runs from line 30 to line 1100; the
logic from 1102 to 1644. Strings are in `source/pos-proto-data.js`, as `en` and `ar` objects.
Keys are referenced as `t.<key>` in the template.

| Prototype region                                             | Lines     | App target                                                                                                      |
| ------------------------------------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------- |
| Top bar and notices                                          | 30–72     | `app/shell/*`, `app/layouts/AppLayout.vue`                                                                      |
| POS selling: catalog, cart, compact bar                      | 74–223    | `modules/pos/pages/PosPage.vue`, `shared/components/pos/*`                                                      |
| Sales history                                                | 224–253   | `modules/sales/pages/SalesHistoryPage.vue`                                                                      |
| Sale detail                                                  | 254–313   | `modules/sales/pages/SaleDetailPage.vue`                                                                        |
| Refund flow: select, review, submitting, result, unavailable | 314–393   | `modules/refunds/components/RefundDialog.vue`                                                                   |
| Sync                                                         | 394–431   | `modules/sync/pages/SyncPage.vue`                                                                               |
| Offline stock                                                | 432–463   | `modules/preparation/pages/PreparationPage.vue`, `modules/offlineSale/components/OfflineSaleReadinessPanel.vue` |
| Settings: workstation and printer                            | 464–508   | `modules/settings/pages/SettingsPage.vue`                                                                       |
| Settings: receipt profile                                    | 509–557   | `modules/receiptProfile/components/ReceiptProfileSection.vue`                                                   |
| Company users                                                | 561–597   | `modules/companyUsers/pages/*`                                                                                  |
| Startup: activate, sign in, prepare, blocked                 | 598–663   | `app/layouts/PublicLayout.vue`, activation, auth, bootstrap and access pages                                    |
| Shift menu and user menu                                     | 666–688   | `modules/pos/components/ShiftMenu.vue`, `app/shell/UserMenu.vue`                                                |
| Compact nav drawer                                           | 689–703   | `app/shell/NavDrawer.vue`                                                                                       |
| Discount and customer dialogs                                | 704–755   | `PosPage.vue`                                                                                                   |
| Shortcuts, clear-cart, barcode-choice and rebuild dialogs    | 756–812   | `PosPage.vue`                                                                                                   |
| Open, pause and close shift dialogs                          | 813–864   | `modules/pos/components/ShiftDialogs.vue`                                                                       |
| Sign-out dialog                                              | 865–877   | `app/shell/SignOutDialog.vue`                                                                                   |
| Payment (tender and split)                                   | 878–947   | `shared/components/pos/PaymentPanel.vue`                                                                        |
| Done, pay-fail, abandon and stock-rejection dialogs          | 948–1020  | `PaymentPanel.vue`, `SaleRecoveryBanner.vue`                                                                    |
| Print (receipt preview)                                      | 1021–1065 | `modules/printing/components/ReceiptPreviewDialog.vue`                                                          |
| User edit and disable dialogs                                | 1066–1095 | `modules/companyUsers/*`                                                                                        |
| Toast                                                        | 1097–1099 | `shared/components/feedback/AppToast.vue`                                                                       |

**Reference renders:** `reference/<screen>_<lang>_<theme>[_<size>].png`, for example
`pos_ar_dark.png`, `pos_en_light_800.png`, `dlg_payment_en_light.png` and
`startup_signin_ar_dark.png`. Open the matching render before building a screen, and compare
your result against it.

## 2. Styling system

- **Tailwind CSS v4** runs through `@tailwindcss/vite`. The entry is `src/renderer/src/assets/main.css`.
  - Preflight is **not** loaded. The minimal reset is `assets/base.css`, in `@layer base`.
  - Only renderer sources are scanned for classes.
- Write styles as utility classes in templates. Use a `<style scoped>` block only for what utilities
  cannot express, and there reference `var(--color-*)` tokens only. **Never write a raw colour
  literal outside `assets/themes/palette.css`.**
- The theme mechanism is `light-dark()` tokens plus `color-scheme` on the root; `theme.store.ts`
  sets it. The `dark:` variant is therefore **never needed**: every token already swaps.
- **Colour utilities**, from `palette.css`:

  | Group                     | Utilities                                                                  |
  | ------------------------- | -------------------------------------------------------------------------- |
  | Surfaces                  | `page`, `surf`, `subtle`, `raised`                                         |
  | Separators                | `line`, `line-strong`                                                      |
  | Control borders (≥ 3:1)   | `control`                                                                  |
  | Text                      | `ink`, `muted`                                                             |
  | Primary                   | `pri`, `pri-hover`, `pri-press`, `pri-text`, `pri-soft`, `on-pri`, `focus` |
  | Status                    | `ok`/`ok-bg`, `warn`/`warn-bg`, `err`/`err-bg`, `info`/`info-bg`           |
  | Solid destructive         | `danger`, `danger-hover`                                                   |
  | Category pastels and inks | `cat-0` to `cat-5`, `cat-ink-0` to `cat-ink-5`                             |
  | Overlay                   | `overlay`                                                                  |
  | Thermal paper             | `paper`, `paper-ink`                                                       |

  For example: `bg-surf`, `text-muted`, `border-line`, `bg-pri text-on-pri`.

- **Type scale:**

  | Utility     | Size | Use            |
  | ----------- | ---- | -------------- |
  | `text-xs`   | 13px | minimum        |
  | `text-sm`   | 14px |                |
  | `text-base` | 15px | body           |
  | `text-md`   | 16px |                |
  | `text-lg`   | 17px | section titles |
  | `text-xl`   | 19px | dialog titles  |
  | `text-2xl`  | 20px |                |
  | `text-3xl`  | 24px | page titles    |
  | `text-4xl`  | 28px |                |
  | `text-5xl`  | 30px | total due      |
  | `text-6xl`  | 32px |                |

  Weights: `font-medium`, `font-semibold`, `font-bold`, `font-extrabold`.

- **Radii:**

  | Utility          | Size | Use            |
  | ---------------- | ---- | -------------- |
  | `rounded-md`     | 8px  | controls       |
  | `rounded-notice` | 10px | notices, tiles |
  | `rounded-lg`     | 12px | panels, cards  |
  | `rounded-xl`     | 16px | dialogs        |
  | `rounded-full`   |      | pills          |

  Shadows: `shadow-panel`, `shadow-pop`.

- **Breakpoints:**

  | Variant      | Width                 | What changes                     |
  | ------------ | --------------------- | -------------------------------- |
  | `wide:`      | ≥ 900                 | Below it, the layout is compact. |
  | `pills:`     | ≥ 1100                | Status-pill text appears.        |
  | `cartlg:`    | ≥ 1200                |                                  |
  | `xl:`        | ≥ 1280                |                                  |
  | `navlabels:` | ≥ 1500                | Nav labels appear.               |
  | `hd:`        | ≥ 1600                |                                  |
  | `short:`     | viewport height < 700 |                                  |

  The standard `sm`/`md`/`lg`/`2xl` variants remain available.

- **RTL:** use logical utilities only: `ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`, `text-start`/`text-end`,
  `border-s`/`border-e`, `rounded-s`/`rounded-e`. Never use `left`, `right`, `ml` or `mr`. Mirror
  directional icons only, with `<AppIcon mirror-rtl>` or `mirror-icon` on buttons: arrows, chevrons,
  first/last page, sign-out.
- **Numbers:** add `numeric` to money, quantities and totals. It gives tabular figures in the UI
  face; digits are already Latin in both languages via `shared/utils/format.ts`.
- **Codes:** add `code` (JetBrains Mono, LTR-isolated) to SKUs, barcodes, invoice numbers,
  references and trace IDs. Mixed-direction identifiers must stay LTR inside Arabic text.
- Sentence case everywhere. No all-caps eyebrows. The `PageHeader` `eyebrow` prop is accepted but
  no longer rendered.
- Exactly **one filled primary (indigo) action per view**. Everything else is `secondary`
  (outline), `ghost` or `soft`. Status is always colour **plus** icon **plus** text.

## 3. Component catalog

All paths are relative to `src/renderer/src/shared/components/`.

### `common/`

- **`AppIcon`**: `name: IconName`, `size=20`, `mirrorRtl`, `label?`. Decorative unless given a label.
  Icons come from `icons.generated.ts`; see README for adding one.
- **`AppButton`**
  - `variant`: `primary`, `transaction` (56px Pay), `secondary`, `outline`, `soft`, `ghost`,
    `danger`, `danger-outline`.
  - `size`: `sm` 36, `md` 44, `lg` 48, `xl` 52.
  - Also `icon`, `iconEnd`, `mirrorIcon`, `loading`, `disabled`, `fullWidth`, `type`.
  - Keeps the `.app-button--<variant>` hook.
- **`AppIconButton`**: `label` (required), `icon`, `variant` (`ghost` | `danger` | `outline`),
  `size` (`sm` 32 | `md` 40), `pressed`.
- **`AppDialog`**
  - `open`, `size` (`sm` 440 | `md` 480 | `lg` 820 | `xl` 1040), `role` (`dialog` | `alertdialog`),
    `closeLabel` (renders the ✕), `persistent`, `tone` (`standard` | `plain`), and
    `sheet="compact"`: below the `wide` breakpoint or on a `short` viewport, the dialog becomes a
    full-screen sheet with the header and footer pinned (used by the payment dialog).
  - Slots: `title`, `leading`, `header-extra`, `header-end` (before the ✕; the payment dialog's
    Total due), default (the scrolling body) and `actions` (the pinned footer).
  - Initial focus goes to `[data-autofocus]`, else the first control. Focus is trapped, and
    restored on close.
- **`AppConfirmDialog`**: an alert dialog with Cancel focused first.
- **`AppDropdown`** and **`AppMenuItem`**: popover menu. `v-model:open`, `label`, `align`,
  `width`, `triggerClass`, the `#trigger` slot, and a default slot whose `{ close }` scope
  receives the rows.
- **`AppKbd`**, **`AppSpinner`** and **`AppPill`** (top-bar status pill).
- **`AppPanel`**: a 12px card. Props: `padded`, `title`, `description`, and the `#header` slot.
- **`AppTable`**: a native table in a panel. Styles `th`/`td` itself; takes `label` and `framed`.
- **`types.ts`**: `PillTone`, `PILL_TONE_CLASS`, `PILL_TONE_TEXT`.

### `forms/`

- **`AppInput`**: `prefix` (for example the currency), `code`, `dir`, `inputmode`, `size="lg"`,
  `autofocus`, `hideLabel`, `hint`, `error`, the `#end` slot, and an exposed `focus()`.
- **`AppTextarea`** and **`AppSelect`**. `AppSelect` takes `size="sm"` and `inline`.
- **`AppCheckbox`**: `tile` gives the bordered row.
- **`AppSegmented`**: radio tiles. `layout` is `tile`, `stack`, `chip` or `icon-tile`; options
  carry `{ value, label, sub?, icon?, disabled? }`. It is a `radiogroup` with arrow keys, mirrored
  in RTL.
- **`AppStepper`**: `value`, `groupLabel`, `decreaseLabel`, `increaseLabel`, plus disabled flags.
  It is display-only and never does arithmetic.
- **`AppSwitch`**: the switch tile.

### `feedback/`

- **`AppStatusChip`**: `variant` (`success`, `warning`, `error`, `information`, `neutral`,
  `primary`), `icon?` and `size`.
- **`AppBanner`**: the notice. `variant` (`info`, `success`, `warning`, `error`, `neutral`),
  `title`, `icon`, `role`, `bar` (full-width strip) and `dismissLabel`, plus the `#action` slot.
- **`AppEmptyState`** (`icon`, `compact`), **`AppInlineError`**, **`AppLoadingSkeleton`**.
- **`AppProgress`**: `value` is 0–100, or `null` for indeterminate.
- **`AppSteps`**: numbered steps.
- **`AppToast`**.

### `layout/`

- **`PageHeader`**: `title`, `description`, `headingLevel`, and the `#actions`, `#badge` and
  `#meta` slots.
- **`PageContainer`**: the standard scrolling page body, `px-4 py-5` with a centred `max-w` column.

## 4. Rules for page work

1. **Behaviour is frozen.** Keep every store call, service call, emitted event, route push,
   computed business value and guard exactly as it is. Change markup and styling only.
   - Moving an existing action into a different visual place is fine. Inventing a new operation
     is not.
   - If the design shows an action the app cannot do, leave it out, or show it disabled with its
     real reason, and record it in §6.
   - If the app has a flow the design lacks, keep it and style it in the V3 language.
2. **No mock data, timers or fake success.** The prototype's sample data and `setTimeout`
   simulations never enter the app.
3. **i18n:** every visible string comes from `vue-i18n`, with EN/AR key parity.
   - Add keys to `en.json` and `ar.json` together. Never overwrite an existing key, and keep the files'
     2-space JSON formatting and key order. `i18n.test.ts` enforces EN/AR parity. (The merge helper
     used during the redesign was session tooling and is not part of the repository.)
   - Take the prototype's EN/AR copy from `source/pos-proto-data.js` wherever it matches the real
     behaviour.
   - Do not delete keys that tests or other code still use.
4. **Tests:** keep existing tests passing without weakening behavioural assertions.
   - Keep existing test hooks: classes such as `pos-page__future-action`, `app-button--*` and
     `app-status-chip--*`; `data-testid`s; roles; and exact texts.
   - If a test pins purely incidental markup and the design requires a change, move the assertion
     to the new markup at equal strength, and note it in §7.
5. **Accessibility:**
   - Visible labels on inputs, accessible names on icon-only buttons.
   - Dialogs through `AppDialog`, which contains focus and restores it on close.
   - `role="status"` or `role="alert"` on live outcomes, and focus-visible rings.
   - Minimum text size is 13px; controls are at least 44px tall, except 36px secondary row
     actions, as in the design.
6. **Thermal receipts:** never restyle receipt content.
   - Receipt previews are main-process PNGs, or blocks explicitly coloured `bg-paper text-paper-ink`.
   - Theme changes must not alter them.
   - Never call a print dispatch in development.
7. Do not add dependencies. Do not touch `src/main`, `src/preload` or `src/shared`, or the backend.

## 5. Page-by-page matrix

Key to the "Verified" column:

- **T** — the unit and component tests for the area pass.
- **L** — exercised live: the real Electron app, an isolated profile and a disposable Laravel backend
  (see §8).
- **S4** — screenshots in all four locale/theme combinations: EN/AR × light/dark.
- **R** — responsive captures at 1920, 1366, 1024 and 800×600.
- **Sim** — a visual check only, rendered from contract-shaped store state because the live path is
  blocked (reasons in §9).

The acceptance screenshots are in `verification/final-2026-09-28/`: 134 real captures, with a
`manifest.json`. The older files directly in `verification/` are superseded (see their README). The
matrix below was updated by the acceptance repair (§10).

| Design page / state                                        | App route / component                                                          | Data source → actions (unchanged)                                                         | Visual changes                                                                                                                                  | Verified                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Shell: top bar, nav, pills                                 | `AppLayout` → `app/shell/AppTopBar.vue`                                        | `useShellNavigation`; `useShellStatus` (connectivity and sync); `ShiftMenu` (shift store) | 60px bar, underline nav with always-visible labels (compact stacked below 1500px, D-03), network, sync and shift pills, cashier menu, skip link | T, L, S4, R; overlap measured at 900–1920 EN/AR                                                                   |
| Shell: notices                                             | `ShellNotices.vue`, `ConnectivityBanner`                                       | connectivity `retry()`; sync `isPaused`, `failedCount`                                    | Full-width dismissible strips                                                                                                                   | T, L (unreachable, paused, restored)                                                                              |
| Shell: shift menu and dialogs                              | `ShiftMenu.vue`, `ShiftDialogs.vue`, `shiftDialog.store.ts`                    | shift store `open`, `pause`, `resume`, `close`, `loadCurrent`                             | Moved from the POS toolbar into the top-bar menu                                                                                                | L (open, pause, resume, access-denied error), S4                                                                  |
| Shell: user menu, sign-out                                 | `UserMenu.vue`, `SignOutDialog.vue`                                            | auth `logout`, cart `resetDraft`, payment `resetPayment`, startup `refresh`               | Language, theme, and sign-out confirmation with the queued-sales warning                                                                        | L, S4                                                                                                             |
| Shell: compact drawer                                      | `NavDrawer.vue`                                                                | nav items and pills                                                                       | Below 900px                                                                                                                                     | L, R (EN/AR)                                                                                                      |
| Startup: activation                                        | `/activate` `ActivationPage`                                                   | device store `load`, `activate`                                                           | Startup card, steps, device summary (platform and identity only)                                                                                | L (real registration, 3 devices), S4, 800×600 ×4                                                                  |
| Startup: sign in                                           | `/login` `LoginPage`                                                           | auth `login`                                                                              | Show/hide password; "workstation activated" line                                                                                                | L (admin sign-in with real negotiated bootstrap, no proxy), S4, 800×600 ×4                                        |
| Startup: preparing data                                    | `/`, `/bootstrap` `InitializingPage`                                           | bootstrap `runBootstrap`, `load`                                                          | Progress steps from the real `stage`                                                                                                            | L (success and contract failure), EN capture                                                                      |
| Startup: blocked                                           | `/access` `AccessBlockedPage`                                                  | access `refreshWorkstation`, startup `refresh`                                            | Blocked card with reference                                                                                                                     | Sim (EN light, AR dark)                                                                                           |
| Startup: fatal / not found                                 | `/error`, `/:pathMatch`                                                        | startup error                                                                             | Card                                                                                                                                            | Fatal: Sim; not found: L, S4                                                                                      |
| POS selling (all widths)                                   | `/pos` `PosPage`                                                               | catalog (now with real paging), cart, shift, payment, sync and bootstrap stores           | Category tiles or chips, search, grid, pagination, cart column, compact bar and sheet                                                           | T, L, S4, R                                                                                                       |
| POS catalog and cart states                                | `PosPage`                                                                      | same                                                                                      | Empty, no-shift, paused, invalid cart and rebuild, stale, barcode feedback, rejected shift                                                      | T, L (no-shift, paused, catalog changed)                                                                          |
| POS dialogs: discount, customer, shortcuts, clear, rebuild | `PosPage`                                                                      | cart `setInvoiceDiscount`, `clear`, `rebuildFromCatalog`; catalog `selectCustomer`        | V3 dialogs; clear now asks for confirmation                                                                                                     | L (discount applied, clear), S4                                                                                   |
| Payment: tender and split                                  | `PaymentPanel`                                                                 | payment store (rows, draft, preview, complete)                                            | Two-column tender dialog, fill-due, 20-payment note                                                                                             | T, L (card + cash split, cash change, insufficient and non-cash-overage rejections), S4                           |
| Payment outcomes: complete, stock, blocked                 | `PaymentPanel`, `SaleRecoveryBanner`                                           | payment `complete`, `retryAttempt`, `abandonAttempt`, `acknowledgeAttempt`                | Done, failed and abandon states; "New sale" acknowledges and closes the panel                                                                   | T, L (complete online and offline in both offline modes; stock-allocation rejection; New sale → scan-ready)       |
| Sales history                                              | `/sales` `SalesHistoryPage`                                                    | sales store                                                                               | Table, legend, search                                                                                                                           | L, S4, R                                                                                                          |
| Sale detail                                                | `/sales/:localUuid` `SaleDetailPage`                                           | sales and refunds stores                                                                  | Items, totals, payments, refund history                                                                                                         | L, S4                                                                                                             |
| Refund: select, review, result, unavailable                | `RefundDialog`                                                                 | refunds store                                                                             | Stepped full-height dialog                                                                                                                      | T, L (real refund REF-…-000001), S4                                                                               |
| Receipt preview and print outcomes                         | `ReceiptPreviewDialog`                                                         | printing store `openPreview` (and `print`, never pressed)                                 | Paper plus control column; the PNG is never recoloured                                                                                          | T, L (sale and refund previews; Print never pressed)                                                              |
| Sync: queue, failures, paused, empty                       | `/sync` `SyncPage`                                                             | sync store `uploadNow`, `loadFailures`                                                    | Metrics, waiting list, needs-review with support details                                                                                        | T, L (empty, paused, offline sale → synced), S4                                                                   |
| Offline stock readiness                                    | `/offline-stock` `PreparationPage` + `OfflineSaleReadinessPanel` (now mounted) | preparation and offlineSale stores (+ local catalog name lookup)                          | Offline-selling status panel; time and stock coverage panels only in `allocation_exclusive` (D-24)                                              | T, L (physical presence online/offline; allocation: stale handshake, applied, prepared stock sold offline), S4, R |
| Settings: workstation and printer                          | `/settings` `SettingsPage`                                                     | printing store settings                                                                   | Tabs, printer radios, paper, copies, mode, auto-print                                                                                           | L, S4                                                                                                             |
| Settings: receipt profile                                  | `ReceiptProfileSection`                                                        | receiptProfile store                                                                      | Form plus white thermal preview                                                                                                                 | T, L (real publish revision 1 → 2 against Laravel), S4, R                                                         |
| Company users: list, filters, seats                        | `/company-users` `CompanyUsersPage`                                            | companyUsers store                                                                        | Table, chips, seats, confirmation                                                                                                               | L (view-only manager; admin with manage), S4                                                                      |
| Company users: add / edit                                  | `/company-users/create`, `/company-users/:uuid`                                | companyUsers store `create`, `update`                                                     | Form card in the V3 dialog language (routes kept)                                                                                               | L (user created; name and roles edited; read back from Laravel), S4                                               |

## 6. Design deviations

Each deviation has a concrete reason.

| #    | Deviation                                                                                                                                                                              | Reason                                                                                                                                                                                                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-01 | Control borders (inputs, steppers, outline buttons, radio tiles) use `control` (#8A8AA3 / #6B6E94) instead of the prototype's `line-strong` (#C9C9DA).                                 | #C9C9DA on white is 1.6:1, which fails WCAG 1.4.11. It also breaks the repo's existing rule that every control boundary is ≥ 3:1.                                                                                                                                                  |
| D-02 | Solid destructive buttons use `danger` instead of `err`.                                                                                                                               | In dark mode the prototype put white text on #F87171, which is 2.8:1.                                                                                                                                                                                                              |
| D-03 | Top-bar nav labels sit beside their icons from 1500px; below that they use a compact stacked treatment (icon over a 13px label that may wrap at a word boundary, max two lines).       | At 1366px the prototype's inline labels overlap the status pills (visible in `reference/pos_en_light.png`). Icon-only navigation was rejected in acceptance: labels must stay readable at 1366 and 1024. Measured with no overlap and no clipping from 900 to 1920px in EN and AR. |
| D-04 | The user menu shows the signed-in email instead of the role "Cashier".                                                                                                                 | `SessionSummary` has no role.                                                                                                                                                                                                                                                      |
| D-05 | **Revised (owner UX plan P8).** Product cards show the product image when the server delivered one and its bytes were verified locally; otherwise the pastel monogram band. | Images arrive through the negotiated `product_images` bootstrap block and a background worker (`ProductImageSyncService`) that verifies each asset's hash, length, WebP signature and bitstream size before storing it. The renderer never calls the backend: the main process returns verified thumbnails as `data:` URLs (CSP `img-src 'self' data:`). Checkout and catalog install never wait for images; a missing, pending, failed or undrawable image shows the monogram in the same box. Originally: "never a photo", because no image contract existed. |
| D-06 | Startup screens keep a compact theme control beside the language toggle.                                                                                                               | It is an existing feature the prototype omits there.                                                                                                                                                                                                                               |
| D-07 | The refund flow is a large stepped modal, not a full page.                                                                                                                             | `RefundDialog`'s contract and tests require `[role="dialog"][aria-modal="true"]`, and the flow opens from Sale detail.                                                                                                                                                             |
| D-08 | Every real category uses the generic `category` glyph; pastels cycle by position.                                                                                                      | The catalog contract carries no category icon.                                                                                                                                                                                                                                     |
| D-09 | The read-only "payment methods" sheet and the "Customers" toolbar button are removed.                                                                                                  | The audit marks that sheet superseded: the payment dialog shows method availability, and the customer is chosen from the cart row.                                                                                                                                                 |
| D-10 | There is no barcode multi-match chooser. The ambiguous-scan notice is shown instead.                                                                                                   | The `ambiguous` lookup outcome carries no candidates.                                                                                                                                                                                                                              |
| D-11 | The shortcut sheet lists F1, F2 and Esc only.                                                                                                                                          | Enter does not add a typed barcode in the app (the scanner listener handles scans), so the prototype's Enter row would be untrue.                                                                                                                                                  |
| D-12 | The discount dialog has no before/after preview box.                                                                                                                                   | Computing a preview would need pricing arithmetic in the page. The cart store is the only calculator, and the real totals update on Apply.                                                                                                                                         |
| D-13 | "Use amount due" is offered only when the amount is already known: before the first tender (the grand total), or from a valid preview.                                                 | The insufficient-tender preview carries no due amount, and the page must not do money arithmetic.                                                                                                                                                                                  |
| D-14 | Cart lines have no "Only N available" note, and increments are not blocked at the stock limit.                                                                                         | The cart does not enforce stock; checkout does, through the stock-allocation rejection, which is shown. A snapshot count could be stale.                                                                                                                                           |
| D-15 | No hostname, OS version or app version appears anywhere. The login shows "This workstation is activated."                                                                              | This is the design's content rule. `deviceName` defaults to the OS hostname.                                                                                                                                                                                                       |
| D-16 | Clearing the cart now asks for confirmation (the design's `cc_*` dialog).                                                                                                              | It is a UX guard only; `cart.clear()` is unchanged.                                                                                                                                                                                                                                |
| D-17 | The pay button reads "Pay {amount}" when ready. The blocked labels keep the existing, more precise copy ("Open an active shift to continue", …).                                       | The ready label follows the design; the blocked labels are what the tests assert.                                                                                                                                                                                                  |
| D-18 | The sale-detail totals panel shows only the grand total. There is no cashier, customer or change due in the detail.                                                                    | `SaleDetail` does not carry them.                                                                                                                                                                                                                                                  |
| D-19 | The offline-stock page resolves product names from the local catalog, falling back to the uuid.                                                                                        | The readiness contract only has `productUuid`.                                                                                                                                                                                                                                     |
| D-20 | The company-user add and edit screens stay routed pages, styled as the design's user dialog.                                                                                           | These are existing routes and flows.                                                                                                                                                                                                                                               |
| D-22 | From 900 to 1199px the brand wordmark is screen-reader-only; the logo mark stays visible.                                                                                              | That band is where the pills gain their text labels. Freeing the wordmark's width keeps every nav label at two lines or fewer (Arabic "المخزون دون اتصال" would otherwise need three).                                                                                             |
| D-23 | The shell has a "Skip to main content" control, visible only on keyboard focus.                                                                                                        | A11y review (ui-ux-pro-max `skip-links`). It is a focus button rather than a `#main` link, because the router uses hash history.                                                                                                                                                   |
| D-24 | In `physical_presence` the offline-stock page shows only the offline-selling status. There is no "Prepare" action and no preparation panels; unresolved operations are still reported. | PS6 §14.3: a server-issued authority, not preparation, permits offline selling in that mode. The panel says so, and a page that also asked for preparation contradicted it.                                                                                                        |
| D-21 | USD amounts in Arabic render as "$US 5.00".                                                                                                                                            | This is bidi resolution of Intl's "‏5.00 US$" and applies only to `$`-symbol currencies. The existing formatter is kept unchanged; EGP renders as designed ("1,250.50 ج.م.").                                                                                                      |
| D-25 | **Owner UX plan P9.** The top bar shows the company logo and name when the server delivered them (verified logo bytes only); otherwise the product mark and "Thinis POS". The primary tokens (`pri`, hover, pressed, soft, text, on-primary, focus) are derived from the company colour. | Same algorithm and shared vectors as the owner portal: on-primary black or white (≥ 4.5:1), hover/pressed keep it, text tokens ≥ 4.5:1 on the surface, page and soft fill, focus ≥ 3:1; only OKLCH lightness moves, otherwise the palette default per theme. Danger, warning and success are never derived. Applied as `light-dark()` pairs on the root element; removed on sign-out or another company. Receipts keep their frozen receipt profiles. |

## 7. Test adaptations

Each test was re-pointed with equal or greater strength; none was weakened. New tests are listed
last.

| Test                                                                             | Change                                                                                                                                                                                                                             | Why                                                                                                             |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `AppConfirmDialog.test.ts`                                                       | Queries `[role="alertdialog"]`.                                                                                                                                                                                                    | V3 confirmations are alert dialogs. The same buttons and emits are asserted.                                    |
| `PosPage.scope.test.ts`, logical layout                                          | Checks Tailwind logical utilities are present and that no physical CSS or physical utilities (`ml`/`mr`/`pl`/`pr`/`left`/`right`/`text-left`/`border-l`, …) appear.                                                                | The page no longer has a scoped stylesheet. The new check is stricter, because it also bans physical utilities. |
| `PosPage.scope.test.ts`, live sync indicator                                     | The same fields (`sync.queuedCount`, `failedCount`, `isPaused`) are asserted in `app/shell/useShellStatus.ts` and `AppTopBar.vue`.                                                                                                 | The indicator moved to the shell's sync pill, which is visible on every page.                                   |
| `PosPage.offlineShiftAuthority.test.ts`                                          | The ready checkout label is `'Pay EGP 100.00'` (exact, NBSP included) instead of `'Proceed to payment'`.                                                                                                                           | This is the design's ready label (D-17).                                                                        |
| New: `sync/store.test.ts`                                                        | Reference counting of `initialize()`/`dispose()`.                                                                                                                                                                                  |                                                                                                                 |
| New: `catalog.store.test.ts`                                                     | Pagination over the existing limit/offset contract.                                                                                                                                                                                |                                                                                                                 |
| New: `printing/service.test.ts`                                                  | Reactive payloads reach the bridge as plain data.                                                                                                                                                                                  |                                                                                                                 |
| New: `shared/utils/ipcPayload.test.ts`                                           | Covers `toIpcPayload`: exact preservation (null, undefined, large integers, Arabic text), and refusal of NaN/Infinity, Date, Map, class instances, functions, bigint, symbols and cycles.                                          |                                                                                                                 |
| New (acceptance): `PosPage.v3Behaviour.test.ts`                                  | Clear-cart cancel keeps every line and confirm clears; "New sale" acknowledges without abandoning and closes the panel; an unrelated recovery acknowledgement leaves the panel open; the confirmation copy never doubles the noun. |                                                                                                                 |
| New (acceptance): `catalog.store.test.ts`                                        | Category change restarts paging; out-of-order page responses never show an obsolete page; an overtaken page request is discarded; a result set that shrank falls back to its last real page (at most one re-request).              |                                                                                                                 |
| New (acceptance): `sync/store.test.ts`                                           | Navigation → logout → new login neither leaks nor drops the push subscription.                                                                                                                                                     |                                                                                                                 |
| New (acceptance): `AppTopBar.test.ts`                                            | Nav labels are visible text (never `hidden`/`aria-hidden`) and are the accessible names.                                                                                                                                           |                                                                                                                 |
| New (acceptance): `OfflineSaleReadinessPanel.test.ts`, `PreparationPage.test.ts` | Panel states and tones; localized categorical blocks; first-load failure with retry; the page mounts the panel; physical-presence mode drops the preparation requirement but keeps unresolved operations.                          | Restores and adapts the regression tests lost with the uncommitted 2026-09-26 work (§10).                       |
| Restored: `ReceiptProfileSection.test.ts`, `AppInput.test.ts` (3 cases)          | Verbatim from the 2026-09-26 session transcript; they pass against V3 unchanged.                                                                                                                                                   | §10.                                                                                                            |
| Corrected: `tests/electron/suites/preparationLifecycle.suite.ts`                 | Failures are built by the real `normalizeHttpError`, not hand-made `{ code, status }` objects; plus five CP4 regressions.                                                                                                          | The hand-made shape hid the classifier defect (§9). The mutation check fails 6 of 12 on the old classifier.     |
| New: `tests/sandboxGuard.test.mjs`                                               | 18 refusal cases for the disposable-backend guard, run against a fake backend so nothing reaches Laravel or any database.                                                                                                          | §8.                                                                                                             |

## 8. Verification log

This log was rewritten by the acceptance repair on 2026-09-28 (§10). The first-pass numbers it
replaces are recorded in §10.

The authoritative record of **what** was verified — the desktop content digest, the backend HEAD and its
dirty set, the fixtures and the final gate run — is [ACCEPTANCE.md](ACCEPTANCE.md). The final gate run
there supersedes the numbers below wherever they differ.

### Automated checks (final)

| Check                                             | Result                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck:node`                          | 0 errors (was 35).                                                                                                                                                                                                                                                                                                                                       |
| `npm run typecheck:web`                           | 0 errors (was 2).                                                                                                                                                                                                                                                                                                                                        |
| `npx vitest run`                                  | 136 files, 1248 tests, all passed (was 1190 passed, 15 failed).                                                                                                                                                                                                                                                                                          |
| `npm run test:sqlite:electron`                    | 421 tests: 364 passed, 0 failed, 57 skipped (the live suites skip without a live fixture).                                                                                                                                                                                                                                                               |
| `npm run test:cp3g5-harness`                      | 56 passed, 0 failed (includes the 18 new sandbox-guard refusals).                                                                                                                                                                                                                                                                                        |
| `npm run build` (includes typecheck)              | Succeeds.                                                                                                                                                                                                                                                                                                                                                |
| Receipt-profile live gate (real Electron↔Laravel) | Passed, with no proxy. Run-specific evidence is in `docs/audits/artifacts/receipt-profile/runs/v3-acceptance-2026-09-28-final/`: 4 × HTML/JSON/PNG/PDF from one run, PDF page counts match their plans. The committed set was byte-identical afterwards. An earlier run from just after the integration repair is in `…/runs/v3-acceptance-2026-09-28/`. |
| PS7 physical-presence live gate                   | Passed: 371 passed, 0 failed, 50 skipped, through the guarded migrate and seed.                                                                                                                                                                                                                                                                          |
| `npm run lint`                                    | 2 errors and 6 warnings, all pre-existing debt in `tests/electron/support/cp3g5/seedReliability.mjs` and `tests/cp3g5HarnessLifecycle.test.mjs`. 0 problems in files changed by the redesign or this repair.                                                                                                                                             |

### Live integration (GUI), no proxy

**Isolation, hardened**

- Every disposable-backend write goes through `tests/electron/support/sandbox/guardedArtisan.php` or
  `guiFixture.php`. The guard runs in the same PHP process as the write:
  - Before Laravel loads, the explicit environment must name exactly the approved SQLite file under
    the system temporary directory, with `APP_ENV=testing` and no `DB_URL`.
  - `APP_CONFIG_CACHE` must point at a not-yet-existing file inside the sandbox.
  - `thinis_pos`, `thinis_pos_testing`, repository databases (for example the backend's
    `database/database.sqlite`) and `~/.config/pos-desktop` are refused.
  - After boot, the resolved connection must be that same file.
  - `tests/sandboxGuard.test.mjs` proves every refusal against a fake backend whose autoloader would
    leave a canary file. No refusal reached Laravel or any database.
- `scripts/cp3g5LiveUpload.mjs` and `scripts/ps7LivePhysicalPresence.mjs` now migrate (and PS7 also
  seeds) through the same runner, with an isolated config cache. PS7 no longer inherits `DB_URL` or
  `APP_CONFIG_CACHE` from the caller.
- The app ran from `out/gui-test`, with an isolated profile (`XDG_CONFIG_HOME` → userData under the
  run directory), an isolated keyring (a private D-Bus session) and CDP. The real
  `~/.config/pos-desktop` was never opened. It changed during the session only because the user's
  own `electron-vite dev` process was running against it.

**Fixtures, through supported backend mechanisms only** (no tinker, no raw SQL)

- Seed: `DesktopMvpSmokeSeeder` via `guardedArtisan.php db:seed`. The backend working tree carried
  someone else's uncommitted change to that seeder (a purge that is a no-op on a fresh database).
- Device placement: `DeviceAssignmentFenceService::applyAssignment`.
- Offline mode: `UpsertPosOfflineSalePolicyAction`, plus per-product exposure through
  `UpsertStockAllocationExposurePolicyAction` in the allocation fixture.
- Company-admin permissions come from `RolesAndPermissionsSeeder`. The earlier manual `users.manage`
  grant is not needed.
- **Run B (physical presence):** server with `POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED=true`;
  `guiFixture mode-physical-presence`.
- **Run A (legacy allocation):** server with `STOCK_ALLOCATION_PREPARATION_ENABLED=true`;
  `guiFixture mode-allocation COLA-CAN,WATER-500,CHIPS-S`.

**Journeys exercised live**

- **Activation and sign-in.** Activation, then sign-in with the real negotiated bootstrap
  (`receipt_profile_version=1`, **no proxy**). Receipt-profile capability is `supported` and
  `canManage` true for the admin.
- **Receipt-profile administration.** Two lines of address (EN + AR), phone, tax label and value, and
  a mixed EN/AR footer. Save published revision 1; an edit published revision 2. The paper preview
  stays white in dark mode.
- **Company users.** A user was created through the form, then renamed and given an extra role, and
  read back from Laravel.
- **Offline selling, physical presence (run B).**
  - Readiness panel: physical presence, `canSellWithoutQuota`, a 72h window limited by the authority
    ceiling.
  - Backend stopped: a **tracked** product (Cola Can ×2) was sold with no per-device quota.
  - "New sale" closed the panel; the invoice was kept and queued; a simulated barcode scan
    immediately added the next item.
  - Clear cart: cancel kept the cart and confirm cleared it.
  - The app was killed and relaunched while offline: the session and the queued sale survived, and
    the countdown did not reset.
  - The backend returned on the same origin: automatic upload, server number assigned.
  - Exactly-once (guiFixture `report`): 1 sync record, 1 server invoice, 1 stock movement,
    `sold_while_offline=true`. This was unchanged after two forced `uploadNow` calls and another
    restart.
- **Offline selling, legacy allocation (run A).**
  - An online tracked sale acquired an allocation.
  - Preparation (cycle outcomes below) led to an offline sale of prepared stock, then reconnect.
  - Exactly-once for both invoices: 1 sync record, 1 invoice and 1 stock movement each.
- **POLICY_REVISION_STALE (§9).** Observed with `POS_API_TRACE=1`: 409 with
  `current_policy_revision`, misclassified as ambiguous forever. After the fix, the same stuck
  operation (`5fa4df03`, frozen hash `c8a6543c…`, 334 bytes) replayed its identical bytes, became
  `superseded_uncommitted` and learned revision 1. The next cycle created a new operation that was
  applied with one grant. The frozen bytes and hash were unchanged.

**Screenshots:** `verification/final-2026-09-28/`, 134 real captures across 24 states. EN/AR ×
light/dark at 1366×768; 1920, 1024 and 800×600 for EN light and AR dark; startup screens at 800×600
in all four combinations. See its README and `manifest.json`. Access-blocked and fatal-error screens
were not reached live; only the earlier simulated renders exist.

## 9. Issues found (not caused by this redesign)

### Fixed

- **Receipt-profile integration missing from HEAD (main / preload / shared).** Commit 2997048 shipped
  the services and tests without their wiring (§10):
  - the bootstrap `receipt_profile` schema and the resource/asset/upload schemas;
  - the IPC channels and validators;
  - service construction and registration;
  - `window.posApi.receiptProfile` and its surface test;
  - the live-suite import.

  Restored verbatim from the verified 2026-09-26 repair. Every bootstrap failed without it
  (`unknown_keys=receipt_profile`).

- **Offline preparation livelock (product defect, desktop main).** `PreparationService` read `code` and
  `status` from a failure, but the API client throws `PublicAppError` (`backendCode`, `httpStatus`).
  `POLICY_REVISION_STALE` and `DESKTOP_PREPARATION_UNAVAILABLE` were also missing from
  `API_ERROR_CODES`, so they were stripped. The result:
  - Every definitive answer (409 stale, 409 idempotency conflict, 404 capability-off or
    route-not-found) was classified ambiguous.
  - The workstation replayed its frozen revision-0 request forever and could never prepare.

  The fix:
  - The classifier reads the real error, and the two codes are now known.
  - A capability-off `ROUTE_NOT_FOUND` counts as unavailable.
  - `markSupersededUncommitted` also accepts `ambiguous`. This is safe because the backend replays a
    known operation uuid under lock _before_ evaluating policy, and revisions only increase.
  - Frozen bytes stay protected by `trg_prepare_operations_frozen_bytes`.
  - Five regressions were added to `preparationLifecycle.suite.ts`; the mutation check fails 6 of 12
    with the old classifier.

- **`OfflineSaleReadinessPanel` was never mounted.** It was added in fe5af2d (PS6) with no consumer in
  any commit, so the redesign did not remove it. It is now mounted on `/offline-stock`, with a
  first-load failure state, a retry, and localized categorical blocks (D-24).
- **IPC payload conversion changed values silently.** The JSON round-trip turned `NaN` into `null`,
  a `Date` into a string and a `Map` into `{}`, and dropped functions and symbol keys. It now refuses
  them with a typed, path-named error and preserves every supported value, including `undefined`
  optionals.
- **Catalog paging could land on an empty page past the end** after a racing search or a catalog
  refresh. It now falls back to the last real page, re-requesting at most once.
- **Clear-cart copy doubled the noun** ("All 1 item items"). The EN copy now uses the count label once.
- Earlier in the redesign: the reactive-Proxy clone failures, the raw receipt-profile i18n keys, and
  the missing `errors.RECEIPT_PROFILE_*` translations.

### Not fixed (reported)

- **Prepared stock is not spendable until the next bootstrap refresh.** The prepare response has no
  verifiable accepted-coverage boundary, and the documented reconnect order
  (docs/architecture/cp4-readiness-and-reconnect.md §3) refreshes _before_ preparing, never after.
  So right after "Prepare workstation" the readiness page honestly shows quantity 0, and an
  immediate offline sale is refused (`stock-allocation-unavailable`) until "Refresh workstation data"
  runs.

  Recommended: a post-apply read-only refresh, or a verifiable boundary in the prepare response.
  That is a protocol change, outside this bounded repair.

- **Rejected checkout attempts keep their tender rows** until they are removed (existing payment-store
  behaviour).
- **Secondary controls below 44px.** Pagination (40px), 36px secondary buttons and the 26px
  "Add discount" link follow the prototype's sizing. Primary targets (product cards, Pay) are large.
  Recorded from the ui-ux-pro-max review; not restyled.

## 10. Acceptance repair and baseline reconciliation (2026-09-28)

**Baseline captured before any change**

- Branch `feat/claude-design-v3-redesign` at HEAD 2997048, with no commits of its own (reflog: checked
  out from `main` at 2997048).
- 122 dirty entries; content hashes recorded before editing. Every baseline-dirty file was preserved:
  only the intended files changed.
- No other worktree, and no stash. The one dangling commit is an unrelated 2026-09-20 stash.

**What history proves**

- The session that authored the receipt-profile work was splitting it into commits and had
  reverted the branding hunks from the working tree when it stopped at a session limit
  (2026-09-26 14:57–15:02Z).
- Commit 2997048 (17:09Z) then captured that state: services and tests present, wiring absent.
- Session 682fb0b9 re-created the wiring that evening and verified it: typecheck clean, 1221
  Vitest, Electron/SQLite, build, and the live gate. It left the result **uncommitted**, together
  with 15 renderer regression tests.

**What remains unknown**

- How that uncommitted work disappeared between 2026-09-27 09:05Z and this branch's creation. There is
  no reflog, stash or VS Code local-history record of it.

**How it was reused**

- The 682fb0b9 edits were extracted from its transcript and re-applied **verbatim** as explicit edits,
  after checking every schema bound against the current backend resources.
- Its lost tests were restored where they still apply (`ReceiptProfileSection.test.ts`, three
  `AppInput` cases) and adapted to V3 otherwise.

**Skills applied in review**

- ui-ux-pro-max (quick reference §1–§9, the `ux` and `vue` searches), frontend-design (restraint:
  no new aesthetic), and pos-ui-ux, pos-electron-security, pos-api-integration, pos-offline-sync,
  pos-local-database.
- Outcomes:
  - nav labels visible (`nav-label-icon`);
  - skip link added (`skip-links`);
  - offline state always visible and non-blocking;
  - barcode-first after "New sale";
  - no new IPC surface beyond the restored `receiptProfile` methods;
  - touch-target findings recorded in §9.

**First-pass numbers these replace:** typecheck 35 node + 2 web errors; Vitest 1190 passed, 15
failed; Electron/SQLite 359 passed; `npm run build` failed at typecheck; bootstrap only through a
stripping proxy.
