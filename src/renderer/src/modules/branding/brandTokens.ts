/**
 * Owner UX plan P9 — the register's brand tokens, derived from the company's one `#RRGGBB` primary colour with
 * the SAME algorithm and shared vectors as the owner portal (`resources/company-owner/utils/brandTokens.ts`,
 * `brand-contrast-vectors.json`, mirrored by the backend's `BrandColorContrast`).
 *
 * - `pri` (filled primary actions, and also selected outlines and indicators drawn on the surface) is the colour
 *   itself when it reaches 3:1 against the theme's surface; otherwise its lightness moves until it does (else the
 *   palette primary). `onPri` (text on it) is black or white, whichever contrasts more (always ≥ 4.5:1). Hover and
 *   pressed fills move away from that text colour and keep ≥ 4.5:1, else they stay the primary colour.
 * - `priSoft` (selected states) is the colour composited over the surface; `priText` (links, selected labels)
 *   needs 4.5:1 on the surface, the page and the soft fill; `focus` needs 3:1 on the surface and the page. Only
 *   the OKLCH lightness moves; a token that cannot reach its threshold falls back to the theme default.
 * - Danger, warning and success are never derived from the brand.
 */
export type BrandTheme = 'light' | 'dark'

export interface DesktopBrandTokens {
  pri: string
  priHover: string
  priPress: string
  priText: string
  priSoft: string
  onPri: string
  focus: string
  fallbacks: Array<'pri' | 'priText' | 'focus'>
}

/** The surfaces in `assets/themes/palette.css` the brand tokens are drawn on. */
export const THEME_SURFACES: Record<BrandTheme, { surf: string; page: string }> = {
  light: { surf: '#ffffff', page: '#f4f4fb' },
  dark: { surf: '#171827', page: '#0e0f1a' }
}

/** The palette defaults a failing token falls back to. */
export const THEME_DEFAULTS: Record<
  BrandTheme,
  Pick<DesktopBrandTokens, 'pri' | 'priText' | 'focus'>
> = {
  light: { pri: '#4f46e5', priText: '#4338ca', focus: '#6366f1' },
  dark: { pri: '#5b57e8', priText: '#a5b4fc', focus: '#818cf8' }
}

const SOFT_ALPHA: Record<BrandTheme, number> = { light: 0.1, dark: 0.22 }

export const isHexColor = (value: string): boolean => /^#[0-9a-fA-F]{6}$/.test(value)

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255) as [
    number,
    number,
    number
  ]
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((value) =>
      Math.round(Math.min(1, Math.max(0, value)) * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ) as [number, number, number]

  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(foreground: string, background: string): number {
  const one = luminance(foreground)
  const two = luminance(background)

  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05)
}

export function onColor(hex: string): string {
  return contrast('#000000', hex) >= contrast('#ffffff', hex) ? '#000000' : '#ffffff'
}

const toLinear = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
const fromLinear = (channel: number): number =>
  channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055

export function toOklch(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map(toLinear) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s

  return [lightness, Math.hypot(a, bb), ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360]
}

function oklchToRgb(lightness: number, chroma: number, hue: number): [number, number, number] {
  const a = chroma * Math.cos((hue * Math.PI) / 180)
  const b = chroma * Math.sin((hue * Math.PI) / 180)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3

  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  ]
}

/** The colour at another OKLCH lightness, reducing chroma until it fits in sRGB. */
export function withLightness(hex: string, lightness: number): string {
  const [, chroma, hue] = toOklch(hex)
  for (let c = chroma; c >= 0; c -= 0.005) {
    const rgb = oklchToRgb(lightness, c, hue)
    if (rgb.every((value) => value >= -0.0005 && value <= 1.0005)) return toHex(rgb)
  }

  return toHex(oklchToRgb(lightness, 0, hue))
}

export function composite(hex: string, background: string, alpha: number): string {
  const top = channels(hex)
  const bottom = channels(background)

  return toHex(
    top.map((channel, index) => channel * alpha + (bottom[index] ?? 0) * (1 - alpha)) as [
      number,
      number,
      number
    ]
  )
}

function legible(hex: string, backgrounds: string[], minimum: number): string | null {
  const passes = (candidate: string): boolean =>
    backgrounds.every((background) => contrast(candidate, background) >= minimum)
  if (passes(hex)) return hex
  const [start] = toOklch(hex)
  const lighter = luminance(backgrounds[0] ?? '#000000') < 0.5
  for (let step = 1; step <= 50; step += 1) {
    const lightness = lighter ? start + step * 0.02 : start - step * 0.02
    if (lightness < 0 || lightness > 1) break
    const candidate = withLightness(hex, lightness)
    if (passes(candidate)) return candidate
  }

  return null
}

/** A fill `distance` lighter or darker than the colour, away from the text drawn on it; else the colour. */
function shade(color: string, onPri: string, distance: number): string {
  const [lightness] = toOklch(color)
  const candidate = withLightness(
    color,
    Math.min(1, Math.max(0, onPri === '#ffffff' ? lightness - distance : lightness + distance))
  )

  return contrast(onPri, candidate) >= 4.5 ? candidate : color
}

export function deriveDesktopBrandTokens(primary: string, theme: BrandTheme): DesktopBrandTokens {
  const brand = primary.toLowerCase()
  const { surf, page } = THEME_SURFACES[theme]
  const defaults = THEME_DEFAULTS[theme]
  const fallbacks: DesktopBrandTokens['fallbacks'] = []
  const pick = (key: 'pri' | 'priText' | 'focus', value: string | null): string => {
    if (value !== null) return value
    fallbacks.push(key)
    return defaults[key]
  }
  // Selected outlines and indicators use `pri` on the surface, so it must stay visible there (3:1).
  const color = pick('pri', legible(brand, [surf], 3))
  const onPri = onColor(color)
  const priSoft = composite(color, surf, SOFT_ALPHA[theme])

  return {
    pri: color,
    priHover: shade(color, onPri, 0.05),
    priPress: shade(color, onPri, 0.1),
    priText: pick('priText', legible(color, [surf, page, priSoft], 4.5)),
    priSoft,
    onPri,
    focus: pick('focus', legible(color, [surf, page], 3)),
    fallbacks
  }
}

/** The CSS custom properties (as `light-dark()` pairs) that override the palette's primary tokens. */
export function brandDeclarations(primary: string): Record<string, string> {
  const light = deriveDesktopBrandTokens(primary, 'light')
  const dark = deriveDesktopBrandTokens(primary, 'dark')
  const pair = (key: keyof Omit<DesktopBrandTokens, 'fallbacks'>): string =>
    `light-dark(${light[key]}, ${dark[key]})`

  return {
    '--color-pri': pair('pri'),
    '--color-pri-hover': pair('priHover'),
    '--color-pri-press': pair('priPress'),
    '--color-pri-text': pair('priText'),
    '--color-pri-soft': pair('priSoft'),
    '--color-on-pri': pair('onPri'),
    '--color-focus': pair('focus')
  }
}
