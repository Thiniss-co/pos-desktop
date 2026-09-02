import type { CommercialAccessPublisher } from '../ipc/license.ipc'

export interface InvoiceUploadTriggerDependencies {
  /**
   * The authoritative main-owned access-change signal. Licence validation, bootstrap-refresh
   * completion, catalog refresh and connectivity transitions all publish through it, so observing
   * it once covers commercial-access *and* permission restoration without polling and without
   * inventing a second event.
   */
  readonly accessPublisher: Pick<CommercialAccessPublisher, 'onPublished'>
  readonly worker: { requestRun(): void }
}

/**
 * Wires the upload worker to the access-change signal, and returns the disposer.
 *
 * This exists as its own function so the production wiring is a thing a test can execute, rather
 * than a line only the composition root knows about. CP-3G-4A's requirement is precisely that: a
 * worker method that resumes correctly when called directly proves nothing about whether anything
 * in production ever calls it.
 *
 * What crosses this seam is a **hint**, never authority:
 *
 * - the signal says "access may have changed", never "access is granted";
 * - `requestRun()` re-runs the whole fail-closed gate — `assertAllowed('sync')`, the
 *   `pos.invoice.upload` permission, session company/device ownership, row eligibility and payload
 *   integrity — immediately before any dispatch, so a hint delivered while access is still denied
 *   re-pauses and sends nothing;
 * - the worker is single-flight, so a burst of publications collapses into one drain plus at most
 *   one rerun;
 * - nothing here originates in, or is reachable from, the renderer.
 */
export function subscribeInvoiceUploadTriggers(
  dependencies: InvoiceUploadTriggerDependencies
): () => void {
  return dependencies.accessPublisher.onPublished(() => {
    dependencies.worker.requestRun()
  })
}
