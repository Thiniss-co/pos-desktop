# CP-3 Completion and Recovery IPC, Security Boundary Checkpoint

Date: 2026-08-29

Scope: desktop CP-3 only — the five new `checkout:*` IPC channels (plan §2.9), their Zod input
schemas, the `checkout.ipc.ts` handlers wiring them to `LocalSaleService`, the `posApi.ts`
renderer-facing bridge surface, and the associated tests. Explicitly **out of scope, not touched**:
any `.vue` file, any Pinia store, and any renderer page — those are CP-4. No production database was
touched; the new IPC-layer tests are pure vitest with `electron`/`assertTrustedSender` mocked (the
existing pattern for every other IPC handler test in this codebase), proving handler wiring and
ordering, not SQLite behavior — SQLite-level behavior for every code path these handlers call was
already proven at CP-2.

Depends on: CP-2 (`LocalSaleService`, `ApplicationServices.localSale`, and the
`checkoutCompletionOutcomeSchema`/`checkoutRecoveryStateSchema` contract, all implemented and
verified in this session).

## Result

- Added the five channels named in plan §2.9 to `IPC_CHANNELS`: `checkout:complete`,
  `checkout:pending-attempts`, `checkout:retry-attempt`, `checkout:abandon-attempt`,
  `checkout:acknowledge-attempt`.
- Added their input schemas to `checkout.contract.ts` (`checkoutCompleteInputSchema` wraps
  `{attemptKey, intent}`; the other four are key-only or key+pagination), all `.strict()`, and
  re-exported them from `ipc.validators.ts` following the exact existing convention (e.g.
  `closeShiftInputSchema` in `shift.contract.ts`). `attemptKey` is validated as `z.uuid()` — the
  renderer-generated idempotency key, matching the `createUuid`/`randomUUID` convention already used
  everywhere else main-side; it is never resolved, reused, or defaulted by main.
- Extended `registerCheckoutIpcHandlers` with the five handlers, each following the identical
  `assertTrustedSender` → `handleIpcRequest` pattern the existing `checkout:validate` handler already
  uses. Every handler calls exactly one `LocalSaleService` method and returns its result unmodified —
  `complete`/`retryAttempt`/`abandonAttempt`/`acknowledgeAttempt` all resolve to
  `checkoutCompletionOutcomeSchema`'s union; `pendingAttempts` is the one read-only channel.
