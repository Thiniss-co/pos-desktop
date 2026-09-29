# POS reliability and cashier workflow — acceptance record (2026-09-29)

This record covers the approved POS reliability task (plan revision 3). The six areas are:

1. Stock facts after a sale.
2. The payment modal and the resizable cart.
3. Fast scan → pay → next sale.
4. A catalog refresh blocking a sale, and allocation dispatch recovery.
5. Payment state separated between carts.
6. The device heartbeat and owner-dashboard presence.

It also records the acceptance follow-up:

- the Sync "Needs attention" view;
- the Electron ↔ Laravel owner-product live gate;
- the implementation conditions;
- durable evidence.

Nothing here was staged, committed, pushed or deployed. No physical print job was sent. Every
database and workstation profile was disposable; `thinis_pos`, `thinis_pos_testing` and
`~/.config/pos-desktop` were not used.

## Evidence labels

| Label                     | Meaning                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **automated integration** | Real Electron main-process services and real SQLite, talking to a real Laravel server on a disposable SQLite database started by `scripts/cp3g5LiveUpload.mjs`. Effects are asserted in both databases. |
| **automated**             | vitest, or the Electron SQLite suites (`npm run test:sqlite:electron`), with no server.                                                                                                                 |
| **live walkthrough**      | The real Electron app driven over CDP, or the owner SPA in isolated headless Chrome, against a guarded disposable backend (`tests/electron/support/sandbox`).                                           |
| **simulation**            | A precondition was produced by writing state directly, or a condition was injected. Each use is named where it occurs.                                                                                  |
| **not run**               | Not executed; listed under limitations.                                                                                                                                                                 |

## Scope status

| Item                          | Status                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Areas 1–6 (implementation)    | Implemented; see the per-scenario evidence below.                                                                  |
| Sync "Needs attention" view   | Implemented and verified: automated, and a live walkthrough with one simulated precondition.                       |
| Owner-product live gate (A–E) | Implemented and **passing** in the official harness run recorded in `live-suite/`.                                 |
| Implementation conditions 1–3 | Existing regression tests, cited below. They passed in the final harness run, which executes every Electron suite. |
| Durable evidence              | This directory.                                                                                                    |

## Owner-product live gate — `tests/electron/suites/ownerProductCheckoutLive.suite.ts` (automated integration)

**Run command** (from the desktop root):

```
env -u ELECTRON_RUN_AS_NODE CP3G5_MINT_OWNER_PRODUCT_CONTEXT=1 POS_OFFLINE_PHYSICAL_PRESENCE_ENABLED=true \
  STOCK_ALLOCATION_PREPARATION_ENABLED=true OWNER_PRODUCT_LIVE_EVIDENCE_DIR=<new dir> \
  node scripts/cp3g5LiveUpload.mjs
```

**How it is wired:**

- **Server context.** The seeder (`seedLiveBackend.php`, opt-in block) runs `DesktopMvpSmokeSeeder`, then mints one register, a token and an open shift.
- **Server changes during the run.** The owner's product creation, stock receiving and offline-sale policy changes go through the guarded `guiFixture.php`: the owner FormRequest with `CreateProductAction`, `CreateStockReceivingAction`, and the policy actions.
- **Desktop composition.** `tests/electron/support/ownerProductLive.ts` mirrors the production wiring (license validation, bootstrap install, local sale, allocation acquisition with durable dispatch evidence, the reconciler, the upload worker) using the real `DesktopApiClient`.
- **What is substituted:**
  - the transport `fetch` is wrapped by `UploadTransportSpy`;
  - connectivity is a switch the scenario controls.

**Guarantees, stated precisely.** A reservation request may be **sent more than once**: a lost
answer is re-sent with the identical key and body. Server idempotency and exactly-once ingest on the
desktop are what prevent a duplicate **business effect**. The assertions count business effects,
such as server request rows, grants, invoices and stock movements. They never assume a single
network send.

