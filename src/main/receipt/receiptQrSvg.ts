import qrcode from 'qrcode-generator'

/**
 * POS improvements, Stage 6 — the receipt QR as an inline SVG sized in millimetres, so the printed
 * module size is exact: error correction M, a 4-module quiet zone, modules of at least 0.4 mm on 80 mm
 * paper and 0.33 mm on 58 mm paper. The payloads are ASCII (Base64 or the `THINIS-TXN/1` reference).
 */

export const QR_QUIET_ZONE_MODULES = 4
export const QR_MIN_MODULE_MM_80 = 0.4
export const QR_MIN_MODULE_MM_58 = 0.33

export interface ReceiptQrSvg {
  readonly svg: string
  readonly modules: number
  readonly moduleMm: number
  readonly sizeMm: number
}

/** Throws when the code cannot be printed at the minimum module size within the printable width. */
export function receiptQrSvg(payload: string, printableWidthMm: number): ReceiptQrSvg {
  const code = qrcode(0, 'M')
  code.addData(payload, 'Byte')
  code.make()
  const modules = code.getModuleCount()
  const size = modules + QR_QUIET_ZONE_MODULES * 2
  const wide = printableWidthMm >= 70
  const minimum = wide ? QR_MIN_MODULE_MM_80 : QR_MIN_MODULE_MM_58
  // Preferred 0.5 mm (80 mm) / 0.4 mm (58 mm), shrunk to fit at most 80 % of the width, never below the minimum.
  const preferred = wide ? 0.5 : 0.4
  const moduleMm = Math.min(preferred, (printableWidthMm * 0.8) / size)
  if (moduleMm < minimum) {
    throw new RangeError('The receipt QR does not fit at the minimum module size')
  }
  let path = ''
  for (let row = 0; row < modules; row += 1) {
    for (let column = 0; column < modules; column += 1) {
      if (code.isDark(row, column)) {
        path += `M${column + QR_QUIET_ZONE_MODULES} ${row + QR_QUIET_ZONE_MODULES}h1v1h-1z`
      }
    }
  }
  const sizeMm = Number((size * moduleMm).toFixed(3))
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${sizeMm}mm" height="${sizeMm}mm"` +
    ` shape-rendering="crispEdges" role="img" aria-hidden="true">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/><path d="${path}" fill="#000000"/></svg>`
  return { svg, modules, moduleMm, sizeMm }
}
