import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PRINTER_SETTINGS, type PrinterSettings } from '@shared/contracts/printing.contract'
import type {
  AutoPrintAdmissionRow,
  AutoPrintIntentRow,
  AutoPrintOwner,
  AutoPrintRepository
} from '../repositories/autoPrint.repository'
import type { PrintJobRow } from '../repositories/receiptPrintJob.repository'
import {
  AUTO_PRINT_ADMISSION_WINDOW_MS,
  AutoPrintAdmissionService,
  AutoPrintIntentService,
  printerSnapshotOf
} from './autoPrint.service'
import type { ReceiptOwner } from './receiptAccess.service'

const OWNER: ReceiptOwner = {
  companyUuid: '11111111-1111-4111-8111-111111111111',
  deviceUuid: '22222222-2222-4222-8222-222222222222',
  userUuid: '33333333-3333-4333-8333-333333333333',
  sessionEpoch: 7
}
const SALE = '44444444-4444-4444-8444-444444444444'
const COMMITTED = '2026-10-04T12:00:00.000Z'
const CONFIGURED: PrinterSettings = { ...DEFAULT_PRINTER_SETTINGS, printerName: 'PW-Virtual-80' }

/** An in-memory stand-in with the same insert-once and atomic semantics as the SQLite tables. */
class MemoryRepository {
  intents = new Map<string, AutoPrintIntentRow>()
  admissions = new Map<string, AutoPrintAdmissionRow>()
  available = (): boolean => true
  insertIntent = (row: AutoPrintIntentRow): void => {
    if (this.intents.has(row.invoiceLocalUuid)) throw new Error('UNIQUE intent')
    this.intents.set(row.invoiceLocalUuid, row)
  }
  intent = (uuid: string): AutoPrintIntentRow | null => this.intents.get(uuid) ?? null
  admission = (uuid: string): AutoPrintAdmissionRow | null => this.admissions.get(uuid) ?? null
  pendingFor = (owner: AutoPrintOwner): AutoPrintIntentRow[] =>
    [...this.intents.values()].filter(
      (row) =>
        row.companyUuid === owner.companyUuid &&
        row.deviceUuid === owner.deviceUuid &&
        row.userUuid === owner.userUuid &&
        !this.admissions.has(row.invoiceLocalUuid)
    )
  insertAdmission = (row: AutoPrintAdmissionRow): void => {
    if (this.admissions.has(row.invoiceLocalUuid)) throw new Error('UNIQUE admission')
    this.admissions.set(row.invoiceLocalUuid, row)
  }
  immediate = <T>(work: () => T): T => {
    const admissions = new Map(this.admissions)
    const jobs = new Map(this.jobs)
    try {
      return work()
    } catch (error) {
      this.admissions = admissions
      this.jobs = jobs
      throw error
    }
  }
  jobs = new Map<string, PrintJobRow>()
}

function intent(overrides: Partial<AutoPrintIntentRow> = {}): AutoPrintIntentRow {
  const printer = printerSnapshotOf(CONFIGURED)
  return {
    invoiceLocalUuid: SALE,
    companyUuid: OWNER.companyUuid,
    deviceUuid: OWNER.deviceUuid,
    userUuid: OWNER.userUuid,
    committedAt: COMMITTED,
    locale: 'en',
    printerSnapshotJson: printer.json,
    printerSnapshotSha256: printer.sha256,
    setupStateAtCommit: 'configured',
    ...overrides
  }
}

