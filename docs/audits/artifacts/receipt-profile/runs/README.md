# Receipt-profile live-gate runs

Each directory holds one run of the real Electron↔Laravel receipt-profile gate, written through
`RECEIPT_PROFILE_ARTIFACT_DIR`:

- `*.html` and `*.document.json` come from `scripts/cp3g5LiveUpload.mjs`.
- `*.png` and `*.pdf` come from `scripts/runReceiptRenderCheck.mjs`, pointed at the same directory.

Every set is internally consistent. The data is synthetic: disposable-database fixtures with CP3G5RP
numbers.

| Run                                        | Status                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `v3-acceptance-2026-09-28-committed-tree/` | **Acceptance evidence.** Run on exactly the application tree recorded in `docs/design/claude-v3/ACCEPTANCE.md` §1. |
| `v3-acceptance-2026-09-28-final/`          | Superseded. The same code before a whitespace-only Prettier pass over 12 files.                                    |
| `v3-acceptance-2026-09-28/`                | Superseded. The first run after the receipt-profile wiring was restored, before the preparation and IPC fixes.     |

The set directly in `docs/audits/artifacts/receipt-profile/` is the original committed evidence from
commit 2997048. It is unchanged by these runs.