| Scenario                                                           | What is proven (asserted in both databases)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Evidence              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| **A** Owner-created tracked product, no StockItem, allocation mode | A zero grant leads to a terminal `rejected` / `stock-allocation-unavailable`, and the attempt key is released. The server has 1 request, 0 grants and no StockItem created, and there is no local invoice. After receiving 5 and refreshing, the next sale commits and uploads: 1 server invoice, 1 movement of 1, stock 5 → 4.                                                                                                                                                                                                                                                                                                                  | `live-suite/A-*.json` |
| **B** Physical-presence mode, no StockItem                         | Without an authority, the offline sale is refused (`stock-allocation-unavailable`). After a **real** license validation minted the authority and a **real** bootstrap installed it, the offline sale commits under `physical_presence` (the invoice carries the authority uuid) and uploads: 1 server invoice, 1 movement. The server recorded the product's StockItem at −1 (an oversell record under PP authority).                                                                                                                                                                                                                            | `live-suite/B-*.json` |
| **C** Existing cart plus catalog change                            | An intent frozen under revision R1 is refused by main as `catalog-superseded` after the owner's change and a refresh (R2 ≠ R1): terminal, no invoice, never repriced. A rebuilt intent under R2 commits and uploads once. The renderer's review/rebuild UI is covered by automated tests; this scenario proves main's authority.                                                                                                                                                                                                                                                                                                                 | `live-suite/C-*.json` |
| **D** Allocation answer lost after the server committed            | Fault injection (`lose-acknowledgment`): the request reached the real server, the server committed 1 request and 1 grant, and the answer was dropped. The attempt stays `claimed` and the dispatch row stays `dispatched`, with no grant ingested. Then a **restart** (database closed and reopened, services rebuilt cold). The reconciler re-sent the identical key and body once. The server still has 1 request and the same 1 grant; the grant was ingested locally exactly once. A second reconciler pass sent nothing. Retry commits with no further request, and the sale consumed that grant once on the server.                        | `live-suite/D-*.json` |
| **E** Offline completion before reconciliation, both orders        | The PP authority is held. The answer is lost after the server committed. Connectivity then drops (connectivity switch: simulation of the monitor's state), and the retry commits offline under `physical_presence` with the dispatch still outstanding. The frozen payload fingerprint is taken, then (i) upload → reconcile or (ii) reconcile → upload. Both orders show: 1 server invoice, 1 movement of 1, stock −1, 1 server request, the same 1 grant (no duplicate), 1 local grant, an unchanged frozen payload, and 2 sends (original + one identical replay). The late grant remains an unconsumed reservation on the till, as designed. | `live-suite/E-*.json` |

`live-suite/repository-identities.json` records the exact trees this run used (see below).

## Sync "Needs attention" view

The view reads main's own records through one owner-scoped, validated IPC call
(`sync:support-issues`). There is no new table, and the view has no mutating action: only
_Copy reference_ and _Open POS screen_.

| Check                                                                                                                                                                                    | Label                                                                                                                                                                                 | Evidence                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A legacy attempt cancelled with acknowledgement is listed under _Needs support_ after the dialog closes and after a restart; its uncertainty stays `open`                                | automated                                                                                                                                                                             | `tests/electron/suites/supportIssues.suite.ts:90`                                                             |
| An identity conflict needs support, shows its trace id, is never retryable, and is listed apart from pending requests                                                                    | automated                                                                                                                                                                             | `supportIssues.suite.ts:160`                                                                                  |
| Another cashier's record on the same device is redacted; another device's or company's is excluded                                                                                       | automated                                                                                                                                                                             | `supportIssues.suite.ts:232`; `src/main/services/supportIssues.service.test.ts`                               |
| No Retry / acknowledge / delete control; separate groups; EN/AR copy                                                                                                                     | automated                                                                                                                                                                             | `src/renderer/src/modules/sync/pages/SyncPage.test.ts`                                                        |
| Real unanswered reservation → listed as _Being confirmed automatically_, and the payment as _Payment waiting on the POS screen_                                                          | live walkthrough                                                                                                                                                                      | `screenshots/sync-needs-attention/live-pending-*`                                                             |
| Legacy cancel through the real UI acknowledgement; listed under _Needs support_; still listed after an app restart; stays `open` after the pending request was confirmed on reconnection | live walkthrough, **one simulated precondition** (the attempt was marked `dispatch_evidence='unknown'`, which is what migration 0016 writes for an attempt claimed by an older build) | `screenshots/sync-needs-attention/legacy-cancel-acknowledgement-*`, `final-*`                                 |
| The open page updated itself when the reconciler resolved a request (no navigation, same document, under 10 s after the server returned)                                                 | live walkthrough                                                                                                                                                                      | observed during the run; the defect behind it (no refresh) was found live and fixed with `onRequestsResolved` |

## Implementation conditions (existing tests; they passed in the final harness run, which executes every Electron suite)

1. **A delayed pre-upgrade request is not assumed completed because a bootstrap succeeded.**
   `tests/electron/suites/attemptDispatch.suite.ts:301`, _"a legacy attempt needs an explicit
   acknowledgement to cancel; the uncertainty stays open, append-only, and a delayed old grant is
   ingested once"_:
   - Cancel is refused without the acknowledgement.
   - With it, the attempt is abandoned and an `open` uncertainty keeps the verbatim intent.
   - A later bootstrap delivers the old request's grant, and it is ingested once.
   - The uncertainty stays `open`, and cannot be updated or deleted.
   - No invoice exists.
2. **Consumed 0 → 2 → 1 is rejected, including restart and both ingestion paths.**
   `tests/electron/suites/allocationRevisionConsumption.suite.ts`:
   - `:60` accepts 0 → 2;
   - `:75` refuses 2 → 1 and rolls back, including the high-water mark, read through an independent connection;
   - `:89` keeps refusing after a restart between the responses;
   - `:103` covers bootstrap then top-up replay;
   - `:124` covers top-up replay then bootstrap.
3. **Ordinary Tab/Shift+Tab navigation works, and scanner terminators cannot activate Print or payment controls.**
   `src/renderer/src/modules/pos/scanInputRouter.test.ts`:
   - `:176`, payment-done: a scan with a Space and an Enter or Tab suffix never clicks a focused Complete, Exact cash, Print or New sale, and is delivered once;
   - `:197`, payment-tender, the same for Complete and Exact cash;
   - `:214`, payment-other;
   - `:227`, keyboard Enter/Space suppressed, pointer click still works;
   - `:315`, _"never consumes Tab or Shift+Tab when not collecting"_.

   **Live walkthrough** of the same condition:
   - Tab → Close → Print → New sale, then Shift+Tab → Print, on the done screen.
   - A scanner code with an Enter suffix (New sale focused) and with a Tab suffix (Print focused) went to the next sale exactly once.
   - 0 print jobs.

## Other live walkthrough results (real Electron app, CDP, disposable backend)

- **Areas 1 and 4:**
  - After a sale the card showed "Warehouse 100 · Sold here 1", with server stock at 99.
  - An owner product with no stock was refused honestly; after receiving stock and refreshing, it sold and uploaded (server 10 → 9).
  - A refresh after a partly consumed prepared grant installed, at both the higher and the same revision.
  - Offline sales and a restart worked, and all 8 invoices synced exactly once.
- **Areas 2 and 3:**
  - The resize works by drag, arrows and Home/End (320–640), persists after a restart, and follows RTL key direction.
  - F9 / Shift+F9 / Ctrl+P / Esc work.
- **Area 6 (owner dashboard):**
  - After the till stopped, presence moved from "Seen ≤ 5 min" to "Seen ≤ 24 h" without a reload.
  - After a relaunch it returned to "Seen ≤ 5 min · just now" within a minute.
  - Samples: `screenshots/owner-dashboard/presence-samples.json`.
- **Screenshot matrix:** 4 viewports × EN/AR × light/dark, for the POS page and the payment dialog. The automated layout checks (no horizontal scroll, dialog in the viewport, primary action visible) passed for all 32 frames; see `manifest.json`.
- **Defects found live and fixed, each with a regression test:**
  - a false "exact-cash payment was removed" on the done screen (`walkthrough/live-01*` shows it before the fix);
  - the offline ×10 gate against 9 reserved;
  - a stale rebuild banner on a new cart;
  - an out-of-stock tone while the till still held a reservation;
  - a stale "Added to sale" line after Clear;
  - English singular copy on the Sync view ("Sent 1 times");
  - the Sync view not refreshing when the reconciler resolved a request.

## Repository identities

| Run                                                                        | Desktop                                                                                                                                                        | Backend                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Final official owner-product live gate** (2026-09-29 17:41:05–17:41:55Z) | HEAD `8bf015408eddcb768b5b94ac9b0e7c8ca154e058` (`feat/pos-quick-sale-redesign`) plus the uncommitted working tree: 110 entries, fingerprint `3b26de84…294ef1` | HEAD `9004b590f03844fc992235aba60087c8f311b156` (`feat/owner-create-modals`) plus 47 uncommitted entries, fingerprint `0f0b439b…e3cb64`. The dirty entries belong to another session and are confined to `resources/company-owner`, `tests/Browser`, `docs/development` and `.ai/rules`; no `app/`, `routes/`, `config/` or `database/` file is dirty. The tests therefore did **not** run against backend HEAD alone. |
| Sync-view live walkthrough (≈17:27–17:40Z)                                 | Same HEAD. The build came from the final tree except for later lint/format-only edits to two test files.                                                       | Same HEAD and dirty scope as above (not separately fingerprinted).                                                                                                                                                                                                                                                                                                                                                     |
| Areas 1–6 live walkthrough and screenshot matrix (≈16:27–17:10Z)           | HEAD `8bf0154` plus that session's working tree (not fingerprinted at the time; later changes are listed in the final report)                                  | HEAD `9004b59` plus the uncommitted entries present at the time (not fingerprinted)                                                                                                                                                                                                                                                                                                                                    |
| Pre-fix reproduction                                                       | Unmodified `8bf0154` build                                                                                                                                     | A read-only `git archive` of backend HEAD `1479622`                                                                                                                                                                                                                                                                                                                                                                    |

The full identities and the backend's dirty path list are in `live-suite/repository-identities.json`.
The fingerprints were taken before this directory was added.

## Limitations and observations

- **Not produced live:** an identity conflict (`IDEMPOTENCY_CONFLICT`) and an invalid request. They are covered by the automated suites only.
- **Not run live:** heartbeat suspend/resume (automated only), and a physical-presence GUI walkthrough. The live gate covers PP at the service level (scenarios B and E).
- **Catalog timestamp resolution.** `generated_at` has one-second resolution. A refresh in the same second as an owner's catalog change is refused with `CATALOG_REVISION_CONFLICT`, and a refresh a moment later succeeds. This is existing behaviour; the live gate waits past the boundary.
- **Authority outlives a policy change.** A physical-presence authority, once issued, stays usable for its window even after the policy switches back to allocation mode. This is documented backend behaviour (§6.5), and the scenarios assert "no authority held" rather than relying on the mode.
- **Preparation includes every tracked product.** Offline-stock preparation selects every tracked product, so one product without an exposure policy makes the server refuse the whole preparation. This is existing behaviour and was not changed.
- **Sandbox artifacts:**
  - Harness suite output is discarded by design, so scenario evidence comes from the evidence files.
  - The walkthrough sandbox's SQLite with 4 PHP workers produced one `database is locked` 500 during an overlapping prepare and bootstrap.
- **Screenshots from builds that were later changed:**
  - `walkthrough/live-01` shows a defect that was then fixed.
  - `walkthrough/live-03` predates the "Only N reserved" wording.
  - The done-screen frames predate the product-card tone fix (they show no product cards).
  - The POS matrix was captured after the tone fix but before the Clear scan-line fix, which is not visible in frames that show a cart.
