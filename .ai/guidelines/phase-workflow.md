# Phase Workflow Rules

Work on this repository proceeds strictly phase by phase. Full per-phase deliverables/verification
live in `docs/phases/*.md`; this file states the sequencing rule.

| Phase | Name | Focus |
|---|---|---|
| 0 | Inspect / AI rules & docs | Understand actual repo state; establish `CLAUDE.md`/`AGENTS.md`/`CODEX.md`, `.ai/guidelines/`, `.claude/skills/`, `docs/`. No feature code. |
| 1 | Foundation structure | Module layout, router, Pinia, typed `window.posApi` bridge, central API client, SQLite + migration runner skeleton, base security hardening. No POS screens yet. |
| 2 | Activation / login / bootstrap | Device registration, login, token storage (main-process-held), bootstrap fetch + local persistence, license validation call. |
| 3 | Shift / cart / barcode | Shift open/pause/close, cash drawer, product catalog browsing/search, barcode scanning, cart building. |
| 4 | Local sale / sync queue | Completing a sale locally, sync queue implementation (states, idempotency, quarantine, pause), background sync process. |
| 5 | Refunds / receipts / printing | Refund flow (invoice-before-refund ordering), receipt rendering, print/reprint bridge. |
| 6 | Hardening / testing / packaging | Full Electron security pass, test coverage per `testing-and-verification.md`, packaging (`electron-builder`) verification. |

## Sequencing Rules

- Do not implement a later phase's functionality while an earlier phase's declared deliverables
  are incomplete, even if it seems efficient to "do it while you're in there."
- Each phase's doc (`docs/phases/0N-*.md`) states explicit **scope** and **out of scope** — out of
  scope items are not implied permission, they are an explicit boundary.
- A phase is done when its **done criteria** are met and its **verification commands** pass (or
  their absence is documented as a gap for the next phase).
- If a task request spans multiple phases, implement only the current phase's slice and say so —
  do not silently expand scope to "finish the feature."
