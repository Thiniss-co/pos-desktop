/**
 * Scanner and payment keyboard model — the POS page's ONE window-level, capture-phase
 * keydown/keyup router. Full write-up: docs/architecture/pos-ux-architecture.md, "Scanner and
 * payment keyboard model".
 *
 * SUPPORTED SCANNERS
 * - HID keyboard-wedge scanners only: the scanner "types" its payload as ordinary key events.
 * - Payload: printable characters (a Space inside the payload is supported).
 * - Suffix: Enter (incl. NumpadEnter), Tab, or none.
 * - NOT supported: a prefix, function keys, or Ctrl/Alt/Meta combinations in the scanner program.
 * - The scanner must emit a Latin keyboard layout; letters typed through a non-Latin OS layout
 *   arrive as that layout's characters.
 *
 * MODES (`options.mode()` is read on every event; a mode change discards any partial input)
 * - `page`            checkout page: today's timing-based barcode detector (`useBarcodeScanner`),
 *                     delivered through an ordered, serialized queue to `onScan`.
 * - `payment-tender`  payment dialog, tender step.
 * - `payment-done`    payment dialog, committed sale awaiting "New sale" (no editable fields).
 * - `payment-other`   payment dialog, blocked / completing / confirming.
 * - `inactive`        hands off entirely (e.g. another dialog is stacked on the payment dialog).
 * - `layout-edit`     POS workspace layout editing: the page detector still runs, so a scanner
 *                     burst is captured whatever control has focus (its Space, Enter and Tab never
 *                     reach that control) and is delivered to `onScan`, which refuses it. A stray
 *                     Enter/Space/Tab arriving within `layoutTerminatorGraceMs` of a burst is
 *                     consumed too. F9 and Shift+F9 are consumed and do nothing (no checkout while
 *                     editing). A standalone Enter or Space keeps its native activation, so the
 *                     edit controls stay fully operable from the keyboard.
 *
 * GUARANTEES (deterministic — none of them depends on timing)
 * 1. Commit-class suppression, every payment mode: a key event whose target is inside
 *    `[data-commit-action]` never activates it from the keyboard. keydown Enter/NumpadEnter/Space
 *    and keyup Space are preventDefault()+stopPropagation()'d, which removes the key-synthesized
 *    click (Enter activates on keydown, Space on keyup). Pointer, touch and assistive-technology
 *    clicks are untouched. The keyboard path to those actions is F9 / Shift+F9 / Ctrl+P.
 * 2. `e.repeat` never starts, extends, terminates or triggers anything. IME composition
 *    (`isComposing` / keyCode 229) is never touched.
 * 3. Tender step, focus NOT in an editable field: printable keys are swallowed (nothing typed,
 *    nothing activated). An Enter/Tab that follows at least one swallowed key is consumed as the
 *    scanner's terminator and reported through `onScannerIgnored`. A leading Space, or Enter, on a
 *    non-commit control keeps its native behaviour.
 * 4. Done step: a printable non-space key starts an explicit collection (captured before it reaches
 *    any focused control); further keys, Space included, are appended; Enter/Tab ends it — a code of
 *    at least `minimumLength` goes to `onDoneCode` (ordered, serialized), a shorter one is dropped
 *    with `onScannerIgnored`. Esc discards a partial (a second Esc reaches `onEscape`); F9 / Ctrl+P
 *    discard a partial with `onScannerIgnored`, then act. Tab/Shift+Tab are never consumed when not
 *    collecting.
 *
 * BEST-EFFORT ONLY (timing-based; payment safety never depends on these)
 * - Tender step, focus IN an editable field: typing is native. A burst of `fieldBurstMinLength`
 *   (6) characters, every gap ≤ `fieldBurstMaxGapMs` (30 ms), ending in Enter is treated as a scan
 *   that landed in the field: that Enter is consumed and the field is restored to its value from
 *   before the burst (value set + `input` event), then `onFieldBurstReverted` runs. Limits: a slow
 *   scanner (gaps > 30 ms) or a code shorter than 6 is NOT caught; a very fast typist can be
 *   reverted (the notice explains it). A Tab suffix is never reverted — it does not commit.
 * - Done step, suffix-less scanners: a collection that sees no key for `doneIdleCompleteMs`
 *   (150 ms; `null` disables) is ended exactly as Enter would end it.
 * - Page mode keeps the detector's timing heuristics (35 ms gaps, 60 ms completion).
 *
 * KEY MAP
 *   key         page                 payment-tender           payment-done               payment-other   layout-edit
 *   F9          (usePosShortcuts)    onPrimary                discard partial→onPrimary  onPrimary       consumed, nothing
 *   Shift+F9    onExactCash          onExactCash              —                          —               consumed, nothing
 *   Ctrl+P      native               native                   discard partial→onPrint    native
 *   Esc         native               native                   partial? discard : onEscape native
 */
