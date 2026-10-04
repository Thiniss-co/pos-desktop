import { describe, expect, it } from 'vitest'
import { CatalogInstallGate, InstallDeferredError } from './catalogInstallGate.service'
import type { DraftState, InstallPath } from '@shared/contracts/catalogInstall.contract'

const IDLE: DraftState = {
  generation: 1,
  hasLines: false,
  hasHeldDrafts: false,
  paymentActive: false,
  completionPending: false
}

function setup(
  options: {
    windows?: number[]
    gatingClaim?: boolean
    inFlight?: boolean
    needsInstall?: boolean
    autoReply?: (
      holdId: string,
      path: InstallPath,
      consent: number | null
    ) => {
      admitted: boolean
      generation: number
    } | null
  } = {}
): {
  gate: CatalogInstallGate
  sent: Array<{ id: number; channel: string; payload: Record<string, unknown> }>
  flags: { gatingClaim: boolean; inFlight: boolean; needsInstall: boolean }
  advance: (ms: number) => void
} {
  let mono = 1000
  const sent: Array<{ id: number; channel: string; payload: Record<string, unknown> }> = []
  const flags = {
    gatingClaim: options.gatingClaim ?? false,
    inFlight: options.inFlight ?? false,
    needsInstall: options.needsInstall ?? false
  }
  let ids = 0
  const gate: CatalogInstallGate = new CatalogInstallGate({
    appWindowIds: () => options.windows ?? [7],
    send: (id, channel, payload) => {
      sent.push({ id, channel, payload: payload as Record<string, unknown> })
      if (channel === 'hold' && options.autoReply) {
        const p = payload as { holdId: string; path: InstallPath; consentGeneration: number | null }
        const reply = options.autoReply(p.holdId, p.path, p.consentGeneration)
        if (reply) {
          queueMicrotask(() => gate.reply(id, { holdId: p.holdId, ...reply }))
        }
      }
    },
    hasGatingClaim: () => flags.gatingClaim,
    completionInFlight: () => flags.inFlight,
    catalogNeedsInstall: () => flags.needsInstall,
    monotonicNow: () => mono,
    createId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    replyTimeoutMs: 20,
    holdDeadlineMs: 2500
  })
  return {
    gate,
    sent,
    flags,
    advance: (ms: number) => {
      mono += ms
    }
  }
}

const admitAll = (): { admitted: boolean; generation: number } => ({
  admitted: true,
  generation: 1
})