function build(
  options: {
    settings?: PrinterSettings
    installed?: string[] | (() => Promise<string[]>)
    caller?: () => ReceiptOwner
    now?: Date
    held?: boolean
    afterJobInsert?: () => void
    claimReturnsNull?: boolean
  } = {}
): {
  service: AutoPrintAdmissionService
  repository: MemoryRepository
  printing: {
    listPrinters: ReturnType<typeof vi.fn>
    prepareAutoJob: ReturnType<typeof vi.fn>
    claimAutoJob: ReturnType<typeof vi.fn>
    runAdmittedAutoJob: ReturnType<typeof vi.fn>
  }
} {
  const repository = new MemoryRepository()
  const installed = options.installed ?? ['PW-Virtual-80', 'PW-Virtual-58']
  let jobCounter = 0
  const printing = {
    listPrinters: vi.fn(async () =>
      (typeof installed === 'function' ? await installed() : installed).map((name) => ({
        name,
        displayName: name
      }))
    ),
    prepareAutoJob: vi.fn(
      (_owner: ReceiptOwner, input: { invoiceLocalUuid: string; settings: PrinterSettings }) => ({
        document: { kind: 'sale', invoiceLocalUuid: input.invoiceLocalUuid },
        options: { silent: true, printerName: input.settings.printerName },
        job: { jobUuid: `job-${++jobCounter}`, documentLocalUuid: input.invoiceLocalUuid }
      })
    ),
    claimAutoJob: vi.fn((prepared: { job: { jobUuid: string } }) => {
      if (options.claimReturnsNull) return null
      const row = { jobUuid: prepared.job.jobUuid, status: 'queued' } as PrintJobRow
      repository.jobs.set(row.jobUuid, row)
      return row
    }),
    runAdmittedAutoJob: vi.fn(async () => ({}))
  }
  const service = new AutoPrintAdmissionService({
    repository: repository as unknown as AutoPrintRepository,
    access: {
      resolveCaller: options.caller ?? (() => OWNER),
      assertSaleDocument: (_owner, row) => row!
    },
    printing: printing as never,
    printerSettings: { get: () => options.settings ?? CONFIGURED },
    preferences: { current: () => ({ touchMode: false, autoPrint: true }) },
    localSale: {
      findInvoiceByLocalUuid: () => ({ offlineNumber: 'POS-1' }) as never
    },
    jobs: { findByJobUuid: (uuid) => repository.jobs.get(uuid) ?? null },
    now: () => options.now ?? new Date('2026-10-04T12:01:00.000Z'),
    admissionHeld: () => options.held ?? false,
    afterJobInsert: options.afterJobInsert
  })
  return { service, repository, printing }
}

describe('AutoPrintIntentService (inside the sale commit)', () => {
  function intentService(
    autoPrint: boolean,
    settings: PrinterSettings
  ): {
    service: AutoPrintIntentService
    repository: MemoryRepository
  } {
    const repository = new MemoryRepository()
    const service = new AutoPrintIntentService({
      repository: repository as unknown as AutoPrintRepository,
      preferences: { autoPrintFor: () => autoPrint },
      printerSettings: { get: () => settings },
      locale: () => 'ar'
    })
    return { service, repository }
  }

  const input = {
    invoiceLocalUuid: SALE,
    companyUuid: OWNER.companyUuid,
    deviceUuid: OWNER.deviceUuid,
    userUuid: OWNER.userUuid,
    committedAt: COMMITTED
  }

  it('freezes the owner, locale and printer snapshot when the user has automatic printing on', () => {
    const { service, repository } = intentService(true, CONFIGURED)
    service.captureForSale(input)

    const row = repository.intents.get(SALE)!
    expect(row.locale).toBe('ar')
    expect(row.setupStateAtCommit).toBe('configured')
    expect(JSON.parse(row.printerSnapshotJson)).toMatchObject({ printerName: 'PW-Virtual-80' })
    expect(row.printerSnapshotSha256).toBe(printerSnapshotOf(CONFIGURED).sha256)
  })

  it('writes no intent when the user turned automatic printing off', () => {
    const { service, repository } = intentService(false, CONFIGURED)
    service.captureForSale(input)
    expect(repository.intents.size).toBe(0)
  })

  it('records no_printer when no printer is configured', () => {
    const { service, repository } = intentService(true, DEFAULT_PRINTER_SETTINGS)
    service.captureForSale(input)
    expect(repository.intents.get(SALE)?.setupStateAtCommit).toBe('no_printer')
  })

  it('the snapshot ignores the manual dispatch mode and the retired workstation flag', () => {
    const base = printerSnapshotOf(CONFIGURED).sha256
    expect(
      printerSnapshotOf({ ...CONFIGURED, dispatchMode: 'system_dialog', autoPrintAfterSale: true })
        .sha256
    ).toBe(base)
    expect(printerSnapshotOf({ ...CONFIGURED, paperWidthMm: 58 }).sha256).not.toBe(base)
  })
})

