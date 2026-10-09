import path from 'node:path'

/**
 * Fail-closed Authenticode check for a downloaded Windows installer, used as electron-updater's
 * `verifyUpdateCodeSignature`. It keeps electron-updater's matching rules (Status must be Valid; a
 * publisher given as a distinguished name must match on every attribute, a bare name matches the
 * signer's CN) but never accepts on doubt: electron-updater's own verifier accepts the update when
 * PowerShell cannot run (it logs "Ignoring signature validation"); this one refuses instead.
 *
 * Returns null when the installer is signed by the expected publisher, otherwise the refusal reason.
 */

/** `Get-AuthenticodeSignature` Status: 0 is Valid (System.Management.Automation.SignatureStatus). */
const STATUS_VALID = 0

/** Splits a distinguished name ("CN=Company, Ltd" quoted, O=..., C=SA) into upper-cased keys. */
export function parseDistinguishedName(value: string): Map<string, string> {
  const result = new Map<string, string>()
  let index = 0
  const text = value.trim()
  while (index < text.length) {
    const equals = text.indexOf('=', index)
    if (equals === -1) break
    const key = text.slice(index, equals).trim().toUpperCase()
    let cursor = equals + 1
    while (text[cursor] === ' ') cursor += 1
    let content = ''
    if (text[cursor] === '"') {
      cursor += 1
      while (cursor < text.length && text[cursor] !== '"') {
        if (text[cursor] === '\\' && cursor + 1 < text.length) cursor += 1
        content += text[cursor]
        cursor += 1
      }
      cursor += 1
      while (cursor < text.length && text[cursor] !== ',' && text[cursor] !== '+') cursor += 1
    } else {
      while (cursor < text.length && text[cursor] !== ',' && text[cursor] !== '+') {
        if (text[cursor] === '\\' && cursor + 1 < text.length) cursor += 1
        content += text[cursor]
        cursor += 1
      }
      content = content.trim()
    }
    if (!/^[A-Z][A-Z0-9.]*$/.test(key)) return new Map()
    result.set(key, content)
    index = cursor + 1
  }
  return result
}

function publisherMatches(publisherName: string, signerSubject: Map<string, string>): boolean {
  const expected = parseDistinguishedName(publisherName)
  if (expected.size > 0 && publisherName.includes('=')) {
    return [...expected.entries()].every(([key, value]) => signerSubject.get(key) === value)
  }
  return publisherName.trim().length > 0 && signerSubject.get('CN') === publisherName.trim()
}

export function evaluateAuthenticodeResult(input: {
  readonly stdout: string
  readonly file: string
  readonly publisherNames: readonly string[]
}): string | null {
  if (input.publisherNames.length === 0) return 'no publisher recorded for this build'
  let data: {
    Status?: unknown
    Path?: unknown
    SignerCertificate?: { Subject?: unknown } | null
  }
  try {
    data = JSON.parse(input.stdout)
  } catch {
    return 'unreadable signature check output'
  }
  if (data === null || typeof data !== 'object') return 'unreadable signature check output'
  if (data.Status !== STATUS_VALID) return `signature status ${String(data.Status)} (not Valid)`
  if (
    typeof data.Path === 'string' &&
    path.win32.normalize(data.Path) !== path.win32.normalize(input.file)
  ) {
    return 'signature checked for another file'
  }
  const subject = data.SignerCertificate?.Subject
  if (typeof subject !== 'string' || subject.length === 0) return 'no signer certificate'
  const signer = parseDistinguishedName(subject)
  if (!input.publisherNames.some((name) => publisherMatches(name, signer))) {
    return 'installer signed by another publisher'
  }
  return null
}

export type PowerShellRunner = (
  command: string,
  timeoutMs: number
) => Promise<{ stdout: string; stderr: string }>

/**
 * The verifier electron-updater calls with the build's publisher names and the downloaded installer.
 * Any failure to run the check, a timeout or output on stderr refuses the update.
 */
export function createWindowsSignatureVerifier(
  runPowerShell: PowerShellRunner,
  log: (line: string) => void = () => undefined
): (publisherNames: string[], file: string) => Promise<string | null> {
  return async (publisherNames, file) => {
    const literal = file.replace(/'/g, "''")
    let output: { stdout: string; stderr: string }
    try {
      output = await runPowerShell(
        `Get-AuthenticodeSignature -LiteralPath '${literal}' | ConvertTo-Json -Compress -Depth 3`,
        20_000
      )
    } catch {
      log('update-signature refused: the signature check could not run')
      return 'the signature check could not run'
    }
    if (output.stderr.trim().length > 0) {
      log('update-signature refused: the signature check reported an error')
      return 'the signature check reported an error'
    }
    const refusal = evaluateAuthenticodeResult({ stdout: output.stdout, file, publisherNames })
    log(refusal === null ? 'update-signature verified' : `update-signature refused: ${refusal}`)
    return refusal
  }
}
