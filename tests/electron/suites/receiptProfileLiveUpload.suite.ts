import { deepEqual, equal, notEqual, ok } from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ReceiptDocument } from '../../../src/shared/receipt/receiptDocument'
import { DESKTOP_API_ROUTES } from '@shared/constants/apiRoutes'
import { closeDatabase } from '../../../src/main/database/connection'
import { DesktopApiClient } from '../../../src/main/http/desktopApiClient'
import { isPublicAppError } from '../../../src/main/http/apiError'
import { desktopBootstrapResourceSchema } from '../../../src/main/http/desktopResources.contract'
import { BootstrapService } from '../../../src/main/services/bootstrap.service'
import { ReceiptProfileSyncService } from '../../../src/main/receipt/receiptProfileSync.service'
import { ReceiptProfileAdminService } from '../../../src/main/receipt/receiptProfileAdmin.service'
import { ReceiptContextCaptureService } from '../../../src/main/receipt/receiptContextCapture.service'
import { ReceiptDocumentService } from '../../../src/main/receipt/receiptDocument.service'
import { buildReceiptHtml } from '../../../src/main/receipt/receiptHtml'
import { RefundService } from '../../../src/main/services/refund.service'
import { RefundAccessService } from '../../../src/main/services/refundAccess.service'
import { uploadRefund } from '../../../src/main/sync/refundUpload.client'
import type { StoredDeviceIdentity } from '../../../src/main/services/deviceIdentity.service'
import type { SessionContext } from '../../../src/main/repositories/sessionMetadata.repository'
import { databaseTest, type DatabaseSandbox } from '../support/sandbox'
import { openTestDatabase } from '../support/openTestDatabase'
import { realRepositories, type RealRepositories } from '../support/realRepositories'
import { liveReceiptProfileBackendAvailable, liveUploadFixture } from '../support/liveUploadBackend'

/**
 * Receipt-printing plan §D-10/§D-11 -- the required real Electron-process <-> real Laravel-server
 * receipt-profile integration gate. Reuses the CP-3G-5 live-backend harness (a real
 * `php artisan serve` on a disposable SQLite database, driven by `scripts/cp3g5LiveUpload.mjs`)
 * exactly as `refundLiveUpload.suite.ts` already does: the seeder was extended with an opt-in
 * `CP3G5_MINT_RECEIPT_PROFILE_CONTEXT=1` block (mirroring the existing `CP3G5_MINT_REFUND_CONTEXT`
 * pattern) rather than a new harness.
 *
 * Every step dispatches through REAL production classes: `DesktopApiClient`, `BootstrapService`,
 * `ReceiptProfileRepository`/`ReceiptProfileSyncService`/`ReceiptProfileAdminService`,
 * `ReceiptContextCaptureService`, `ReceiptDocumentService`/`buildReceiptHtml`, `RefundService`, and
 * the real `apiError.ts` envelope parser -- against a real HTTP server and a real disposable
 * SQLite backend database. Only the Electron `dialog.showOpenDialog` file picker (an OS-shell
 * dependency, never an integration boundary) is stubbed, returning a real PNG file on disk that the
 * real `readFile` reads and the real upload endpoint really processes.
 *
 * Skips entirely when no live receipt-profile context was provided, so `npm run test:sqlite:electron`
 * stays hermetic on its own.
 */
function liveTest(name: string, callback: (sandbox: DatabaseSandbox) => Promise<void>): void {
  databaseTest(
    name,
    async (sandbox) => {
      await callback(sandbox)
    },
    {
      skip: liveReceiptProfileBackendAvailable()
        ? false
        : 'no live receipt-profile context provided'
    }
  )
}

function apiClientFor(origin: string, token: string, deviceUuid: string): DesktopApiClient {
  return new DesktopApiClient({
    apiOrigin: new URL(origin),
    getAccessToken: () => token,
    getDeviceUuid: () => deviceUuid,
    timeoutMs: 20_000
  })
}

/** An intentionally unreachable loopback origin -- proves a code path took no network route at
 *  all, rather than merely asserting it "should" by reading its dependency list. */
function unreachableApiClient(deviceUuid: string): DesktopApiClient {
  return new DesktopApiClient({
    apiOrigin: new URL('http://127.0.0.1:1'),
    getAccessToken: () => 'unreachable-token',
    getDeviceUuid: () => deviceUuid,
    timeoutMs: 1_000
  })
}

