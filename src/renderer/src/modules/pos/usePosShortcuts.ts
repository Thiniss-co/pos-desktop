import { onBeforeUnmount, onMounted } from 'vue'

/**
 * Function keys only: scanners send digits + Enter, so no bare digit, letter, or Enter binding may
 * ever live here (pos-ux-rules.md, Keyboard Shortcuts).
 */
export type PosShortcutKey = 'F3' | 'F4' | 'F6' | 'F7' | 'F8' | 'F9'

export interface PosShortcutOptions {
  readonly focusSearch: () => void
  readonly showHelp: () => void
  readonly bindings?: Partial<Record<PosShortcutKey, () => void>>
}

function ownsTextInput(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

export function usePosShortcuts(options: PosShortcutOptions): void {
  function onKeydown(event: KeyboardEvent): void {
    if (event.isComposing || document.querySelector('[aria-modal="true"]')) {
      return
    }

    // Function keys never produce text, so they stay live while the scan-entry field (or any
    // other input) has focus — that is where the cashier's hands already are.
    const binding = options.bindings?.[event.key as PosShortcutKey]
    if (binding && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault()
      binding()
      return
    }

    if (ownsTextInput(event.target)) {
      return
    }

    if (event.key === 'F2') {
      event.preventDefault()
      options.focusSearch()
    } else if (event.key === 'F1') {
      event.preventDefault()
      options.showHelp()
    }
  }

  onMounted(() => window.addEventListener('keydown', onKeydown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
}
