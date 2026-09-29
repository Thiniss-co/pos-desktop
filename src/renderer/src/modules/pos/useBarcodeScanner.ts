import { onBeforeUnmount, onMounted } from 'vue'

/**
 * Keyboard-wedge barcode detection for the checkout page.
 *
 * `createBarcodeDetector` is the listener-free core (buffer, timing, ordered delivery queue) so
 * `scanInputRouter.ts` can reuse it as its page-mode path; `createBarcodeScanner` /
 * `useBarcodeScanner` keep their original API and simply attach the detector to `window`.
 *
 * A scan is a burst of printable keys, each within `maximumInterKeyMs` of the previous one,
 * completed by Enter, by a Tab suffix (only once the burst is at least `minimumLength` long, so a
 * stray key followed by Tab stays plain focus navigation), or `completionDelayMs` after the last
 * key (scanners configured without a suffix). Modifier-only keys (Shift, CapsLock, …) never break
 * a burst: an uppercase character arrives as a Shift keydown followed by the character itself.
 */
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
  /** Pauses detection while something else owns the keyboard. Default: any `[aria-modal="true"]`. */
  readonly ownsKeyboard?: () => boolean
}

/** What one keydown did to the detector (lets the router suppress a Space inside a scan). */
export type BarcodeKeyDisposition = 'ignored' | 'started' | 'continued' | 'completed'

export interface BarcodeDetector {
  readonly handleKeydown: (event: KeyboardEvent) => BarcodeKeyDisposition
  readonly reset: () => void
  readonly dispose: () => void
}

/**
 * Keys that only modify the next key. They must never reset a scan buffer — see the file comment.
 * Control/Alt/Meta are deliberately absent: their keydowns carry the modifier flag, and a Ctrl/Alt/
 * Meta combination is never scanner input.
 */
const MODIFIER_ONLY_KEYS: ReadonlySet<string> = new Set([
  'Shift',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'AltGraph',
  'Fn',
  'FnLock',
  'Hyper',
  'Super',
  'Symbol',
  'SymbolLock'
])

export function isModifierOnlyKey(key: string): boolean {
  return MODIFIER_ONLY_KEYS.has(key)
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export function modalOwnsKeyboard(): boolean {
  return typeof document !== 'undefined' && document.querySelector('[aria-modal="true"]') !== null
}

/** IME composition in progress (`keyCode` 229 covers engines that do not set `isComposing`). */
export function isComposingEvent(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229
}

/**
 * Ordered, serialized delivery: each value is handed over only after the previous handler (sync
 * or async) settled, and a rejected handler never blocks the ones after it.
 */
export function createSerialQueue<T>(
  deliver: (value: T) => void | Promise<void>
): (value: T) => void {
  let queue = Promise.resolve()

  return (value: T) => {
    queue = queue
      .then(() => deliver(value))
      .then(
        () => undefined,
        () => undefined
      )
  }
}

export function createBarcodeDetector(options: BarcodeScannerOptions): BarcodeDetector {
  const timers = options.target ?? window
  const now = options.now ?? (() => performance.now())
  const ownsKeyboard = options.ownsKeyboard ?? modalOwnsKeyboard
  const minimumLength = options.minimumLength ?? 3
  const maximumInterKeyMs = options.maximumInterKeyMs ?? 35
  const completionDelayMs = options.completionDelayMs ?? 60
  const enqueue = createSerialQueue(options.onScan)
  let buffer = ''
  let lastKeyAt = 0
  let timeout: number | undefined

  function clearTimer(): void {
    if (timeout !== undefined) {
      timers.clearTimeout(timeout)
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

    enqueue(barcode)
  }

  function scheduleCompletion(): void {
    clearTimer()
    timeout = timers.setTimeout(complete, completionDelayMs) as unknown as number
  }

  function handleKeydown(event: KeyboardEvent): BarcodeKeyDisposition {
    if (
      isComposingEvent(event) ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      isEditableTarget(event.target) ||
      ownsKeyboard()
    ) {
      reset()
      return 'ignored'
    }

    // A held key is a person, never a scanner; it neither extends nor breaks a burst.
    if (event.repeat || isModifierOnlyKey(event.key)) {
      return 'ignored'
    }

    if (event.key === 'Enter') {
      if (buffer) {
        event.preventDefault()
        complete()
        return 'completed'
      }
      return 'ignored'
    }

    if (event.key === 'Tab' && !event.shiftKey && buffer.length >= minimumLength) {
      event.preventDefault()
      complete()
      return 'completed'
    }

    if (event.key.length !== 1) {
      reset()
      return 'ignored'
    }

    const current = now()
    let disposition: BarcodeKeyDisposition = buffer ? 'continued' : 'started'

    if (buffer && current - lastKeyAt > maximumInterKeyMs) {
      buffer = ''
      disposition = 'started'
    }

    buffer += event.key
    lastKeyAt = current
    scheduleCompletion()
    return disposition
  }

  return { handleKeydown, reset, dispose: reset }
}

export function createBarcodeScanner(options: BarcodeScannerOptions): {
  readonly handleKeydown: (event: KeyboardEvent) => void
  readonly dispose: () => void
} {
  const target = options.target ?? window
  const detector = createBarcodeDetector(options)

  function handleKeydown(event: KeyboardEvent): void {
    detector.handleKeydown(event)
  }

  target.addEventListener('keydown', handleKeydown as EventListener)

  function dispose(): void {
    detector.dispose()
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
