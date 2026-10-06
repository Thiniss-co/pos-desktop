import { computed, ref, watch } from 'vue'
import { defineStore, type Pinia } from 'pinia'
import {
  POS_WORKSPACE_PRESETS,
  clonePreset,
  defaultWorkspaceLayout,
  posWorkspaceLayoutSchema,
  type PosWorkspaceLayout,
  type PosWorkspacePreset,
  type PosWorkspaceReadResult,
  type SetPosWorkspaceInput
} from '@shared/contracts/posWorkspace.contract'
import { useAuthStore } from '../auth/store'
import { PreferencesService } from './service'

export type WorkspaceLayoutGateway = {
  getPosWorkspace(): Promise<PosWorkspaceReadResult>
  setPosWorkspace(input: SetPosWorkspaceInput): Promise<PosWorkspaceReadResult>
}

/** Why the last Apply did not save: the session changed under it, the bridge is missing, or it failed. */
export type WorkspaceSaveError = 'conflict' | 'unavailable' | 'failed'

function copy(layout: PosWorkspaceLayout): PosWorkspaceLayout {
  return {
    ...layout,
    sections: { cart: [...layout.sections.cart], catalog: [...layout.sections.catalog] }
  }
}

function sameShape(a: PosWorkspaceLayout, b: PosWorkspaceLayout): boolean {
  return JSON.stringify({ ...a, preset: null }) === JSON.stringify({ ...b, preset: null })
}

/** Names the preset a layout matches exactly, else `custom`. */
export function labelPreset(layout: PosWorkspaceLayout): PosWorkspacePreset {
  for (const [name, preset] of Object.entries(POS_WORKSPACE_PRESETS)) {
    if (sameShape(layout, preset)) {
      return name as PosWorkspacePreset
    }
  }
  return 'custom'
}

function isPublicConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { category?: unknown }).category === 'conflict'
  )
}

/**
 * The POS workspace layout of the signed-in user on this workstation (presentation only).
 *
 * `saved` is what main stored (or the Cart-first default); `draft` exists only while the layout
 * editor is open and is what the workspace previews. Nothing is written until Apply. Every
 * identity change drops the draft, exits editing and invalidates in-flight responses (generation),
 * and main additionally refuses any write whose context token no longer matches the session.
 *
 * This store never reads or writes cart, payment, customer or held-sale state.
 */
