// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  clonePreset,
  defaultWorkspaceLayout,
  type PosWorkspaceLayout,
  type PosWorkspaceReadResult,
  type SetPosWorkspaceInput
} from '@shared/contracts/posWorkspace.contract'
import {
  labelPreset,
  useWorkspaceLayoutStore,
  type WorkspaceLayoutGateway
} from './posWorkspace.store'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function result(
  layout: PosWorkspaceLayout,
  token = 'token-a',
  stored = true
): PosWorkspaceReadResult {
  return { layout, stored, contextToken: token }
}

describe('POS workspace store', () => {
  let gateway: WorkspaceLayoutGateway & {
    getPosWorkspace: ReturnType<typeof vi.fn>
    setPosWorkspace: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    gateway = {
      getPosWorkspace: vi.fn(async () => result(clonePreset('balanced'))),
      setPosWorkspace: vi.fn(async (input: SetPosWorkspaceInput) =>
        result(input.layout ?? defaultWorkspaceLayout(), 'token-a', input.layout !== null)
      )
    }
  })

  function store(): ReturnType<typeof useWorkspaceLayoutStore> {
    const s = useWorkspaceLayoutStore()
    s.useGateway(gateway)
    return s
  }

  it('starts on the Cart-first default and loads the saved layout', async () => {
    const s = store()
    expect(s.active).toEqual(defaultWorkspaceLayout())
    await s.load()
    expect(s.saved).toEqual(clonePreset('balanced'))
    expect(s.loadState).toBe('ready')
    expect(s.canPersist).toBe(true)
  })

  it('edits a detached draft; Cancel restores without any write', async () => {
    const s = store()
    await s.load()
    s.beginEdit()
    s.patchDraft({ cartSide: 'start', density: 'comfortable' })
    expect(s.active.cartSide).toBe('start')
    expect(s.active.preset).toBe('custom')
    expect(s.saved.cartSide).toBe('end')
    s.cancel()
    expect(s.editing).toBe(false)
    expect(s.active).toEqual(clonePreset('balanced'))
    expect(gateway.setPosWorkspace).not.toHaveBeenCalled()
  })

  it('Apply writes once with the context token and closes the editor', async () => {
    const s = store()
    await s.load()
    s.beginEdit()
    s.choosePreset('scanner')
    expect(await s.apply()).toBe(true)
    expect(gateway.setPosWorkspace).toHaveBeenCalledTimes(1)
    expect(gateway.setPosWorkspace).toHaveBeenCalledWith({
      layout: clonePreset('scanner'),
      contextToken: 'token-a'
    })
    expect(s.saved).toEqual(clonePreset('scanner'))
    expect(s.editing).toBe(false)
  })

  it('Restore defaults is a draft change: Cancel undoes it, Apply deletes the stored row', async () => {
    const s = store()
    await s.load()
    s.beginEdit()
    s.restoreDefaults()
    expect(s.active).toEqual(defaultWorkspaceLayout())
    s.cancel()
    expect(s.saved).toEqual(clonePreset('balanced'))
    expect(gateway.setPosWorkspace).not.toHaveBeenCalled()

    s.beginEdit()
    s.restoreDefaults()
    await s.apply()
    expect(gateway.setPosWorkspace).toHaveBeenCalledWith({ layout: null, contextToken: 'token-a' })
    expect(s.saved).toEqual(defaultWorkspaceLayout())
    expect(s.stored).toBe(false)
  })

  it('keeps the draft and reports a failed Apply; refuses a duplicate Apply while saving', async () => {
    const s = store()
    await s.load()
    const pending = deferred<PosWorkspaceReadResult>()
    gateway.setPosWorkspace.mockImplementationOnce(() => pending.promise)
    s.beginEdit()
    s.patchDraft({ density: 'comfortable' })
    const first = s.apply()
    expect(await s.apply()).toBe(false)
    pending.reject(new Error('disk full'))
    expect(await first).toBe(false)
    expect(s.saveError).toBe('failed')
    expect(s.editing).toBe(true)
    expect(s.saving).toBe(false)
    expect(s.saved).toEqual(clonePreset('balanced'))
  })

  it('a conflict (session changed) keeps the draft, re-reads, and never claims success', async () => {
    const s = store()
    await s.load()
    gateway.setPosWorkspace.mockRejectedValueOnce({ category: 'conflict', message: 'changed' })
    gateway.getPosWorkspace.mockResolvedValueOnce(result(clonePreset('cartFirst'), 'token-b'))
    s.beginEdit()
    s.patchDraft({ cartSide: 'start' })
    expect(await s.apply()).toBe(false)
    expect(s.saveError).toBe('conflict')
    expect(s.contextToken).toBe('token-b')
    expect(s.editing).toBe(true)
    expect(s.saving).toBe(false)
  })

  it('an identity change drops the draft and ignores the previous user’s late answers', async () => {
    const s = store()
    const slowLoad = deferred<PosWorkspaceReadResult>()
    gateway.getPosWorkspace.mockImplementationOnce(() => slowLoad.promise)
    const loading = s.load()
    s.resetForIdentityChange()
    slowLoad.resolve(result(clonePreset('scanner'), 'token-old'))
    await loading
    expect(s.saved).toEqual(defaultWorkspaceLayout())
    expect(s.contextToken).toBeNull()

    await s.load()
    const slowSave = deferred<PosWorkspaceReadResult>()
    gateway.setPosWorkspace.mockImplementationOnce(() => slowSave.promise)
    s.beginEdit()
    s.patchDraft({ density: 'comfortable' })
    const saving = s.apply()
    s.resetForIdentityChange()
    slowSave.resolve(result({ ...clonePreset('balanced'), density: 'comfortable' }))
    expect(await saving).toBe(false)
    expect(s.editing).toBe(false)
    expect(s.saving).toBe(false)
    expect(s.saved).toEqual(defaultWorkspaceLayout())
  })

  it('without the bridge it renders defaults and refuses to claim a save', async () => {
    const s = useWorkspaceLayoutStore()
    s.useGateway(null)
    await s.load()
    expect(s.loadState).toBe('unavailable')
    s.beginEdit()
    s.patchDraft({ cartSide: 'start' })
    expect(await s.apply()).toBe(false)
    expect(s.saveError).toBe('unavailable')
    expect(s.saved).toEqual(defaultWorkspaceLayout())
  })

  it('labels a layout by the preset it matches exactly', () => {
    expect(labelPreset({ ...clonePreset('balanced'), preset: 'custom' })).toBe('balanced')
    expect(labelPreset({ ...clonePreset('balanced'), cartShare: 50 })).toBe('custom')
  })
})