describe('CatalogInstallGate — Rev 4 §8', () => {
  it('background: idle draft → held → installing → installed, release pushed', async () => {
    const w = setup({ autoReply: admitAll })
    w.gate.reportDraftState(7, IDLE)

    await w.gate.acquire()
    expect(w.gate.isHoldActive()).toBe(true)
    w.gate.beforeWrite()
    const holdId = (w.sent[0].payload as { holdId: string }).holdId
    expect(w.gate.status(holdId)).toBe('installing')
    w.gate.settle(true)

    expect(w.gate.status(holdId)).toBe('installed')
    expect(w.gate.isHoldActive()).toBe(false)
    expect(w.sent.map((m) => m.channel)).toEqual(['hold', 'release'])
    expect(w.sent[1].payload).toEqual({ holdId, installed: true })
  })

  it('background: a draft with lines is refused before any handshake', async () => {
    const w = setup({ autoReply: admitAll })
    w.gate.reportDraftState(7, { ...IDLE, hasLines: true })
    expect(w.gate.canStartBackgroundInstall()).toBe(false)
    await expect(w.gate.acquire()).rejects.toMatchObject({ reason: 'busy' })
    expect(w.sent).toHaveLength(0)
  })

  it('an item added after the reply (generation moved) aborts inside the transaction', async () => {
    const w = setup({ autoReply: admitAll })
    w.gate.reportDraftState(7, IDLE)
    await w.gate.acquire()
    w.gate.reportDraftState(7, { ...IDLE, generation: 2, hasLines: true })

    expect(() => w.gate.beforeWrite()).toThrow(InstallDeferredError)
  })

  it('a hold past its deadline never starts installing', async () => {
    const w = setup({ autoReply: admitAll })
    w.gate.reportDraftState(7, IDLE)
    await w.gate.acquire()
    w.advance(2501)
    expect(() => w.gate.beforeWrite()).toThrow(/expired/)
  })

  it('a missing reply aborts background but not the stale override', async () => {
    const background = setup({ autoReply: () => null })
    background.gate.reportDraftState(7, IDLE)
    await expect(background.gate.acquire()).rejects.toMatchObject({ reason: 'busy' })

    const stale = setup({ autoReply: () => null, needsInstall: true })
    await stale.gate.acquire()
    expect(() => stale.gate.beforeWrite()).not.toThrow()
  })

  it('manual: consent bound to a generation — a changed draft is not admitted', async () => {
    const w = setup({
      autoReply: (_id, _path, consent) => ({ admitted: consent === 5, generation: 6 })
    })
    w.gate.reportDraftState(7, { ...IDLE, generation: 6, hasLines: true })
    await expect(w.gate.withPath('manual', 4, () => w.gate.acquire())).rejects.toMatchObject({
      reason: 'draft-changed'
    })
  })

  it('manual with consent: installs with lines, the review follows', async () => {
    const w = setup({ autoReply: () => ({ admitted: true, generation: 5 }) })
    w.gate.reportDraftState(7, { ...IDLE, generation: 5, hasLines: true })
    await w.gate.withPath('manual', 5, async () => {
      await w.gate.acquire()
      w.gate.beforeWrite()
      w.gate.settle(true)
    })
    expect(w.sent.at(-1)?.payload).toMatchObject({ installed: true })
  })

  it('a claimed payment the install would supersede refuses every non-stale path', async () => {
    const w = setup({ autoReply: admitAll, gatingClaim: true })
    w.gate.reportDraftState(7, IDLE)
    await expect(w.gate.acquire()).rejects.toMatchObject({ reason: 'payment-active' })
    await expect(w.gate.withPath('manual', 1, () => w.gate.acquire())).rejects.toMatchObject({
      reason: 'payment-active'
    })
    expect(w.gate.paymentActive()).toBe(true)
  })

  it('a payment claimed between the handshake and the write aborts inside the transaction', async () => {
    const w = setup({ autoReply: admitAll })
    w.gate.reportDraftState(7, IDLE)
    await w.gate.acquire()
    w.flags.gatingClaim = true
    expect(() => w.gate.beforeWrite()).toThrow(/payment-active/)
  })

  it('a window that never reported (reload) counts as busy', async () => {
    const w = setup({ autoReply: admitAll, windows: [7, 8] })
    w.gate.reportDraftState(7, IDLE)
    await expect(w.gate.acquire()).rejects.toMatchObject({ reason: 'busy' })
    w.gate.reportDraftState(8, IDLE)
    w.gate.forgetWindow(8)
    await expect(w.gate.acquire()).rejects.toMatchObject({ reason: 'busy' })
  })

  it('a persist with no hold is refused unless nothing can be sold anyway', () => {
    const valid = setup()
    expect(() => valid.gate.beforeWrite()).toThrow(InstallDeferredError)
    const stale = setup({ needsInstall: true })
    expect(() => stale.gate.beforeWrite()).not.toThrow()
  })

  it('status answers the poll after a lost release; unknown holds read as unknown', async () => {
    const w = setup({ autoReply: admitAll })
    w.gate.reportDraftState(7, IDLE)
    await w.gate.acquire()
    const holdId = (w.sent[0].payload as { holdId: string }).holdId
    expect(w.gate.status(holdId)).toBe('held')
    w.gate.beforeWrite()
    w.gate.settle(true)
    expect(w.gate.status(holdId)).toBe('installed')
    expect(w.gate.status('00000000-0000-4000-8000-999999999999')).toBe('unknown')
  })
})