import { onBeforeUnmount, onMounted, readonly, ref, type Ref } from 'vue'
import {
  createBarcodeDetector,
  createSerialQueue,
  isComposingEvent,
  isEditableTarget,
  isModifierOnlyKey,
  modalOwnsKeyboard
} from './useBarcodeScanner'

export type ScanInputMode =
  'page' | 'payment-tender' | 'payment-done' | 'payment-other' | 'inactive' | 'layout-edit'

type RouterTarget = Pick<
  Window,
  'addEventListener' | 'removeEventListener' | 'setTimeout' | 'clearTimeout'
>

export interface ScanInputRouterOptions {
  /** Read on every key event. */
  readonly mode: () => ScanInputMode
  /** Page-mode scan, delivered in order through a serialized queue (like `useBarcodeScanner`). */
  readonly onScan: (code: string) => void | Promise<void>
  /** Payment-done collection result, delivered in order through its own serialized queue. */
  readonly onDoneCode?: (code: string) => void | Promise<void>
  /** F9 in every payment mode. */
  readonly onPrimary?: () => void
  /** Shift+F9 in `payment-tender`, and in `page` when provided. */
  readonly onExactCash?: () => void
  /** Ctrl+P in `payment-done`. */
  readonly onPrint?: () => void
  /** Esc in `payment-done` while not collecting. When omitted, Esc stays native there. */
  readonly onEscape?: () => void
  /** Scanner-shaped input was swallowed or dropped (show "Scanner input ignored while paying"). */
  readonly onScannerIgnored?: () => void
  /** Payment-done collection started / ended (show "Scanning… (Esc to cancel)"). */
  readonly onCollectingChange?: (collecting: boolean) => void
  /** A burst typed into a tender field was reverted (best-effort fallback). */
  readonly onFieldBurstReverted?: () => void
  /** Shortest code delivered (page and done). Default 3. */
  readonly minimumLength?: number
  /** Page detector: longest gap inside one scan. Default 35 ms. */
  readonly maximumInterKeyMs?: number
  /** Page detector: completion delay for suffix-less scans. Default 60 ms. */
  readonly completionDelayMs?: number
  /** Tender field fallback: shortest burst reverted. Default 6. */
  readonly fieldBurstMinLength?: number
  /** Tender field fallback: longest gap inside a burst. Default 30 ms. */
  readonly fieldBurstMaxGapMs?: number
  /** Done collection idle completion for suffix-less scanners. Default 150 ms; `null` disables. */
  readonly doneIdleCompleteMs?: number | null
  /** Layout edit: how long after a burst a stray Enter/Space/Tab is still consumed. Default 300 ms. */
  readonly layoutTerminatorGraceMs?: number
  /** Page mode pauses while this is true. Default: any `[aria-modal="true"]` is present. */
  readonly ownsKeyboard?: () => boolean
  readonly target?: RouterTarget
  readonly now?: () => number
}

export interface ScanInputRouter {
  readonly handleKeydown: (event: KeyboardEvent) => void
  readonly handleKeyup: (event: KeyboardEvent) => void
  readonly isCollecting: () => boolean
  /** Discards every partial buffer (collection end is reported through `onCollectingChange`). */
  readonly reset: () => void
  /** Removes both listeners and drops partial state without invoking callbacks. */
  readonly dispose: () => void
}

interface FieldBurst {
  readonly target: HTMLElement
  readonly snapshot: string
  count: number
  lastAt: number
}

const CAPTURE: AddEventListenerOptions = { capture: true }

function isSpace(event: KeyboardEvent): boolean {
  return event.key === ' ' || event.code === 'Space'
}

function isEnter(event: KeyboardEvent): boolean {
  return event.key === 'Enter'
}

