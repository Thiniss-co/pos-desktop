import { onBeforeUnmount, onMounted } from 'vue'

export interface PosShortcutOptions {
  readonly focusSearch: () => void
  readonly showHelp: () => void
}

function ownsTextInput(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

export function usePosShortcuts(options: PosShortcutOptions): void {
  function onKeydown(event: KeyboardEvent): void {
    if (
      event.isComposing ||
      ownsTextInput(event.target) ||
      document.querySelector('[aria-modal="true"]')
    ) {
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