function deviceIdentityStandIn(deviceUuid: string): { get(): StoredDeviceIdentity } {
  return {
    get: () => ({
      deviceUuid,
      deviceName: 'CP3G5 Receipt-Profile Register',
      platform: 'linux',
      osVersion: '6.0',
      appVersion: '1.0.0',
      isRegistered: true
    })
  }
}

function sessionContextStandIn(
  companyUuid: string,
  deviceUuid: string,
  userUuid: string
): { getContext(): SessionContext } {
  return {
    getContext: () => ({
      isAuthenticated: true,
      userUuid,
      userIsActive: true,
      companyUuid,
      deviceUuid,
      serverDeviceId: 'cp3g5-rp-server-device'
    })
  }
}

/**
 * `ReceiptProfileSyncService`'s default PNG decoder calls Electron's `nativeImage`, which is
 * unavailable under `ELECTRON_RUN_AS_NODE` (this harness's own execution mode -- see
 * `scripts/runElectronNode.mjs`; production always runs with a real GUI process, where
 * `nativeImage` is fully available). Both services document `decodePng` as exactly this test seam,
 * so this reads the real PNG's IHDR chunk directly (width/height are the big-endian u32s at bytes
 * 16-23 of any valid PNG) rather than substituting a hand-built fake for an integration boundary.
 */
function decodePngIhdr(buffer: Buffer): { widthPx: number; heightPx: number } | null {
  if (buffer.length < 24) {
    return null
  }
  return { widthPx: buffer.readUInt32BE(16), heightPx: buffer.readUInt32BE(20) }
}

/**
 * Persists real evidence from this gate's own transactions to the repository's designated audit
 * location (`docs/audits/artifacts/receipt-profile/`) rather than leaving it only in a torn-down
 * `/tmp` sandbox. `scripts/receiptRenderCheck.entry.ts` renders each `*.document.json` written here
 * through the same real-Chromium pipeline as its own built-in scenarios, producing the actual
 * PDF/PNG artifacts (a real GUI/window process is required for that step, which this harness's own
 * `ELECTRON_RUN_AS_NODE` execution mode does not provide -- see its own module comment).
 */
const ARTIFACT_DIR = resolve(process.cwd(), 'docs/audits/artifacts/receipt-profile')

function persistArtifact(name: string, document: ReceiptDocument, html: string): void {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  writeFileSync(join(ARTIFACT_DIR, `${name}.document.json`), JSON.stringify(document, null, 2))
  writeFileSync(join(ARTIFACT_DIR, `${name}.html`), html)
}

function countingFetch(): { fetchImplementation: typeof fetch; count: () => number } {
  let calls = 0
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1
    return fetch(input, init)
  }) as typeof fetch
  return { fetchImplementation: impl, count: () => calls }
}

