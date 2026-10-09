import { describe, expect, it, vi } from 'vitest'
import {
  createWindowsSignatureVerifier,
  evaluateAuthenticodeResult,
  parseDistinguishedName
} from './authenticode'

const FILE =
  'C:\\Users\\cashier\\AppData\\Local\\pos-desktop-updater\\pending\\temp-pos-desktop-1.0.1-setup.exe'
const SUBJECT = 'CN="Company, Ltd", O="Company, Ltd", L=Riyadh, C=SA'

function output(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Status: 0,
    StatusMessage: 'Signature verified.',
    Path: FILE,
    SignerCertificate: { Subject: SUBJECT, Thumbprint: 'AB12' },
    ...overrides
  })
}

describe('parseDistinguishedName', () => {
  it('reads quoted values with commas, plain values and escaped characters', () => {
    const dn = parseDistinguishedName(SUBJECT)
    expect(dn.get('CN')).toBe('Company, Ltd')
    expect(dn.get('O')).toBe('Company, Ltd')
    expect(dn.get('L')).toBe('Riyadh')
    expect(dn.get('C')).toBe('SA')
    expect(parseDistinguishedName('CN=A\\, B, O=X').get('CN')).toBe('A, B')
  })
})

describe('evaluateAuthenticodeResult', () => {
  it('accepts a Valid signature by the recorded publisher (CN or full DN)', () => {
    expect(
      evaluateAuthenticodeResult({ stdout: output(), file: FILE, publisherNames: ['Company, Ltd'] })
    ).toBeNull()
    expect(
      evaluateAuthenticodeResult({
        stdout: output(),
        file: FILE,
        publisherNames: ['CN="Company, Ltd", C=SA']
      })
    ).toBeNull()
  })

  it('refuses an unsigned, tampered or untrusted installer (Status not Valid)', () => {
    for (const status of [1, 2, 3, 4, 5, 6, '0', null]) {
      expect(
        evaluateAuthenticodeResult({
          stdout: output({ Status: status }),
          file: FILE,
          publisherNames: ['Company, Ltd']
        })
      ).toMatch(/not Valid/)
    }
  })

  it('refuses a Valid signature by another publisher, and a DN that differs in any attribute', () => {
    expect(
      evaluateAuthenticodeResult({
        stdout: output({ SignerCertificate: { Subject: 'CN=Someone Else, C=SA' } }),
        file: FILE,
        publisherNames: ['Company, Ltd']
      })
    ).toBe('installer signed by another publisher')
    expect(
      evaluateAuthenticodeResult({
        stdout: output(),
        file: FILE,
        publisherNames: ['CN="Company, Ltd", C=AE']
      })
    ).toBe('installer signed by another publisher')
  })

  it('refuses when the check is about another file, has no signer, or cannot be read', () => {
    expect(
      evaluateAuthenticodeResult({
        stdout: output({ Path: 'C:\\other.exe' }),
        file: FILE,
        publisherNames: ['Company, Ltd']
      })
    ).toBe('signature checked for another file')
    expect(
      evaluateAuthenticodeResult({
        stdout: output({ SignerCertificate: null }),
        file: FILE,
        publisherNames: ['Company, Ltd']
      })
    ).toBe('no signer certificate')
    expect(
      evaluateAuthenticodeResult({
        stdout: 'not json',
        file: FILE,
        publisherNames: ['Company, Ltd']
      })
    ).toBe('unreadable signature check output')
    expect(evaluateAuthenticodeResult({ stdout: output(), file: FILE, publisherNames: [] })).toBe(
      'no publisher recorded for this build'
    )
  })
})

describe('createWindowsSignatureVerifier', () => {
  it('passes the installer path as a literal and accepts the recorded publisher', async () => {
    const run = vi.fn(async () => ({ stdout: output({ Path: "C:\\it's\\setup.exe" }), stderr: '' }))
    const verify = createWindowsSignatureVerifier(run)
    await expect(verify(['Company, Ltd'], "C:\\it's\\setup.exe")).resolves.toBeNull()
    expect(run).toHaveBeenCalledWith(
      "Get-AuthenticodeSignature -LiteralPath 'C:\\it''s\\setup.exe' | ConvertTo-Json -Compress -Depth 3",
      20_000
    )
  })

  it('fails closed when PowerShell cannot run, times out, or writes to stderr', async () => {
    const failing = createWindowsSignatureVerifier(async () => {
      throw Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' })
    })
    await expect(failing(['Company, Ltd'], FILE)).resolves.toBe('the signature check could not run')
    const stderr = createWindowsSignatureVerifier(async () => ({
      stdout: output(),
      stderr: 'Get-AuthenticodeSignature : blocked by policy'
    }))
    await expect(stderr(['Company, Ltd'], FILE)).resolves.toBe(
      'the signature check reported an error'
    )
  })
})
