import { onBeforeUnmount, onMounted } from 'vue'

/**
 * Function keys only: scanners send digits + Enter, so no bare digit, letter, or Enter binding may
 * ever live here (pos-ux-rules.md, Keyboard Shortcuts).
 *
 * `ShiftF9` is its own binding: Shift+F9 never triggers the plain `F9` binding (and does nothing
 * when `ShiftF9` is unbound). Shift still reaches the other keys' bindings. When the page mounts
 * `useScanInputRouter` with `onExactCash`, the router owns Shift+F9 in page mode (it stops the
 * event in the capture phase), so do not also bind `ShiftF9` here.
 */
export type PosShortcutKey = 'F3' | 'F4' | 'F6' | 'F7' | 'F8' | 'F9' | 'ShiftF9' | 'F10'

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

function bindingKeyOf(event: KeyboardEvent): string {
  return event.key === 'F9' && event.shiftKey ? 'ShiftF9' : event.key
}

export function usePosShortcuts(options: PosShortcutOptions): void {
  function onKeydown(event: KeyboardEvent): void {
    if (event.isComposing || document.querySelector('[aria-modal="true"]')) {
      return
    }

    // Function keys never produce text, so they stay live while the scan-entry field (or any
    // other input) has focus — that is where the cashier's hands already are.
    const binding = options.bindings?.[bindingKeyOf(event) as PosShortcutKey]
    if (binding && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault()
      // A held function key fires its action once, never on auto-repeat.
      if (!event.repeat) {
        binding()
      }
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