export const useWorkspaceLayoutStore = defineStore('posWorkspace', () => {
  const saved = ref<PosWorkspaceLayout>(defaultWorkspaceLayout())
  const stored = ref(false)
  const draft = ref<PosWorkspaceLayout | null>(null)
  /** Apply sends `null` (delete the stored row) after Restore defaults. */
  const restorePending = ref(false)
  const contextToken = ref<string | null>(null)
  const loadState = ref<'idle' | 'loading' | 'ready' | 'unavailable'>('idle')
  const saving = ref(false)
  const saveError = ref<WorkspaceSaveError | null>(null)
  let generation = 0
  let gateway: WorkspaceLayoutGateway | null = null

  function resolveGateway(): WorkspaceLayoutGateway | null {
    if (gateway) {
      return gateway
    }
    if (typeof window === 'undefined' || !window.posApi?.preferences?.getPosWorkspace) {
      return null
    }
    gateway = new PreferencesService()
    return gateway
  }

  /** Test seam: inject a gateway instead of the preload bridge. */
  function useGateway(next: WorkspaceLayoutGateway | null): void {
    gateway = next
  }

  const editing = computed(() => draft.value !== null)
  /** What the workspace renders: the draft while editing, otherwise the saved layout. */
  const active = computed(() => draft.value ?? saved.value)
  const canPersist = computed(() => contextToken.value !== null)
  const dirty = computed(
    () =>
      draft.value !== null &&
      (restorePending.value
        ? stored.value || !sameShape(draft.value, saved.value)
        : JSON.stringify(draft.value) !== JSON.stringify(saved.value))
  )

  async function load(): Promise<void> {
    const service = resolveGateway()
    const request = ++generation

    if (!service) {
      loadState.value = 'unavailable'
      return
    }

    loadState.value = 'loading'
    try {
      const result = await service.getPosWorkspace()
      if (request !== generation) {
        return
      }
      saved.value = copy(result.layout)
      stored.value = result.stored
      contextToken.value = result.contextToken
      loadState.value = 'ready'
    } catch {
      if (request !== generation) {
        return
      }
      saved.value = defaultWorkspaceLayout()
      stored.value = false
      contextToken.value = null
      loadState.value = 'unavailable'
    }
  }

  /** A different (or no) user: forget everything presented for the previous one. */
  function resetForIdentityChange(): void {
    generation += 1
    saved.value = defaultWorkspaceLayout()
    stored.value = false
    draft.value = null
    restorePending.value = false
    contextToken.value = null
    saving.value = false
    saveError.value = null
    loadState.value = 'idle'
  }

  function beginEdit(): void {
    if (draft.value === null) {
      draft.value = copy(saved.value)
      restorePending.value = false
      saveError.value = null
    }
  }

  /** Replaces the draft with a validated layout; the preset label follows what it now matches. */
  function updateDraft(next: PosWorkspaceLayout): void {
    if (draft.value === null) {
      return
    }
    const labelled = { ...copy(next), preset: labelPreset(next) }
    if (!posWorkspaceLayoutSchema.safeParse(labelled).success) {
      return
    }
    draft.value = labelled
    restorePending.value = false
    saveError.value = null
  }

  function patchDraft(patch: Partial<Omit<PosWorkspaceLayout, 'version' | 'preset'>>): void {
    if (draft.value === null) {
      return
    }
    updateDraft({ ...draft.value, ...patch })
  }

  function choosePreset(preset: Exclude<PosWorkspacePreset, 'custom'>): void {
    if (draft.value === null) {
      return
    }
    draft.value = clonePreset(preset)
    restorePending.value = false
    saveError.value = null
  }

  function restoreDefaults(): void {
    if (draft.value === null) {
      return
    }
    draft.value = defaultWorkspaceLayout()
    restorePending.value = true
    saveError.value = null
  }

  function cancel(): void {
    draft.value = null
    restorePending.value = false
    saveError.value = null
  }

  /** Persists the draft once. Resolves `true` when saved; the draft stays open on failure. */
  async function apply(): Promise<boolean> {
    if (draft.value === null || saving.value) {
      return false
    }

    const service = resolveGateway()
    const token = contextToken.value

    if (!service || token === null) {
      saveError.value = 'unavailable'
      return false
    }

    const request = generation
    const layout = restorePending.value ? null : copy(draft.value)
    saving.value = true
    saveError.value = null

    try {
      const result = await service.setPosWorkspace({ layout, contextToken: token })
      if (request !== generation) {
        return false
      }
      saved.value = copy(result.layout)
      stored.value = result.stored
      contextToken.value = result.contextToken
      draft.value = null
      restorePending.value = false
      return true
    } catch (error) {
      if (request !== generation) {
        return false
      }
      saveError.value = isPublicConflict(error) ? 'conflict' : 'failed'
      if (saveError.value === 'conflict') {
        // The session context changed under the editor: re-read the current owner's layout.
        saving.value = false
        const keep = draft.value
        await load()
        draft.value = keep
      }
      return false
    } finally {
      if (request === generation) {
        saving.value = false
      }
    }
  }

  return {
    saved,
    stored,
    draft,
    restorePending,
    contextToken,
    loadState,
    saving,
    saveError,
    editing,
    active,
    canPersist,
    dirty,
    load,
    resetForIdentityChange,
    beginEdit,
    updateDraft,
    patchDraft,
    choosePreset,
    restoreDefaults,
    cancel,
    apply,
    useGateway
  }
})

/**
 * Reloads on every sign-in and resets on every sign-out or user change, before the first paint of
 * the new user's screen; the previous user's draft and layout are never shown to the next.
 */
export function startWorkspaceLayoutClient(pinia: Pinia): void {
  const store = useWorkspaceLayoutStore(pinia)
  const auth = useAuthStore(pinia)
  watch(
    () =>
      auth.session?.isAuthenticated
        ? `in:${auth.session.userEmail ?? ''}:${auth.session.userName ?? ''}`
        : 'out',
    (identity, previous) => {
      if (previous !== undefined) {
        store.resetForIdentityChange()
      }
      if (identity !== 'out') {
        void store.load()
      }
    },
    { immediate: true }
  )
}
