# V3 acceptance screenshots — 2026-09-28

Captured from the **real Electron app** over CDP, after the acceptance repair. Every file here is
`source: real`: no store patching and no proxy. Each file has an entry in `manifest.json` with its
route, locale, theme, viewport, backend state, build identity and capture time.

- Files: **134**, from 24 states.
- Isolation: disposable Laravel on SQLite behind the guarded runner (`tests/electron/support/sandbox/`); isolated profile and keyring; the real `~/.config/pos-desktop` was never used.
- Receipts: previews only. **Print was never pressed.**

## Build identities

- `HEAD 2997048 + uncommitted working tree; renderer index-BQ5nr0-5.css+index-Cy3hniw7.js`

Every capture used the same renderer bundle. Each run's backend origin (`MAIN_VITE_POS_API_ORIGIN`) is
baked into the main-process bundle only, so rebuilding per run left the renderer bundle unchanged.

## Backends

- disposable Laravel (SQLite) run A — allocation_exclusive fixture; company admin; shift open
- disposable Laravel (SQLite) run B — physical_presence fixture; backend STOPPED (real offline); company admin; shift open
- disposable Laravel (SQLite) run B — signed out, workstation activated; backend STOPPED (offline notice shown)
- fresh empty sandbox profile (run C), never activated; no backend reachable

## Coverage

| State                       | Route              | EN light | EN dark | AR light | AR dark | Viewports                              |
| --------------------------- | ------------------ | -------- | ------- | -------- | ------- | -------------------------------------- |
| `dlg_clearcart`             | `#/pos`            | ✓        | ✓       | ✓        | ✓       | 1366x768                               |
| `dlg_customer`              | `#/pos`            | ✓        | ✓       | ✓        | ✓       | 1366x768                               |
| `dlg_discount`              | `#/pos`            | ✓        | ✓       | ✓        | ✓       | 1366x768                               |
| `dlg_payment`               | `#/pos`            | ✓        | ✓       | ✓        | ✓       | 1920x1080, 1366x768, 1024x768, 800x600 |
| `dlg_receipt`               | `#/sales`          | ✓        | ✓       | ✓        | ✓       | 1366x768                               |
| `dlg_refund`                | `#/sales`          | ✓        | ✓       | ✓        | ✓       | 1366x768                               |
| `dlg_shortcuts`             | `#/pos`            | ✓        | ✓       | ✓        | ✓       | 1366x768                               |
| `menu_shift`                | `#/pos`            | ✓        | ✓       | ✓        | ✓       | 1366x768                               |
| `menu_user`                 | `#/pos`            | ✓        | ✓       | ✓        | ✓       | 1366x768                               |
| `notfound`                  | `#/does-not-exist` | ✓        | ✓       | ✓        | ✓       | 1366x768                               |
| `offline`                   | `#/offline-stock`  | ✓        | ✓       | ✓        | ✓       | 1920x1080, 1366x768, 1024x768, 800x600 |
| `offline_physical_presence` | `#/offline-stock`  | ✓        | ✓       | ✓        | ✓       | 1366x768                               |
| `pos_cart`                  | `#/pos`            | ✓        | ✓       | ✓        | ✓       | 1920x1080, 1366x768, 1024x768, 800x600 |
| `pos_offline`               | `#/pos`            | ✓        | ✓       | ✓        | ✓       | 1366x768                               |
| `sale`                      | `#/sales`          | ✓        | ✓       | ✓        | ✓       | 1366x768                               |
| `sales`                     | `#/sales`          | ✓        | ✓       | ✓        | ✓       | 1366x768                               |
| `settings_receiptprofile`   | `#/settings`       | ✓        | ✓       | ✓        | ✓       | 1920x1080, 1366x768, 1024x768, 800x600 |
| `settings_workstation`      | `#/settings`       | ✓        | ✓       | ✓        | ✓       | 1366x768                               |
| `startup_activate`          | `#/activate`       | ✓        | ✓       | ✓        | ✓       | 1366x768, 800x600                      |
| `startup_signin`            | `#/login`          | ✓        | ✓       | ✓        | ✓       | 1366x768, 800x600                      |
| `sync`                      | `#/sync`           | ✓        | ✓       | ✓        | ✓       | 1366x768                               |
| `user_create`               | `#/company-users`  | ✓        | ✓       | ✓        | ✓       | 1366x768                               |
| `user_edit`                 | `#/company-users`  | ✓        | ✓       | ✓        | ✓       | 1366x768                               |
| `users`                     | `#/company-users`  | ✓        | ✓       | ✓        | ✓       | 1920x1080, 1366x768, 1024x768, 800x600 |

The four locale/theme columns refer to 1366×768 (the sign-in and activation screens also have all four at
800×600). The other viewports — 1920×1080, 1024×768 and 800×600 — were captured in **EN light and AR
dark only**. `manifest.json` is the exact list.

## Not captured live

- **Access blocked** (`/access`) and **fatal error** (`/error`): no live path was exercised in this run.
  The only renders are the earlier `../sim_startup_*` files, which are simulated.
- **Initializing / preparing data** (`/bootstrap`) is transient. It was observed live on every sign-in; the only capture is the earlier `../startup_prepare_en_light.png`.
