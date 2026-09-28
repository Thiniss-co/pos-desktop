# V3 verification screenshots

> **Superseded as acceptance evidence.** The current set is
> [`final-2026-09-28/`](final-2026-09-28/README.md). It has 134 real captures and a machine-written
> `manifest.json`, and was taken after the acceptance repair.
>
> The files in this folder predate that repair:
>
> - They were captured through a proxy that stripped `receipt_profile_version` from bootstrap
>   requests.
> - Their shell has the old icon-only navigation below 1500px.
> - Several states were simulated (`sim_*`), and `offline_*` shows a simulated prepared state.
> - The earlier claim of "60 screens in all four combinations" counted these files. They do not
>   support it as final evidence.
>
> They are kept only as history.

These screenshots come from the **real Electron app**, captured over CDP. The run used an isolated
profile, an isolated keyring, and a disposable Laravel backend on SQLite. The method and its caveats
are in [../IMPLEMENTATION.md](../IMPLEMENTATION.md) §8.

## Naming

- `<screen>_<lang>_<theme>.png` — captured at 1366×768.
  - The screens are `pos`, `sales`, `sale`, `sync`, `offline`, `settings`, `users`, `dlg_*` (dialogs),
    `menu_*` (top-bar menus) and `startup_*`.
- `<screen>_<lang>_<theme>_<W>x<H>.png` — responsive captures.
  - `pos_sheet_*` is the compact cart sheet; `pos_drawer_*` is the compact navigation drawer.
- `sim_*.png` — **simulated** renders: a contract-shaped state patched into the renderer store,
  because the live path is blocked by a pre-existing gap (IMPLEMENTATION.md §9). They are a visual
  check only, not integration evidence.
- `journeys/` — frames from the live end-to-end run:
  - open shift, cart, discount, split tender, sale complete;
  - sale detail, refund select, review and result, receipt preview (Print never pressed);
  - service unreachable, stock-allocation rejection, offline sale, synced after reconnect;
  - pause shift, sign-out, company-user administration.

  They were taken **before** the root font-size fix. Their UI scale is about 94% of the final build,
  so use the top-level files for visual fidelity.

## Comparing with the design

Compare each file with the renders of the same screen in `../reference/`. Deliberate differences
are listed in IMPLEMENTATION.md §6.