describe('AutoPrintAdmissionService: the decision table', () => {
  it('admits: one job and one admitted row, created together, then run silently with the snapshot', async () => {
    const { service, repository, printing } = build()
    repository.intents.set(SALE, intent())

    const decisions = await service.admitPending('commit')

    expect(decisions).toEqual([{ invoiceLocalUuid: SALE, outcome: 'admitted', jobUuid: 'job-1' }])
    expect(repository.admissions.get(SALE)).toMatchObject({
      outcome: 'admitted',
      jobUuid: 'job-1',
      admittedSessionEpoch: 7
    })
    expect(printing.prepareAutoJob.mock.calls[0]?.[1]).toMatchObject({
      locale: 'en',
      settings: { printerName: 'PW-Virtual-80', dispatchMode: 'direct' }
    })
    expect(printing.runAdmittedAutoJob).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'no printer at commit → skipped_no_printer (even if one is configured now)',
      () => {
        const printer = printerSnapshotOf(DEFAULT_PRINTER_SETTINGS)
        return intent({
          setupStateAtCommit: 'no_printer',
          printerSnapshotJson: printer.json,
          printerSnapshotSha256: printer.sha256
        })
      },
      {},
      'skipped_no_printer'
    ],
    [
      'older than the 10-minute window → expired_unprinted',
      () => intent(),
      { now: new Date(Date.parse(COMMITTED) + AUTO_PRINT_ADMISSION_WINDOW_MS + 1000) },
      'expired_unprinted'
    ],
    [
      'settings changed since the sale → settings_changed',
      () => intent(),
      { settings: { ...CONFIGURED, paperWidthMm: 58 as const } },
      'settings_changed'
    ],
    [
      "the snapshot's printer is not installed → printer_missing (never another printer)",
      () => intent(),
      { installed: ['PW-Virtual-58'] },
      'printer_missing'
    ]
  ])('%s', async (_label, makeIntent, options, outcome) => {
    const { service, repository, printing } = build(options)
    repository.intents.set(SALE, makeIntent())

    const decisions = await service.admitPending('session')

    expect(decisions).toEqual([{ invoiceLocalUuid: SALE, outcome, jobUuid: null }])
    expect(repository.admissions.get(SALE)).toMatchObject({ outcome, jobUuid: null })
    expect(printing.claimAutoJob).not.toHaveBeenCalled()
    expect(printing.runAdmittedAutoJob).not.toHaveBeenCalled()
  })

  it('just inside the window is still admitted', async () => {
    const { service, repository } = build({
      now: new Date(Date.parse(COMMITTED) + AUTO_PRINT_ADMISSION_WINDOW_MS)
    })
    repository.intents.set(SALE, intent())
    expect((await service.admitPending('session'))[0]?.outcome).toBe('admitted')
  })

  it('another owner signed in: nothing is written and the intent stays pending (invisible to them)', async () => {
    const { service, repository, printing } = build({
      caller: () => ({ ...OWNER, userUuid: '55555555-5555-4555-8555-555555555555' })
    })
    repository.intents.set(SALE, intent())

    expect(await service.admitPending('session')).toEqual([])
    expect(repository.admissions.size).toBe(0)
    expect(printing.listPrinters).not.toHaveBeenCalled()
  })

  it('signed out or no pos.view: nothing is written', async () => {
    const { service, repository } = build({
      caller: () => {
        throw new Error('no pos.view')
      }
    })
    repository.intents.set(SALE, intent())
    expect(await service.admitPending('session')).toEqual([])
    expect(repository.admissions.size).toBe(0)
  })

  it('the owner changes between the printer check and the decision: nothing is written', async () => {
    let calls = 0
    const { service, repository } = build({
      caller: () =>
        ++calls === 1 ? OWNER : { ...OWNER, userUuid: '55555555-5555-4555-8555-555555555555' }
    })
    repository.intents.set(SALE, intent())
    expect(await service.admitPending('commit')).toEqual([])
    expect(repository.admissions.size).toBe(0)
  })

  it('an unavailable printer list decides nothing yet (no terminal outcome on a transient error)', async () => {
    const { service, repository } = build({
      installed: async () => {
        throw new Error('spooler unavailable')
      }
    })
    repository.intents.set(SALE, intent())
    expect(await service.admitPending('commit')).toEqual([])
    expect(repository.admissions.size).toBe(0)
  })

  it('a held admission (test-build fault injection) decides nothing', async () => {
    const { service, repository } = build({ held: true })
    repository.intents.set(SALE, intent())
    expect(await service.admitPending('commit')).toEqual([])
    expect(repository.admissions.size).toBe(0)
  })
})

