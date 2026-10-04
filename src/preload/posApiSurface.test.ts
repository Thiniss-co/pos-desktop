import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./posApi.ts', import.meta.url), 'utf8')

describe('posApi surface', () => {
  it('contains only named foundation methods', () => {
    expect(source).toContain('getRuntimeInfo')
    expect(source).toContain('getIdentitySummary')
    expect(source).toContain('getSessionSummary')
    expect(source).toContain('getStatus')
  })

  it('contains the Phase 2 activation, login, license, and bootstrap methods', () => {
    expect(source).toContain('register')
    expect(source).toContain('login')
    expect(source).toContain('refreshSession')
    expect(source).toContain('logout')
    expect(source).toContain('validate')
    expect(source).toContain('getAccess')
    expect(source).toContain('refresh')
  })

  it('contains only the named connectivity and preference methods', () => {
    expect(source).toContain('connectivity')
    expect(source).toContain('getState')
    expect(source).toContain('checkNow')
    expect(source).toContain('onChanged')
    expect(source).toContain('preferences')
    expect(source).toContain('getLocale')
    expect(source).toContain('setLocale')
    expect(source).toContain('getTheme')
    expect(source).toContain('setTheme')
  })

  it('exposes the layout-only POS cart width preference as two narrow named methods', () => {
    expect(source).toContain('getPosCartWidth(): Promise<IpcResult<PosCartWidthPreference>>')
    expect(source).toContain(
      'setPosCartWidth(width: number | null): Promise<IpcResult<PosCartWidthPreference>>'
    )
    expect(source).toContain(
      'getPosCartWidth: () => ipcRenderer.invoke(IPC_CHANNELS.preferencesGetPosCartWidth)'
    )
    expect(source).toMatch(
      /setPosCartWidth: \(width: number \| null\) =>\s*ipcRenderer\.invoke\(IPC_CHANNELS\.preferencesSetPosCartWidth, width\)/
    )
    // The width is the only thing that crosses: no layout blob, no cart/sale state.
    expect(source).not.toMatch(/setPosCartWidth\([^)]*(cart|sale|layout)\w*:/i)
    expect(source).not.toContain('posCartWidthSchema')
  })

  it('contains only named company-user management methods', () => {
    expect(source).toContain('companyUsers')
    expect(source).toContain('listAssignableRoles')
    expect(source).toContain('setEnabled')
    expect(source).toContain('setRoles')
  })

  it('contains only narrow read-only catalog and explicit shift lifecycle methods', () => {
    expect(source).toContain('catalog')
    expect(source).toContain('listCategories')
    expect(source).toContain('searchProducts')
    expect(source).toContain('findProductByBarcode')
    expect(source).toContain('searchCustomers')
    expect(source).toContain('listPaymentMethods')
    expect(source).toContain('shifts')
    expect(source).toContain('pause')
    expect(source).toContain('resume')
    expect(source).toContain('close')
  })

  it('contains the checkout preview method and the five Phase 3F completion/recovery methods', () => {
    expect(source).toContain('checkout')
    expect(source).toContain('checkoutValidate')
    expect(source).toContain('complete')
    expect(source).toContain('retryAttempt')
    expect(source).toContain('abandonAttempt')
    expect(source).toContain('acknowledgeAttempt')
    expect(source).toContain('pendingAttempts')
  })

  it('exposes the owner-scoped attempt-status reconciliation read (POS reliability rev 3)', () => {
    expect(source).toContain('attemptStatus(input: CheckoutAttemptStatusInput)')
    expect(source).toContain('IPC_CHANNELS.checkoutAttemptStatus')
  })

  it('exposes quick-create access as one narrow named read (POS improvements, Stage 1)', () => {
    expect(source).toContain('getAccess(): Promise<IpcResult<QuickCreateAccess>>')
    expect(source).toContain(
      'getAccess: () => ipcRenderer.invoke(IPC_CHANNELS.quickCreateGetAccess)'
    )
  })

  it('does not expose tokens, SQL, filesystem access, HTTP, or a caller-provided channel', () => {
    expect(source).not.toMatch(/token|sqlite|sql|fs|fetch|axios/i)
    expect(source).not.toMatch(/invoke\(channel|invoke\(.*unknown/i)
  })

  it('exposes only the narrow stock-allocation recovery capability (BH-04B-4)', () => {
    // Allocation acquisition is main-only and reachable solely as a side effect of
    // `checkout:complete`/`checkout:retry-attempt`. Recovery may name an already-owned allocation,
    // but cannot request rights, quantities, generations, revisions, or idempotency keys.
    expect(source).toContain('allocationRecovery')
    expect(source).toContain('start(input: { allocationUuid: string })')
    expect(source).toContain('resume(): Promise<IpcResult<void>>')
    expect(source).not.toMatch(
      /requestAllocation|grantAllocation|requestedQuantity|rightsGeneration/i
    )
    expect(source).not.toMatch(/top-?up/i)
    expect(source).not.toMatch(/idempotency/i)
  })

  it('keeps runtime validation out of the sandboxed preload bundle', () => {
    expect(source).not.toContain('connectivitySnapshotSchema')
    expect(source).not.toContain('syncStatusSchema')
    expect(source).not.toContain('syncFailurePageSchema')
    expect(source).not.toContain('syncSupportIssuesSchema')
  })

  it('exposes exactly the four named sync capabilities (CP-3G-4)', () => {
    expect(source).toContain('uploadNow')
    expect(source).toContain('listFailures')
    expect(source).toContain('syncGetStatus')
    expect(source).toContain('syncUploadNow')
    expect(source).toContain('syncListFailures')
    expect(source).toContain('syncChanged')
  })

  it('exposes the needs-attention projection as one argument-free, read-only method', () => {
    expect(source).toContain('supportIssues(): Promise<IpcResult<SyncSupportIssues>>')
    expect(source).toContain(
      'supportIssues: () => ipcRenderer.invoke(IPC_CHANNELS.syncSupportIssues)'
    )
    // Nothing can act on an issue from the renderer: no retry, acknowledge, close or delete.
    expect(source).not.toMatch(
      /(retry|acknowledge|resolve|close|delete|dismiss)(Support|Issue|Dispatch|Uncertaint)/i
    )
  })

  it('validates a pushed sync status structurally before calling a renderer listener', () => {
    // The listener is called only from inside the guard, so neither a malformed payload nor the
    // Electron event object can reach renderer code.
    expect(source).toContain('isSyncStatusShape')
    expect(source).toMatch(/if \(isSyncStatusShape\(payload\)\) \{\s*listener\(payload\)/)
  })

  it('exposes no sync mutation beyond an unparameterised scheduling hint', () => {
    // `uploadNow` takes no argument at all: the renderer cannot name a queue row, an invoice, an
    // owner or a state, so no preload call can retry, resolve or revive a terminal failure.
    expect(source).toContain('uploadNow: () => ipcRenderer.invoke(IPC_CHANNELS.syncUploadNow)')
    expect(source).not.toMatch(/retryUpload|resolveConflict|deleteFailure|markResolved/i)
  })

  it('never registers an inbound handler for the push-only sync channel', () => {
    // `sync:changed` is main-to-renderer only; the preload may listen, never send.
    expect(source).not.toMatch(/send\(IPC_CHANNELS\.syncChanged/)
    expect(source).not.toMatch(/invoke\(IPC_CHANNELS\.syncChanged/)
  })

  it('exposes the narrow sales and refund domain channels (plan §5, r5)', () => {
    expect(source).toContain('sales:')
    expect(source).toContain('listInvoices')
    expect(source).toContain('getInvoice')
    expect(source).toContain('refunds:')
    expect(source).toContain('getRefundable')
    expect(source).toContain('preview')
    expect(source).toContain('submit')
    expect(source).toContain('resume')
    expect(source).toContain('cancelPrepared')
    expect(source).toContain('IPC_CHANNELS.refundsSubmit')
    expect(source).toContain('IPC_CHANNELS.refundsPreview')
    expect(source).toContain('IPC_CHANNELS.refundsResume')
    expect(source).toContain('IPC_CHANNELS.refundsCancelPrepared')
    expect(source).toContain('IPC_CHANNELS.refundsGetRefundable')
    expect(source).toContain('IPC_CHANNELS.salesListInvoices')
    expect(source).toContain('IPC_CHANNELS.salesGetInvoice')
  })

  it('the refund submit intent never names an authoritative amount, timestamp, or key', () => {
    // Renderer supplies selections only: invoice/line/payment IDENTITIES. Money, timestamps,
    // ownership and the idempotency key are resolved and frozen by RefundService, never here.
    expect(source).not.toMatch(/grandTotal|subtotalAmount|idempotencyKey|refundedAt/i)
  })

  it('exposes the narrow printing domain channels (receipt-printing plan)', () => {
    expect(source).toContain('printing:')
    expect(source).toContain('getWorkstationSettings')
    expect(source).toContain('saveWorkstationSettings')
    expect(source).toContain('listPrinters')
    expect(source).toContain('IPC_CHANNELS.printingPreview')
    expect(source).toContain('IPC_CHANNELS.printingDispatch')
    expect(source).toContain('IPC_CHANNELS.printingGetJob')
    expect(source).toContain('IPC_CHANNELS.printingCancelJob')
    expect(source).toContain('IPC_CHANNELS.printingLatestForDocument')
    expect(source).toContain('IPC_CHANNELS.printingGetWorkstationSettings')
    expect(source).toContain('IPC_CHANNELS.printingSaveWorkstationSettings')
    expect(source).toContain('IPC_CHANNELS.printingListPrinters')
    expect(source).toContain('IPC_CHANNELS.printingAutoPrintStatus')
    expect(source).toContain('IPC_CHANNELS.printingAutoPrintSetup')
    expect(source).toContain('IPC_CHANNELS.printingAutoPrintNotices')
    expect(source).toContain('IPC_CHANNELS.printingAutoPrintDismissNotices')
  })

  it('exposes the receipt-profile editor channels without any file-path argument', () => {
    expect(source).toContain('receiptProfile:')
    expect(source).toContain('IPC_CHANNELS.receiptProfileGet)')
    expect(source).toContain('IPC_CHANNELS.receiptProfileChooseLogo)')
    expect(source).toContain('IPC_CHANNELS.receiptProfilePublish, input)')
    // The logo is chosen through main's native dialog; the renderer can never name a file.
    expect(source).not.toMatch(/chooseLogo:\s*\([^)]+\)/)
  })

  it('the printing preload never sends raw HTML, a URL, a filesystem path, or a printer command', () => {
    // The renderer sends only a document reference (kind + local uuid), locale and narrow output
    // overrides -- never the receipt markup, an asset path, or a device-level print command. Main
    // alone builds and renders the document (receiptDocument.service.ts / receiptHtml.ts).
    expect(source).not.toMatch(/<html|<!doctype|deviceName\s*:\s*['"`]|printerCommand|escpos/i)
  })
})
