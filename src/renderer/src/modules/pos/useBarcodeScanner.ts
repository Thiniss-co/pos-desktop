import { onBeforeUnmount, onMounted } from 'vue'

export interface BarcodeScannerOptions {
  readonly onScan: (barcode: string) => void | Promise<void>
  readonly minimumLength?: number
  readonly maximumInterKeyMs?: number
  readonly completionDelayMs?: number
  readonly target?: Pick<
    Window,
    'addEventListener' | 'removeEventListener' | 'setTimeout' | 'clearTimeout'
  >
  readonly now?: () => number
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

function modalOwnsKeyboard(): boolean {
  return typeof document !== 'undefined' && document.querySelector('[aria-modal="true"]') !== null
}

export function createBarcodeScanner(options: BarcodeScannerOptions): {
  readonly handleKeydown: (event: KeyboardEvent) => void
  readonly dispose: () => void
} {
  const target = options.target ?? window
  const now = options.now ?? (() => performance.now())
  const minimumLength = options.minimumLength ?? 3
  const maximumInterKeyMs = options.maximumInterKeyMs ?? 35
  const completionDelayMs = options.completionDelayMs ?? 60
  let buffer = ''
  let lastKeyAt = 0
  let timeout: number | undefined
  let queue = Promise.resolve()

  function clearTimer(): void {
    if (timeout !== undefined) {
      target.clearTimeout(timeout)
      timeout = undefined
    }
  }

  function reset(): void {
    clearTimer()
    buffer = ''
    lastKeyAt = 0
  }

  function complete(): void {
    clearTimer()
    const barcode = buffer
    buffer = ''
    lastKeyAt = 0

    if (barcode.length < minimumLength) {
      return
    }

    queue = queue
      .then(() => options.onScan(barcode))
      .then(
        () => undefined,
        () => undefined
      )
  }

  function scheduleCompletion(): void {
    clearTimer()
    timeout = target.setTimeout(complete, completionDelayMs) as unknown as number
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (
      event.isComposing ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      isEditable(event.target) ||
      modalOwnsKeyboard()
    ) {
      reset()
      return
    }

    if (event.key === 'Enter') {
      if (buffer) {
        event.preventDefault()
        complete()
      }
      return
    }

    if (event.key.length !== 1) {
      reset()
      return
    }

    const current = now()

    if (buffer && current - lastKeyAt > maximumInterKeyMs) {
      buffer = ''
    }

    buffer += event.key
    lastKeyAt = current
    scheduleCompletion()
  }

  target.addEventListener('keydown', handleKeydown as EventListener)

  function dispose(): void {
    reset()
    target.removeEventListener('keydown', handleKeydown as EventListener)
  }

  return { handleKeydown, dispose }
}

export function useBarcodeScanner(options: BarcodeScannerOptions): void {
  let scanner: ReturnType<typeof createBarcodeScanner> | null = null

  onMounted(() => {
    scanner = createBarcodeScanner(options)
  })

  onBeforeUnmount(() => {
    scanner?.dispose()
    scanner = null
  })
}