liveTest(
  'the real receipt-profile lifecycle: publish, refusal, monotonic ingestion, sale/refund capture, ' +
    'offline rendering, reprint-after-newer-publish, revision conflict, and tenant isolation',
  async (sandbox) => {
    const fixture = liveUploadFixture()
    ok(fixture !== null && fixture.receiptProfileContext !== null)
    const rp = fixture.receiptProfileContext!

    const database = openTestDatabase(sandbox)
    const repositories: RealRepositories = realRepositories(database)
    const receiptContext = repositories.receiptContext
    const receiptProfileSync = new ReceiptProfileSyncService({
      repository: repositories.receiptProfile,
      apiClient: { request: () => Promise.reject(new Error('unused default')) } as never,
      decodePng: decodePngIhdr
    })

    // A real 1x1 PNG file on disk -- the ONLY thing stubbed is the OS file-open dialog itself.
    const logoPath = join(mkdtempSync(join(tmpdir(), 'pos-desktop-cp3g5-logo-')), 'logo.png')
    writeFileSync(
      logoPath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      )
    )

    function adminServiceFor(
      apiClient: DesktopApiClient,
      refreshBootstrap?: () => Promise<unknown>
    ): ReceiptProfileAdminService {
      return new ReceiptProfileAdminService({
        repository: repositories.receiptProfile,
        sync: new ReceiptProfileSyncService({
          repository: repositories.receiptProfile,
          apiClient,
          decodePng: decodePngIhdr
        }),
        apiClient,
        connectivity: { getSnapshot: () => ({ status: 'online' }) as never },
        dialog: {
          showOpenDialog: async () => ({ canceled: false, filePaths: [logoPath] })
        } as never,
        readFile: (path) => readFile(path),
        refreshBootstrap,
        decodePng: decodePngIhdr
      })
    }

    async function bootstrapMirror(
      companyUuid: string,
      deviceUuid: string,
      userUuid: string,
      token: string
    ): Promise<DesktopApiClient> {
      const apiClient = apiClientFor(fixture!.origin, token, deviceUuid)
      const bootstrap = new BootstrapService(
        apiClient,
        deviceIdentityStandIn(deviceUuid),
        { assertCanSync: () => undefined },
        repositories.bootstrapSnapshot,
        undefined,
        undefined,
        sessionContextStandIn(companyUuid, deviceUuid, userUuid),
        receiptProfileSync
      )
      const result = await bootstrap.refresh()
      ok(result.isComplete)

      return apiClient
    }

    try {
      // -------------------------------------------------------------------------------------
      // 1. Negotiated bootstrap (no profile yet) + CompanyAdmin publish + real logo upload.
      // -------------------------------------------------------------------------------------
      const adminApi = await bootstrapMirror(
        rp.company_uuid,
        rp.device_uuid,
        rp.admin.user_uuid,
        rp.admin.token
      )
      equal(repositories.receiptProfile.getCurrent(rp.company_uuid)?.capability, 'supported')
      equal(repositories.receiptProfile.getCurrent(rp.company_uuid)?.versionUuid, null)
      equal(repositories.receiptProfile.getAuthority(rp.company_uuid, rp.admin.user_uuid), true)

      const adminService = adminServiceFor(adminApi)
      const adminOwner = {
        companyUuid: rp.company_uuid,
        deviceUuid: rp.device_uuid,
        userUuid: rp.admin.user_uuid,
        sessionEpoch: 1
      }

      const chosenLogo = await adminService.chooseLogo(adminOwner)
      ok(chosenLogo.sha256.length === 64)

      const v1 = await adminService.publish(adminOwner, {
        expectedRevision: 0,
        fields: {
          addressLines: ['123 Main St', 'Cairo, Egypt'],
          phone: '+20 100 123 4567',
          taxIdentifierLabel: 'Tax ID',
          taxIdentifierValue: 'RP-TAX-1',
          footerLines: ['Thank you for shopping with us']
        },
        logo: { action: 'set', sha256: chosenLogo.sha256 }
      })
      equal(v1.profile?.revision, 1)
      equal(v1.canManage, true)

      const v1VersionUuid = repositories.receiptProfile.getCurrent(rp.company_uuid)?.versionUuid
      ok(v1VersionUuid !== null && v1VersionUuid !== undefined)
      const v1Version = repositories.receiptProfile.getVersion(v1VersionUuid!, rp.company_uuid)
      equal(v1Version?.logoAvailable, true)
      equal(v1Version?.phone, '+20 100 123 4567')

      // -------------------------------------------------------------------------------------
      // 2. Cashier and Manager refusal -- real bootstrap negotiation, real backend can_manage
      //    computation. The Manager has `receipts.profile.manage` GRANTED DIRECTLY (BD-1b): the
      //    real backend still refuses because it also requires the CompanyAdmin role.
      // -------------------------------------------------------------------------------------
      await bootstrapMirror(rp.company_uuid, rp.device_uuid, rp.cashier.user_uuid, rp.cashier.token)
      equal(repositories.receiptProfile.getAuthority(rp.company_uuid, rp.cashier.user_uuid), false)

      await bootstrapMirror(rp.company_uuid, rp.device_uuid, rp.manager.user_uuid, rp.manager.token)
      equal(
        repositories.receiptProfile.getAuthority(rp.company_uuid, rp.manager.user_uuid),
        false,
        'a directly granted permission must never substitute for the CompanyAdmin role (BD-1b)'
      )

      for (const denied of [rp.cashier, rp.manager]) {
        const spy = countingFetch()
        const deniedApi = new DesktopApiClient({
          apiOrigin: new URL(fixture.origin),
          getAccessToken: () => denied.token,
          getDeviceUuid: () => rp.device_uuid,
          fetchImplementation: spy.fetchImplementation,
          timeoutMs: 20_000
        })
        const deniedService = adminServiceFor(deniedApi)
        const deniedOwner = {
          companyUuid: rp.company_uuid,
          deviceUuid: rp.device_uuid,
          userUuid: denied.user_uuid,
          sessionEpoch: 1
        }

        await adminService_expectAuthorizationDenied(() => deniedService.chooseLogo(deniedOwner))
        equal(spy.count(), 0, 'a refused chooseLogo must never reach the network')

        await adminService_expectAuthorizationDenied(() =>
          deniedService.publish(deniedOwner, {
            expectedRevision: 1,
            fields: {
              addressLines: [],
              phone: null,
              taxIdentifierLabel: null,
              taxIdentifierValue: null,
              footerLines: []
            },
            logo: { action: 'keep' }
          })
        )
        equal(spy.count(), 0, 'a refused publish must never reach the network')
      }

      // -------------------------------------------------------------------------------------
      // 3. Sale profile-version capture -- while the mirror's current pointer is v1.
      // -------------------------------------------------------------------------------------
      await bootstrapMirror(rp.company_uuid, rp.device_uuid, rp.cashier.user_uuid, rp.cashier.token)
      const company = repositories.bootstrapSnapshot.getCompany()
      ok(company !== null)

      const invoiceLocalUuid = randomUUID()
      const attemptKey = randomUUID()
      database
        .prepare(
          `INSERT INTO sale_attempts (
             attempt_key, company_uuid, device_uuid, user_uuid, claim_session_epoch,
             origin_shift_uuid, origin_shift_observed_at, origin_branch_uuid, origin_warehouse_uuid,
             origin_context_fingerprint, intent_fingerprint, intent_version, intent_json, state,
             invoice_local_uuid, claimed_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          attemptKey,
          rp.company_uuid,
          rp.device_uuid,
          rp.cashier.user_uuid,
          1,
          rp.shift_uuid,
          new Date().toISOString(),
          randomUUID(),
          randomUUID(),
          'a'.repeat(64),
          'a'.repeat(64),
          1,
          '{"v":1}',
          'claimed',
          null,
          new Date().toISOString(),
          new Date().toISOString()
        )

      repositories.localSale.insertInvoice({
        localUuid: invoiceLocalUuid,
        attemptKey,
        offlineNumber: `CP3G5RP-LOCAL-${invoiceLocalUuid.slice(0, 8)}`,
        companyUuid: rp.company_uuid,
        branchUuid: randomUUID(),
        warehouseUuid: randomUUID(),
        deviceUuid: rp.device_uuid,
        userUuid: rp.cashier.user_uuid,
        shiftUuid: rp.shift_uuid,
        commitSessionEpoch: 1,
        catalogRevision: 'a'.repeat(64),
        intentFingerprint: 'a'.repeat(64),
        customerUuid: null,
        currency: 'USD',
        currencyExponent: 2,
        taxMode: 'none',
        invoiceDiscountType: null,
        invoiceDiscountValue: 0,
        subtotalAmount: rp.sale.subtotal_amount,
        discountTotalAmount: 0,
        taxTotalAmount: rp.sale.tax_amount,
        grandTotalAmount: rp.sale.total_amount,
        paidTotalAmount: rp.sale.total_amount,
        changeDueAmount: 0,
        soldAt: new Date().toISOString(),
        connectivityStateAtSale: 'online',
        soldWhileOffline: false,
        notes: null,
        commercialSnapshotJson: '{}',
        createdAt: new Date().toISOString()
      })
      database
        .prepare(
          `UPDATE sale_attempts
           SET state = 'committed', invoice_local_uuid = ?, committed_at = ?, last_attempted_at = ?, updated_at = ?
           WHERE attempt_key = ?`
        )
        .run(
          invoiceLocalUuid,
          new Date().toISOString(),
          new Date().toISOString(),
          new Date().toISOString(),
          attemptKey
        )
      repositories.localSale.markInvoiceSynced(invoiceLocalUuid, {
        remoteUuid: rp.sale.invoice_uuid,
        serverNumber: `CP3G5RP-${rp.sale.invoice_uuid.slice(0, 8)}`,
        syncedAt: new Date().toISOString()
      })
      repositories.localSale.insertItem({
        localUuid: randomUUID(),
        invoiceLocalUuid,
        lineIndex: 0,
        productUuid: rp.sale.product_uuid,
        productName: 'CP3G5 Receipt-Profile Service',
        sku: null,
        barcode: null,
        unit: 'pc',
        trackStock: false,
        quantityMilli: 2000,
        unitPriceAmount: 1500,
        currency: 'USD',
        priceRevision: 'a'.repeat(64),
        taxUuid: null,
        taxMode: 'none',
        taxRateBasisPoints: 0,
        taxRevision: 'a'.repeat(64),
        discountType: null,
        discountValue: 0,
        subtotalAmount: rp.sale.subtotal_amount,
        discountAmount: 0,
        taxAmount: rp.sale.tax_amount,
        totalAmount: rp.sale.total_amount,
        createdAt: new Date().toISOString()
      })
      repositories.localSale.insertPayment({
        localUuid: randomUUID(),
        invoiceLocalUuid,
        paymentIndex: 0,
        paymentMethodUuid: rp.payment_method_uuid,
        type: 'cash',
        amount: rp.sale.total_amount,
        reference: null,
        requiresReference: false,
        paidAt: new Date().toISOString(),
        methodSnapshotJson: JSON.stringify({ name: 'Cash' }),
        createdAt: new Date().toISOString()
      })

      const receiptContextCapture = new ReceiptContextCaptureService({
        receiptContext,
        bootstrapSnapshot: repositories.bootstrapSnapshot,
        sessionMetadata: { getSummary: () => ({ userName: 'CP3G5 Cashier' }) },
        customers: { findNameAndTaxNumber: () => null }
      })
      // The exact call `LocalSaleService.complete()` makes internally, right after inserting the
      // invoice -- exercised directly here so this gate's subject (branding capture) is isolated
      // from the unrelated catalog/stock/commercial-access machinery `refundLiveUpload.suite.ts`
      // already established as out of THIS gate's scope for its own "original sale" precondition.
      receiptContextCapture.captureForSale({
        invoiceLocalUuid,
        companyUuid: rp.company_uuid,
        customerUuid: null
      })

      const saleContext = receiptContext.findInvoiceContext(invoiceLocalUuid)
      ok(saleContext !== null)
      equal(saleContext?.receiptProfileVersionUuid, v1VersionUuid)
      equal(saleContext?.issuerCompanyName, company!.name)

      // -------------------------------------------------------------------------------------
      // 4. Accepted-refund profile-version capture -- real preview + submit against the live
      //    backend, through the real RefundService (receiptContext wired the same way production
      //    wires it), while the mirror's current pointer is STILL v1.
      // -------------------------------------------------------------------------------------
      const cashierApi = apiClientFor(fixture.origin, rp.cashier.token, rp.device_uuid)
      const refunds = new RefundService({
        apiClient: cashierApi,
        localSale: repositories.localSale,
        localRefunds: repositories.localRefunds,
        access: new RefundAccessService({
          permissions: { hasPermission: () => true },
          commercialAccess: { assertAllowed: () => undefined }
        }),
        shiftAuthority: {
          captureContext: () => ({
            companyUuid: rp.company_uuid,
            deviceUuid: rp.device_uuid,
            userUuid: rp.cashier.user_uuid,
            sessionEpoch: 1
          }),
          assertOpenForSell: () => ({
            kind: 'open',
            shiftUuid: rp.shift_uuid,
            observedAt: new Date().toISOString()
          })
        } as never,
        catalog: {
          listPaymentMethods: () => [
            {
              uuid: rp.payment_method_uuid,
              name: 'Cash',
              code: 'cash',
              type: 'cash' as const,
              isActive: true,
              allowsChange: true,
              requiresReference: false,
              sortOrder: 0
            }
          ]
        },
        uploadRefund: (client, requestJson) => uploadRefund(client, requestJson),
        receiptContext: receiptContextCapture
      })

      const preview = await refunds.previewRefund({
        invoiceLocalUuid,
        lines: [{ invoiceItemRemoteUuid: rp.sale.invoice_item_uuid, quantityMilli: 1000 }],
        stockReturned: false
      })
      const outcome = await refunds.submitRefund({
        previewId: preview.previewId,
        invoiceLocalUuid,
        lines: [{ invoiceItemRemoteUuid: rp.sale.invoice_item_uuid, quantityMilli: 1000 }],
        stockReturned: false,
        paymentMethodUuid: null
      })
      equal(outcome.state, 'accepted')
      ok(outcome.remoteUuid !== null)

      const refundContextRow = receiptContext.findRefundContext(outcome.localRefundUuid)
      ok(refundContextRow !== null)
      equal(refundContextRow?.receiptProfileVersionUuid, v1VersionUuid)

      // -------------------------------------------------------------------------------------
      // 5. Offline branded receipt generation -- an intentionally UNREACHABLE api client proves
      //    the render path takes no network route; the branding still comes from the CAPTURED
      //    (v1) version, entirely from the local mirror.
      // -------------------------------------------------------------------------------------
      const offlineApi = unreachableApiClient(rp.device_uuid)
      await adminService_expectTransportFailure(() =>
        offlineApi.request({
          path: '/bootstrap',
          method: 'GET',
          requiresAuth: true,
          requiresDeviceUuid: true
        } as never)
      )

      const documents = new ReceiptDocumentService({
        localSale: repositories.localSale,
        localRefunds: repositories.localRefunds,
        receiptContext,
        bootstrapSnapshot: repositories.bootstrapSnapshot,
        receiptProfile: repositories.receiptProfile
      })
      const offlineDocument = documents.buildSaleDocument(invoiceLocalUuid, 'en', false)
      equal(offlineDocument.header.logo?.included, true)
      ok(offlineDocument.header.addressLines.includes('123 Main St'))
      equal(offlineDocument.header.taxIdentifierValue, 'RP-TAX-1')

      const asset = repositories.receiptProfile.getAsset(
        rp.company_uuid,
        offlineDocument.header.logo!.sha256
      )
      ok(asset?.content !== null)
      const logoDataUrl = `data:${asset!.mediaType};base64,${asset!.content!.toString('base64')}`
      const offlineHtml = buildReceiptHtml(
        offlineDocument,
        { printableWidthMm: 72 },
        { logoDataUrl }
      )
      ok(offlineHtml.includes('123 Main St'))
      ok(offlineHtml.includes('data:image/png;base64,'))
      persistArtifact('offline-sale-en', offlineDocument, offlineHtml)

      // The same real transaction, rendered in Arabic -- real production RTL/locale handling, not
      // a second synthetic fixture.
      const offlineDocumentAr = documents.buildSaleDocument(invoiceLocalUuid, 'ar', false)
      const offlineHtmlAr = buildReceiptHtml(
        offlineDocumentAr,
        { printableWidthMm: 72 },
        { logoDataUrl }
      )
      persistArtifact('offline-sale-ar', offlineDocumentAr, offlineHtmlAr)

      const refundDocument = documents.buildRefundDocument(outcome.localRefundUuid, 'en', false)
      const refundHtml = buildReceiptHtml(refundDocument, { printableWidthMm: 72 }, { logoDataUrl })
      persistArtifact('accepted-refund-en', refundDocument, refundHtml)

      // -------------------------------------------------------------------------------------
      // 6. Monotonic ingestion of a delayed/old and a null response -- fed directly into the
      //    real ReceiptProfileSyncService, using the REAL v1 wire shape this gate already
      //    captured, exactly the shape a late/overtaken bootstrap response would carry.
      // -------------------------------------------------------------------------------------
      receiptProfileSync.ingestFromBootstrap(rp.company_uuid, rp.admin.user_uuid, {
        can_manage: true,
        profile: {
          uuid: v1VersionUuid!,
          revision: 1,
          address_lines: [...v1Version!.addressLines],
          phone: v1Version!.phone,
          tax_identifier_label: v1Version!.taxIdentifierLabel,
          tax_identifier_value: v1Version!.taxIdentifierValue,
          footer_lines: [...v1Version!.footerLines],
          logo: null
        }
      })
      equal(
        repositories.receiptProfile.getCurrent(rp.company_uuid)?.versionUuid,
        v1VersionUuid,
        'a delayed/duplicate v1 response must not disturb the pointer'
      )

      receiptProfileSync.ingestFromBootstrap(rp.company_uuid, rp.admin.user_uuid, {
        can_manage: true,
        profile: null
      })
      equal(
        repositories.receiptProfile.getCurrent(rp.company_uuid)?.versionUuid,
        v1VersionUuid,
        'an explicit null profile must never erase an already-known version'
      )

      // -------------------------------------------------------------------------------------
      // 7. Revision conflict through the REAL API error parser -- publish with a stale
      //    expectedRevision against the real backend, and confirm the desktop's own
      //    apiErrorCodes/apiError.ts classification (fixed this session) correctly recognizes it.
      // -------------------------------------------------------------------------------------
      let refreshCount = 0
      const conflictService = adminServiceFor(adminApi, async () => {
        refreshCount += 1
        return bootstrapMirror(rp.company_uuid, rp.device_uuid, rp.admin.user_uuid, rp.admin.token)
      })
      let conflictObserved = false
      try {
        await conflictService.publish(adminOwner, {
          expectedRevision: 0, // stale -- the real current revision is already 1
          fields: {
            addressLines: ['Conflicting write'],
            phone: null,
            taxIdentifierLabel: null,
            taxIdentifierValue: null,
            footerLines: []
          },
          logo: { action: 'keep' }
        })
      } catch (error) {
        conflictObserved =
          isPublicAppError(error) &&
          error.category === 'conflict' &&
          error.backendCode === 'RECEIPT_PROFILE_REVISION_CONFLICT'
      }
      ok(
        conflictObserved,
        'the real 409 must classify as category=conflict, backendCode=RECEIPT_PROFILE_REVISION_CONFLICT'
      )
      equal(
        refreshCount,
        1,
        'a revision conflict must trigger exactly one best-effort mirror refresh'
      )

      // -------------------------------------------------------------------------------------
      // 8. Publish a NEWER profile (v2, different fields, no logo) and reprint the OLDER
      //    transaction -- its branding must still reflect v1, never v2.
      // -------------------------------------------------------------------------------------
      const v2 = await adminService.publish(adminOwner, {
        expectedRevision: 1,
        fields: {
          addressLines: ['456 New Address'],
          phone: null,
          taxIdentifierLabel: null,
          taxIdentifierValue: null,
          footerLines: []
        },
        logo: { action: 'remove' }
      })
      equal(v2.profile?.revision, 2)
      notEqual(repositories.receiptProfile.getCurrent(rp.company_uuid)?.versionUuid, v1VersionUuid)

      const reprintDocument = documents.buildSaleDocument(invoiceLocalUuid, 'en', true)
      deepEqual([...reprintDocument.header.addressLines], ['123 Main St', 'Cairo, Egypt'])
      equal(reprintDocument.header.taxIdentifierValue, 'RP-TAX-1')
      equal(
        reprintDocument.header.logo?.included,
        true,
        "the reprint keeps its own captured logo, not the newer profile's"
      )
      equal(reprintDocument.isReprint, true)
      const reprintAsset = repositories.receiptProfile.getAsset(
        rp.company_uuid,
        reprintDocument.header.logo!.sha256
      )
      const reprintHtml = buildReceiptHtml(
        reprintDocument,
        { printableWidthMm: 72 },
        {
          logoDataUrl: `data:${reprintAsset!.mediaType};base64,${reprintAsset!.content!.toString('base64')}`
        }
      )
      persistArtifact('reprint-after-v2-publish-en', reprintDocument, reprintHtml)

      // -------------------------------------------------------------------------------------
      // 9. Missing/foreign-company branding never blocks a valid sale, and the mirror never
      //    leaks across companies (tenant isolation / company switch).
      //
      //    A real device is bound to exactly one company (`BootstrapSnapshotRepository` refuses a
      //    second company's catalog on the same local mirror as corruption, by design), so a full
      //    `BootstrapService.refresh()` for the foreign company is not the right tool here. This
      //    fetches that company's real, live `receipt_profile` negotiated block directly (a real
      //    HTTP round trip, real envelope parsing) and feeds it through the exact same real
      //    `ReceiptProfileSyncService.ingestFromBootstrap()` bootstrap would call internally --
      //    proving the mirror itself (keyed per `company_uuid`) never leaks, independent of which
      //    single company's catalog this device currently has active.
      // -------------------------------------------------------------------------------------
      const foreignApi = apiClientFor(
        fixture.origin,
        rp.foreign_company.token,
        rp.foreign_company.device_uuid
      )
      const foreignBootstrapRaw = await foreignApi.request(DESKTOP_API_ROUTES.bootstrap)
      const foreignBootstrap = desktopBootstrapResourceSchema.parse(foreignBootstrapRaw)
      equal(foreignBootstrap.company.id, rp.foreign_company.company_uuid)
      receiptProfileSync.ingestFromBootstrap(
        foreignBootstrap.company.id,
        randomUUID(),
        foreignBootstrap.receipt_profile
      )
      equal(
        repositories.receiptProfile.getCurrent(rp.foreign_company.company_uuid)?.versionUuid,
        null,
        "a company that never published a profile must mirror no version, regardless of another company's activity"
      )
      // The RP company's own mirror is untouched by ingesting an unrelated company's block on the
      // same shared local database.
      notEqual(repositories.receiptProfile.getCurrent(rp.company_uuid)?.versionUuid, null)

      const foreignInvoiceLocalUuid = randomUUID()
      const foreignAttemptKey = randomUUID()
      database
        .prepare(
          `INSERT INTO sale_attempts (
             attempt_key, company_uuid, device_uuid, user_uuid, claim_session_epoch,
             origin_shift_uuid, origin_shift_observed_at, origin_branch_uuid, origin_warehouse_uuid,
             origin_context_fingerprint, intent_fingerprint, intent_version, intent_json, state,
             invoice_local_uuid, claimed_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          foreignAttemptKey,
          rp.foreign_company.company_uuid,
          rp.foreign_company.device_uuid,
          randomUUID(),
          1,
          randomUUID(),
          new Date().toISOString(),
          randomUUID(),
          randomUUID(),
          'b'.repeat(64),
          'b'.repeat(64),
          1,
          '{"v":1}',
          'claimed',
          null,
          new Date().toISOString(),
          new Date().toISOString()
        )
      repositories.localSale.insertInvoice({
        localUuid: foreignInvoiceLocalUuid,
        attemptKey: foreignAttemptKey,
        offlineNumber: `CP3G5FOREIGN-${foreignInvoiceLocalUuid.slice(0, 8)}`,
        companyUuid: rp.foreign_company.company_uuid,
        branchUuid: randomUUID(),
        warehouseUuid: randomUUID(),
        deviceUuid: rp.foreign_company.device_uuid,
        userUuid: randomUUID(),
        shiftUuid: randomUUID(),
        commitSessionEpoch: 1,
        catalogRevision: 'b'.repeat(64),
        intentFingerprint: 'b'.repeat(64),
        customerUuid: null,
        currency: 'USD',
        currencyExponent: 2,
        taxMode: 'none',
        invoiceDiscountType: null,
        invoiceDiscountValue: 0,
        subtotalAmount: 1000,
        discountTotalAmount: 0,
        taxTotalAmount: 0,
        grandTotalAmount: 1000,
        paidTotalAmount: 1000,
        changeDueAmount: 0,
        soldAt: new Date().toISOString(),
        connectivityStateAtSale: 'online',
        soldWhileOffline: false,
        notes: null,
        commercialSnapshotJson: '{}',
        createdAt: new Date().toISOString()
      })

      // No throw: a company with NO receipt profile at all must never block context capture.
      receiptContextCapture.captureForSale({
        invoiceLocalUuid: foreignInvoiceLocalUuid,
        companyUuid: rp.foreign_company.company_uuid,
        customerUuid: null
      })
      const foreignSaleContext = receiptContext.findInvoiceContext(foreignInvoiceLocalUuid)
      equal(foreignSaleContext?.receiptProfileVersionUuid, null)
    } finally {
      closeDatabase(database)
    }
  }
)

async function adminService_expectAuthorizationDenied(
  action: () => Promise<unknown>
): Promise<void> {
  try {
    await action()
  } catch (error) {
    ok(
      isPublicAppError(error) && error.category === 'authorization',
      `expected an authorization denial, got ${JSON.stringify(error)}`
    )
    return
  }
  throw new Error('expected an authorization denial, but the call succeeded')
}

async function adminService_expectTransportFailure(action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
  } catch (error) {
    ok(
      isPublicAppError(error) && error.category === 'transport',
      `expected a transport failure, got ${JSON.stringify(error)}`
    )
    return
  }
  throw new Error(
    'expected a transport failure against the unreachable origin, but the call succeeded'
  )
}