- `checkout:pending-attempts` needed a genuine mapping step, not a pass-through: `LocalSaleService
  .pendingAttempts()` returns raw `SaleAttemptRow`s (carrying `intent_json`, both fingerprints, and
  origin columns — plan §1.1's internal shape), while `checkoutRecoveryStateSchema` is deliberately
  narrower per plan §2.9 ("no foreign record disclosed"). Added `toRecoveryState()` in
  `checkout.ipc.ts` to project each row down to exactly `{attemptKey, state, claimedAt}` (blocking) /
  `{attemptKey, committedAt}` (unacknowledged) before it ever reaches `ipcSuccess`. A test asserts the
  serialized IPC response never contains the raw row's `intent_json` or fingerprint content.
- Extended `posApi.ts`'s `checkout` surface with `complete`, `retryAttempt`, `abandonAttempt`,
  `acknowledgeAttempt`, `pendingAttempts`, typed against the CP-2 contract types
  (`CheckoutCompleteInput` → `IpcResult<CheckoutCompletionOutcome>`, etc.), following the exact
  `Object.freeze` + `ipcRenderer.invoke(IPC_CHANNELS.x, input)` shape used by every other bridge
  method — no generic `invoke`, one method per capability, matching CLAUDE.md §6.
- Updated `posApiSurface.test.ts`'s source-scan assertion (previously titled "the single checkout
  preview method") to also require the five new method names are present in `posApi.ts`.

## What changed

New:

- `docs/audits/cp-3-completion-recovery-ipc-checkpoint.md` (this file)

Modified:

- `src/shared/constants/ipcChannels.ts` — five new channel entries.
- `src/shared/contracts/checkout.contract.ts` — `checkoutCompleteInputSchema`,
  `checkoutRetryAttemptInputSchema`, `checkoutAbandonAttemptInputSchema`,
  `checkoutAcknowledgeAttemptInputSchema`, `checkoutPendingAttemptsInputSchema`, and their inferred
  types.
- `src/shared/validators/ipc.validators.ts` — re-exports the five new schemas.
- `src/main/ipc/checkout.ipc.ts` — five new `ipcMain.handle` registrations and `toRecoveryState()`.
- `src/preload/posApi.ts` — the five new `PosApi.checkout` methods (interface + frozen impl).
- `src/preload/posApiSurface.test.ts` — the checkout-method assertion now names all five.
- `src/main/ipc/checkout.ipc.test.ts` — 21 total tests in the file (18 new): sender-check-before-parse
  ordering for each of the five channels; malformed/non-UUID attempt keys rejected; a fabricated
  price field inside `intent` rejected even wrapped in `checkoutCompleteInputSchema`; an unrecognized
  `force` field on `checkout:complete` rejected outright (no bypass parameter exists); a blocking
  claimed attempt's `attempt-blocked` outcome (with `blockingAttemptKey`) passed through unmodified
  for a fresh key, proving there is no alternate direct-IPC path around it; `retry-attempt` is
  key-only and rejects a payload that also carries `intent`; foreign-owner `not-found` passthrough for
  `retry-attempt` and `acknowledge-attempt`; `acknowledge-attempt` idempotency (two calls, two
  identical results); `pending-attempts` bounded pagination (a `limit` above the maximum is rejected
  before the service is ever called) and the `intent_json`/fingerprint redaction proof described
  above.

## Verification evidence

All commands actually executed, in this repository, after every change in this checkpoint:

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS (0 errors, 0 warnings) |
| `npm run test` (vitest) | PASS — 568 tests, 84 files |
| `npm run test:sqlite:electron` | PASS — 97 tests, 0 failures (unchanged from CP-2; no SQLite-layer code was touched) |
| `npm run verify:fixture` | PASS |
| `npm run smoke:database` | PASS |
| `npm run build` | PASS |
| `git diff --check` | PASS |

## Security boundary confirmation

Every one of the five new channels calls `assertTrustedSender` before any parsing, matching the plan
invariant "assertTrustedSender before parse on all five channels" — proven by five dedicated tests
where a thrown sender rejection is the only thing on the mock, so the assertion that the service
method "was not called" is a genuine ordering proof, not a coincidence. No new channel accepts price,
tax, payment-method, or total fields — `checkoutCompleteInputSchema`'s `intent` field is the existing
`.strict()` `checkoutIntentSchema`, unchanged. No new channel exposes `ipcRenderer` itself, a generic
`invoke`, or a caller-supplied channel name (`posApiSurface.test.ts`'s existing regex assertion for
this was not weakened). No SQLite access was added outside the main-process repository/service layer
that already existed after CP-1/CP-2. No new dependency was added. `contextIsolation`/`nodeIntegration`
/`sandbox` were not touched.

## Explicitly deferred to CP-4/CP-5 (not implemented here, per plan scope)

`checkout.service.ts`, `payment.store.ts`, `cart.store.ts`, `PaymentPanel.vue`, `PosPage.vue`,
`SaleRecoveryBanner.vue`, and locale strings — every renderer-side consumer of the five channels added
in this checkpoint. Fresh-process/SIGKILL IPC-level recovery tests, the direct-IPC fresh-key-bypass
test against a *real* blocked attempt (this checkpoint proved the outcome passthrough has no bypass
parameter; CP-5b is where that gets exercised against the real Electron ABI end-to-end), and the D1
device/session permission matrix at the IPC layer remain CP-5b territory per the plan's own
acceptance-matrix "Where" column. CP-5a artifact generation and BE-3F-2B backend integration are
untouched.