describe('AutoPrintAdmissionService: atomicity and exactly-once', () => {
  it('a failure after the job insert rolls back both; a later admission succeeds exactly once', async () => {
    let fail = true
    const { service, repository, printing } = build({
      afterJobInsert: () => {
        if (fail) throw new Error('injected')
      }
    })
    repository.intents.set(SALE, intent())

    expect(await service.admitPending('commit')).toEqual([])
    expect(repository.admissions.size).toBe(0)
    expect(repository.jobs.size).toBe(0)
    expect(printing.runAdmittedAutoJob).not.toHaveBeenCalled()

    fail = false
    expect((await service.admitPending('session'))[0]?.outcome).toBe('admitted')
    expect(await service.admitPending('session')).toEqual([])
    expect(repository.jobs.size).toBe(1)
    expect(printing.runAdmittedAutoJob).toHaveBeenCalledTimes(1)
  })

  it('an AUTO job that already exists rolls the admission back (no admitted row without its job)', async () => {
    const { service, repository } = build({ claimReturnsNull: true })
    repository.intents.set(SALE, intent())
    expect(await service.admitPending('commit')).toEqual([])
    expect(repository.admissions.size).toBe(0)
  })

  it('a duplicate commit trigger and a sign-in trigger together decide the sale once', async () => {
    const { service, repository, printing } = build()
    repository.intents.set(SALE, intent())

    await Promise.all([
      service.admitPending('commit'),
      service.admitPending('commit'),
      service.admitPending('session')
    ])

    expect(repository.admissions.size).toBe(1)
    expect(printing.claimAutoJob).toHaveBeenCalledTimes(1)
    expect(printing.runAdmittedAutoJob).toHaveBeenCalledTimes(1)
  })

  it('a sale committed while a run is in progress is decided by the follow-up run', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const { service, repository } = build({
      installed: async () => {
        await gate
        return ['PW-Virtual-80']
      }
    })
    repository.intents.set(SALE, intent())
    const first = service.admitPending('session')
    const second = '66666666-6666-4666-8666-666666666666'
    repository.intents.set(second, intent({ invoiceLocalUuid: second }))
    void service.admitPending('commit')
    release()

    await first
    expect(repository.admissions.get(SALE)?.outcome).toBe('admitted')
    expect(repository.admissions.get(second)?.outcome).toBe('admitted')
  })
})

describe('AutoPrintAdmissionService: status, setup and recovery notices', () => {
  it('reports off, pending, the terminal outcome, or the admitted job', async () => {
    const { service, repository } = build({ installed: ['PW-Virtual-58'] })
    expect(service.statusForSale(OWNER, SALE)).toEqual({ state: 'off', job: null })
    repository.intents.set(SALE, intent())
    expect(service.statusForSale(OWNER, SALE)).toEqual({ state: 'pending', job: null })
    await service.admitPending('commit')
    expect(service.statusForSale(OWNER, SALE)).toEqual({ state: 'printer_missing', job: null })
  })

  it("another user's intent reads as off", () => {
    const { service, repository } = build()
    repository.intents.set(SALE, intent())
    expect(
      service.statusForSale({ ...OWNER, userUuid: '55555555-5555-4555-8555-555555555555' }, SALE)
    ).toEqual({ state: 'off', job: null })
  })

  it('recovery decisions become notices for that owner and session; commit decisions do not', async () => {
    const { service, repository } = build({ settings: { ...CONFIGURED, paperWidthMm: 58 } })
    repository.intents.set(SALE, intent())
    await service.admitPending('commit')
    expect(service.noticesFor(OWNER)).toEqual([])

    const later = '77777777-7777-4777-8777-777777777777'
    repository.intents.set(later, intent({ invoiceLocalUuid: later }))
    await service.admitPending('session')
    expect(service.noticesFor(OWNER)).toMatchObject([
      { invoiceLocalUuid: later, receiptNumber: 'POS-1', outcome: 'settings_changed' }
    ])
    expect(service.noticesFor({ ...OWNER, sessionEpoch: 8 })).toEqual([])
    service.dismissNotices(OWNER)
    expect(service.noticesFor(OWNER)).toEqual([])
  })

  it('setup: no printer, a missing printer, ready, or off', async () => {
    expect((await build({ settings: DEFAULT_PRINTER_SETTINGS }).service.setup()).needsSetup).toBe(
      'no_printer'
    )
    expect((await build({ installed: ['Other'] }).service.setup()).needsSetup).toBe(
      'printer_missing'
    )
    expect((await build().service.setup()).needsSetup).toBe('none')
  })
})

describe('AutoPrintAdmissionService: printer discovery only when needed', () => {
  it('a register without a printer at commit never lists printers (no hidden window is created)', async () => {
    const { service, repository, printing } = build()
    const printer = printerSnapshotOf(DEFAULT_PRINTER_SETTINGS)
    repository.intents.set(
      SALE,
      intent({
        setupStateAtCommit: 'no_printer',
        printerSnapshotJson: printer.json,
        printerSnapshotSha256: printer.sha256
      })
    )
    expect((await service.admitPending('commit'))[0]?.outcome).toBe('skipped_no_printer')
    expect(printing.listPrinters).not.toHaveBeenCalled()
  })
})
