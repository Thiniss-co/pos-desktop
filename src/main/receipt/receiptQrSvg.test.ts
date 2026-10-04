import { describe, expect, it } from 'vitest'
import { QR_MIN_MODULE_MM_58, QR_MIN_MODULE_MM_80, receiptQrSvg } from './receiptQrSvg'

describe('POS improvements Stage 6: receipt QR sizing', () => {
  const payload =
    'AQxCb2JzIFJlY29yZHMCDzMxMDEyMjM5MzUwMDAwMwMUMjAyMi0wNC0yNVQxNTozMDowMFoEBzEwMDAuMDAFBjE1MC4wMA=='

  it('uses 0.5 mm modules with a 4-module quiet zone on 80 mm paper', () => {
    const qr = receiptQrSvg(payload, 72)
    expect(qr.moduleMm).toBe(0.5)
    expect(qr.sizeMm).toBeCloseTo((qr.modules + 8) * 0.5, 3)
    expect(qr.svg).toContain(`viewBox="0 0 ${qr.modules + 8} ${qr.modules + 8}"`)
  })

  it('stays at or above the minimum module size and within 80 % of the width on 58 mm paper', () => {
    const qr = receiptQrSvg(payload, 48)
    expect(qr.moduleMm).toBeGreaterThanOrEqual(QR_MIN_MODULE_MM_58)
    expect(qr.sizeMm).toBeLessThanOrEqual(48 * 0.8 + 0.001)
  })

  it('fits the longest ZATCA payload (500 Base64 characters) on both papers', () => {
    const longest = 'A'.repeat(500)
    expect(receiptQrSvg(longest, 72).moduleMm).toBeGreaterThanOrEqual(QR_MIN_MODULE_MM_80)
    expect(receiptQrSvg(longest, 48).moduleMm).toBeGreaterThanOrEqual(QR_MIN_MODULE_MM_58)
  })

  it('refuses a width where the code cannot be printed at the minimum module size', () => {
    expect(() => receiptQrSvg('A'.repeat(500), 20)).toThrow()
  })
})
