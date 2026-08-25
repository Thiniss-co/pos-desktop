// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBarcodeScanner } from './useBarcodeScanner'

function key(value: string, target: HTMLElement = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

describe('createBarcodeScanner', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('completes once on Enter and preserves rapid scan ordering', async () => {
    const scans: string[] = []
    const scanner = createBarcodeScanner({
      onScan: async (code) => {
        scans.push(code)
      }
    })

    for (const character of '12345') key(character)
    key('Enter')
    for (const character of '67890') key(character)
    key('Enter')
    await vi.waitFor(() => expect(scans).toEqual(['12345', '67890']))
    scanner.dispose()
  })

  it('ignores editable targets, composition, modal ownership, and modifier shortcuts', () => {
    vi.useFakeTimers()
    const onScan = vi.fn()
    const scanner = createBarcodeScanner({ onScan })
    const input = document.createElement('input')
    document.body.append(input)
    for (const character of '12345') key(character, input)
    key('Enter', input)

    const dialog = document.createElement('div')
    dialog.setAttribute('aria-modal', 'true')
    document.body.append(dialog)
    for (const character of '67890') key(character)
    key('Enter')
    dialog.remove()
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true })
    )
    vi.runAllTimers()

    expect(onScan).not.toHaveBeenCalled()
    scanner.dispose()
  })

  it('does not duplicate a timeout-completed scan and removes its only listener', async () => {
    vi.useFakeTimers()
    const onScan = vi.fn()
    const scanner = createBarcodeScanner({ onScan, completionDelayMs: 50 })
    for (const character of '12345') key(character)
    vi.advanceTimersByTime(50)
    await Promise.resolve()
    key('Enter')
    expect(onScan).toHaveBeenCalledTimes(1)

    scanner.dispose()
    for (const character of '67890') key(character)
    key('Enter')
    expect(onScan).toHaveBeenCalledTimes(1)
  })
})
