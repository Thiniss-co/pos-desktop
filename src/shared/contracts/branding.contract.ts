import { z } from 'zod'

/**
 * Owner UX plan P9 — the company identity the renderer shows: the company name, the primary colour
 * (brand tokens are derived in the renderer with the shared algorithm) and the verified logo as a
 * `data:` URL (CSP `img-src 'self' data:`). All null when nobody is signed in or nothing was delivered.
 */
export const companyBrandingViewSchema = z
  .object({
    companyName: z.string().min(1).max(255).nullable(),
    primaryColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/)
      .nullable(),
    logoDataUrl: z
      .string()
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/)
      .nullable()
  })
  .strict()

export type CompanyBrandingView = z.infer<typeof companyBrandingViewSchema>