function isTab(event: KeyboardEvent): boolean {
  return event.key === 'Tab'
}

function hasCommandModifier(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.altKey || event.metaKey
}

function isPrintable(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !hasCommandModifier(event)
}

function isF9(event: KeyboardEvent): boolean {
  return event.key === 'F9' && !hasCommandModifier(event)
}

function isPrintShortcut(event: KeyboardEvent): boolean {
  return (
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey &&
    (event.key === 'p' || event.key === 'P' || event.code === 'KeyP')
  )
}

function isCommitTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-commit-action]') !== null
}

function consume(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopPropagation()
}

function readFieldValue(field: HTMLElement): string {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    return field.value
  }
  return field.textContent ?? ''
}

function restoreFieldValue(field: HTMLElement, value: string): void {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    field.value = value
  } else {
    field.textContent = value
  }
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

export function createScanInputRouter(options: ScanInputRouterOptions): ScanInputRouter {
  const target = options.target ?? window
  const now = options.now ?? (() => performance.now())
  const ownsKeyboard = options.ownsKeyboard ?? modalOwnsKeyboard
  const minimumLength = options.minimumLength ?? 3
  const fieldBurstMinLength = options.fieldBurstMinLength ?? 6
  const fieldBurstMaxGapMs = options.fieldBurstMaxGapMs ?? 30
  const doneIdleCompleteMs =
    options.doneIdleCompleteMs === undefined ? 150 : options.doneIdleCompleteMs
  const layoutTerminatorGraceMs = options.layoutTerminatorGraceMs ?? 300

  const detector = createBarcodeDetector({
    onScan: options.onScan,
    minimumLength,
    maximumInterKeyMs: options.maximumInterKeyMs,
    completionDelayMs: options.completionDelayMs,
    target,
    now,
    ownsKeyboard
  })
  const deliverDoneCode = createSerialQueue<string>((code) => options.onDoneCode?.(code))

  let lastMode: ScanInputMode | null = null
  /** Tender step: printable keys swallowed since the last terminator. */
  let swallowed = ''
  /** Done step: the explicit collection; collecting ⇔ non-empty. */
  let collected = ''
  let idleTimer: number | undefined
  let fieldBurst: FieldBurst | null = null
  /** A Space keydown was consumed, so its keyup must be too (Space activates on keyup). */
  let suppressSpaceKeyup = false
  /** Layout edit: when the last scanner burst ended on a terminator. */
  let lastLayoutBurstAt: number | null = null

  function clearIdleTimer(): void {
    if (idleTimer !== undefined) {
      target.clearTimeout(idleTimer)
      idleTimer = undefined
    }
  }

  function completeIdleCollection(): void {
    idleTimer = undefined
    if (options.mode() === 'payment-done') {
      finishCollection()
    } else {
      // The dialog moved on (e.g. "New sale" by pointer) mid-collection: never deliver late.
      endCollection()
    }
  }

  function scheduleIdleCompletion(): void {
    clearIdleTimer()
    if (doneIdleCompleteMs !== null) {
      idleTimer = target.setTimeout(completeIdleCollection, doneIdleCompleteMs) as unknown as number
    }
  }

  function endCollection(): void {
    clearIdleTimer()
    if (collected) {
      collected = ''
      options.onCollectingChange?.(false)
    }
  }

  function startCollection(character: string): void {
    collected = character
    options.onCollectingChange?.(true)
    scheduleIdleCompletion()
  }

  function appendToCollection(character: string): void {
    collected += character
    scheduleIdleCompletion()
  }

  function finishCollection(): void {
    const code = collected
    endCollection()
    if (!code) {
      return
    }
    if (code.length >= minimumLength) {
      deliverDoneCode(code)
    } else {
      options.onScannerIgnored?.()
    }
  }

  function discardCollection(notify: boolean): void {
    if (!collected) {
      return
    }
    endCollection()
    if (notify) {
      options.onScannerIgnored?.()
    }
  }

  function reset(): void {
    swallowed = ''
    fieldBurst = null
    detector.reset()
    endCollection()
  }

  function syncMode(mode: ScanInputMode): void {
    if (mode !== lastMode) {
      reset()
      lastMode = mode
    }
  }

  function consumeSpaceAware(event: KeyboardEvent): void {
    consume(event)
    if (isSpace(event)) {
      suppressSpaceKeyup = true
    }
  }

  /** Rule 2: keydown Enter/Space on a commit-class control never activates it. */
  function suppressCommitActivation(event: KeyboardEvent): void {
    if ((isEnter(event) || isSpace(event)) && isCommitTarget(event.target)) {
      consumeSpaceAware(event)
    }
  }

  function handlePage(event: KeyboardEvent): void {
    if (ownsKeyboard()) {
      detector.reset()
      return
    }

    if (isF9(event) && event.shiftKey) {
      detector.reset()
      if (options.onExactCash) {
        consume(event)
        if (!event.repeat) {
          options.onExactCash()
        }
      }
      return
    }

    const disposition = detector.handleKeydown(event)
    if (disposition === 'completed') {
      event.stopPropagation()
    } else if (disposition === 'continued' && isSpace(event)) {
      // A Space inside a scan must not reach (and later activate) the focused control.
      consumeSpaceAware(event)
    }
  }

  /** Layout editing: capture scanner bursts and stray terminators; never pay. */
  function handleLayoutEdit(event: KeyboardEvent): void {
    if (ownsKeyboard()) {
      detector.reset()
      return
    }

    if (isF9(event)) {
      detector.reset()
      consume(event)
      return
    }

    const disposition = detector.handleKeydown(event)
    if (disposition === 'completed') {
      event.stopPropagation()
      lastLayoutBurstAt = now()
      return
    }
    if (disposition === 'continued' && isSpace(event)) {
      consumeSpaceAware(event)
      return
    }
    const terminator = isEnter(event) || isSpace(event) || event.key === 'Tab'
    if (
      terminator &&
      lastLayoutBurstAt !== null &&
      now() - lastLayoutBurstAt <= layoutTerminatorGraceMs
    ) {
      consumeSpaceAware(event)
    }
  }

  function handleF9(event: KeyboardEvent, mode: ScanInputMode): void {
    if (event.shiftKey) {
      if (mode === 'payment-tender') {
        consume(event)
        if (!event.repeat) {
          swallowed = ''
          fieldBurst = null
          options.onExactCash?.()
        }
      } else if (mode === 'payment-done' && collected) {
        consume(event)
      }
      return
    }

    consume(event)
    if (event.repeat) {
      return
    }
    swallowed = ''
    fieldBurst = null
    discardCollection(true)
    options.onPrimary?.()
  }

  function handleEscape(event: KeyboardEvent, mode: ScanInputMode): void {
    if (mode === 'payment-done') {
      if (collected) {
        consume(event)
        if (!event.repeat) {
          discardCollection(false)
        }
        return
      }
      if (options.onEscape) {
        consume(event)
        if (!event.repeat) {
          options.onEscape()
        }
      }
      return
    }

    // Tender / other: Escape stays native (the draft field cancels, AppDialog closes).
    swallowed = ''
    fieldBurst = null
  }

  function handleTenderField(event: KeyboardEvent, field: HTMLElement): void {
    if (event.repeat) {
      return
    }

    if (isPrintable(event)) {
      const current = now()
      if (
        fieldBurst &&
        fieldBurst.target === field &&
        current - fieldBurst.lastAt <= fieldBurstMaxGapMs
      ) {
        fieldBurst.count += 1
        fieldBurst.lastAt = current
      } else {
        // keydown runs before the character is inserted, so this is the pre-burst value.
        fieldBurst = { target: field, snapshot: readFieldValue(field), count: 1, lastAt: current }
      }
      return
    }

    const burst = fieldBurst
    fieldBurst = null
    if (
      isEnter(event) &&
      burst &&
      burst.target === field &&
      burst.count >= fieldBurstMinLength &&
      now() - burst.lastAt <= fieldBurstMaxGapMs
    ) {
      consume(event)
      restoreFieldValue(field, burst.snapshot)
      options.onFieldBurstReverted?.()
    }
  }

  function handleTender(event: KeyboardEvent): void {
    if (isEditableTarget(event.target)) {
      swallowed = ''
      handleTenderField(event, event.target as HTMLElement)
      return
    }
    fieldBurst = null

    if (isPrintable(event)) {
      if (isSpace(event) && !swallowed) {
        // A leading Space: native on ordinary controls, suppressed on commit-class ones.
        suppressCommitActivation(event)
        return
      }
      consumeSpaceAware(event)
      if (!event.repeat) {
        swallowed += event.key
      }
      return
    }

    if (isEnter(event) || isTab(event)) {
      if (swallowed) {
        consume(event)
        if (!event.repeat) {
          swallowed = ''
          options.onScannerIgnored?.()
        }
        return
      }
      suppressCommitActivation(event)
      return
    }

    // Scanners never send any other key, so whatever was swallowed was not a scan.
    swallowed = ''
  }

  function handleDone(event: KeyboardEvent): void {
    if (collected) {
      if (isPrintable(event)) {
        consumeSpaceAware(event)
        if (!event.repeat) {
          appendToCollection(event.key)
        }
        return
      }
      if (isEnter(event) || isTab(event)) {
        consume(event)
        if (!event.repeat) {
          finishCollection()
        }
        return
      }
      if (!hasCommandModifier(event)) {
        // Anything else while collecting (arrows, Backspace, …) is ignored, never acted on.
        consume(event)
      }
      return
    }

    if (isPrintable(event) && !isSpace(event) && !event.repeat && !isEditableTarget(event.target)) {
      consume(event)
      startCollection(event.key)
      return
    }

    // Not collecting: Tab and a leading Space stay native; commit-class Enter/Space do not.
    suppressCommitActivation(event)
  }

  function handleKeydown(event: KeyboardEvent): void {
    const mode = options.mode()
    syncMode(mode)
    if (isSpace(event)) {
      // Pair keyup suppression with the latest Space keydown only.
      suppressSpaceKeyup = false
    }

    if (mode === 'inactive' || isComposingEvent(event)) {
      return
    }
    if (mode === 'page') {
      handlePage(event)
      return
    }
    if (mode === 'layout-edit') {
      handleLayoutEdit(event)
      return
    }
    if (isModifierOnlyKey(event.key)) {
      return
    }
    if (isF9(event)) {
      handleF9(event, mode)
      return
    }
    if (mode === 'payment-done' && isPrintShortcut(event)) {
      consume(event)
      if (!event.repeat) {
        discardCollection(true)
        options.onPrint?.()
      }
      return
    }
    if (event.key === 'Escape') {
      handleEscape(event, mode)
      return
    }

    if (mode === 'payment-tender') {
      handleTender(event)
    } else if (mode === 'payment-done') {
      handleDone(event)
    } else {
      suppressCommitActivation(event)
    }
  }

  function handleKeyup(event: KeyboardEvent): void {
    if (!isSpace(event)) {
      return
    }
    if (suppressSpaceKeyup) {
      suppressSpaceKeyup = false
      consume(event)
      return
    }
    const mode = options.mode()
    if (
      mode !== 'page' &&
      mode !== 'inactive' &&
      mode !== 'layout-edit' &&
      isCommitTarget(event.target)
    ) {
      consume(event)
    }
  }

  target.addEventListener('keydown', handleKeydown as EventListener, CAPTURE)
  target.addEventListener('keyup', handleKeyup as EventListener, CAPTURE)

  function dispose(): void {
    target.removeEventListener('keydown', handleKeydown as EventListener, CAPTURE)
    target.removeEventListener('keyup', handleKeyup as EventListener, CAPTURE)
    clearIdleTimer()
    detector.dispose()
    swallowed = ''
    collected = ''
    fieldBurst = null
    suppressSpaceKeyup = false
  }

  return {
    handleKeydown,
    handleKeyup,
    isCollecting: () => collected !== '',
    reset,
    dispose
  }
}

/**
 * Mounts the router on `window` for the lifetime of the calling component. `collecting` mirrors
 * the payment-done collection so the page can pass `collectingHint` to `PaymentPanel`.
 */
export function useScanInputRouter(options: ScanInputRouterOptions): {
  readonly collecting: Readonly<Ref<boolean>>
  readonly reset: () => void
} {
  const collecting = ref(false)
  let router: ScanInputRouter | null = null

  onMounted(() => {
    router = createScanInputRouter({
      ...options,
      onCollectingChange: (value) => {
        collecting.value = value
        options.onCollectingChange?.(value)
      }
    })
  })

  onBeforeUnmount(() => {
    router?.dispose()
    router = null
    collecting.value = false
  })

  return { collecting: readonly(collecting), reset: () => router?.reset() }
}
