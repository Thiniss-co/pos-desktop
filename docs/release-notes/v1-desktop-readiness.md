# Release notes — V1 desktop readiness

Status: local commits on `feat/v1-desktop-readiness` (desktop slot 2), based on local `main` `af77c04`.
**Not merged, not pushed, not released.** Backend counterpart: none — every change consumes the backend
contract as it exists at `pos-backend` `b4c85cf`; no backend change is required.

## PS6b: operator dispositions reach the register

Before this release a physical-presence sale quarantined by the server (`DESKTOP_INVOICE_QUARANTINED`)
stayed `rejected` on the register forever, even after an operator decided it: the PS6b discovery and
convergence code existed but nothing ran it.

- The register now asks `GET /invoices/sync-status` about its own quarantined v3-family sales (at most
  50 per request) at startup and whenever access is re-published (reconnect, licence validation,
  bootstrap refresh), at most once a minute and at most once per sale every two minutes. Each run
  re-checks sync access, `pos.invoice.upload`, connectivity and the signed-in owner. No new IPC.
- A decided sale is verified completely against its frozen payload and applied atomically:
  - `accept_without_proof`: the sale becomes `synced` to the server's invoice (same key, same local
    UUID, the server's number); its overridden proofs are recorded.
  - `reject_permanently`: the sale stays `rejected` with no server invoice.
  - Either way each overridden allocation identity gets a permanent local deny-spend hold, which also
    releases dependent sales into their own upload (each is dispositioned separately).
  - The immutable consumption journal and every queued payload are never changed; nothing is resent.
- A decision that does not verify is recorded as a durable contract conflict and never retried.
- Verification follows the backend's actual stored result (see
  [sync-contract-summary.md](../backend-contract/sync-contract-summary.md)): PHP-encoded result hash
  (MySQL-safe), identity-grouped proof order, accepted proofs without a server consumption UUID,
  coverage and hold instructions derived from the proof outcomes.
- Migration **0034** rebuilds `invoice_disposition_proof_results` (empty in the field — nothing wrote
  it before) to allow an accepted proof without a server consumption UUID.
- Operators still decide through `POST /invoices/dispositions` (`inventory.manage`); the desktop has no
  UI for that decision.
- Evidence: SQLite suite `dispositionDiscovery.suite.ts` (10 cases), unit tests
  `invoiceDispositionConvergence.service.test.ts`, Electron–Laravel journey `ps6bdisposition`.

## Refunds: an unclassified dispatch failure no longer strands the refund

- A failure the refund upload client did not classify (for example a raw error from the transport
  stack or a listener after the request was sent) used to leave the refund `dispatched`: not
  resumable, and holding the invoice's one open refund until the next restart. It is now recorded
  `unresolved`; Resume replays the same frozen bytes under the same key and the server returns the
  original refund. Definitive rejections and 409 conflicts are unchanged.
- Evidence: live r6 scenario "an unclassified failure after real acceptance…" (failed before the fix,
  passes after), with the existing lost-response, restart, replay and conflict scenarios.

## Touch keypad coverage

- Fixed (found by the new touch-only journey): choosing a payment method pre-fills and selects the
  amount, but an on-screen keypad key appended to it instead of replacing it, as a typed key does. A
  selected "15.53" silently ignored the digits; a selected "20" would have become "2050". A keypad key
  now replaces a fully selected amount (`NumericAmountInput`).
- Unit tests for the touch-mode store and switch, and for the payment panel's tender keypad.
- Journey `qc5touch` part E: an invoice percentage discount and a cash tender typed on the on-screen
  keypads by touch only.
- The keypad serves the tender amount, the invoice discount and the cart-line quantity. Not served
  (unchanged, recorded for a later decision): shift opening/closing cash and the quick-create product
  price, which use the system keyboard.

## Documentation

- `.gitignore` tracks markdown under `docs/` instead of ignoring the whole folder; generated evidence
  stays ignored. `docs/backend-contract/README.md` (linked from `CLAUDE.md`) and the mixed-tax fix
  report `docs/audits/mixed-tax-cart-fix/README.md` are now tracked.
