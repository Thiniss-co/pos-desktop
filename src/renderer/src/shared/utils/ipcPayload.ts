/**
 * Plain-data copy of an IPC request payload.
 *
 * Stores and pages keep request inputs in Vue refs / reactive objects, i.e. Proxies. Electron's
 * preload bridge structured-clones every argument and cannot clone a Proxy ("An object could not
 * be cloned"), so a reactive input would fail before ever reaching the main process.
 *
 * Every desktop IPC payload is plain data by contract (Zod-validated in main: strings, finite
 * numbers, booleans, null, arrays and plain objects of those). This copies exactly that and keeps
 * every such value as it is — including an `undefined` optional, which stays `undefined` rather
 * than being turned into something else.
 *
 * Anything outside that shape is **refused, never converted**: a JSON round-trip would silently
 * turn `NaN` into `null`, a `Date` into a string and a `Map` into `{}`, and drop functions and
 * symbol keys, so main would validate a different value from the one the renderer meant.
 */
export class IpcPayloadError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string
  ) {
    super(`Unsupported IPC payload value at ${path}: ${reason}`)
    this.name = 'IpcPayloadError'
  }
}

export function toIpcPayload<T>(value: T): T {
  return copyPlainData(value, '$', new Set()) as T
}

function copyPlainData(value: unknown, path: string, ancestors: Set<object>): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new IpcPayloadError(path, 'a non-finite number')
    }

    return value
  }

  if (typeof value !== 'object') {
    // function, symbol, bigint
    throw new IpcPayloadError(path, `a ${typeof value}`)
  }

  if (ancestors.has(value)) {
    throw new IpcPayloadError(path, 'a circular reference')
  }

  ancestors.add(value)

  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => copyPlainData(item, `${path}[${index}]`, ancestors))
    }

    // A reactive Proxy reports its target's prototype, so reactive plain objects pass here.
    const prototype = Object.getPrototypeOf(value)

    if (prototype !== Object.prototype && prototype !== null) {
      throw new IpcPayloadError(path, 'not a plain object')
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new IpcPayloadError(path, 'a symbol-keyed property')
    }

    const copy: Record<string, unknown> = {}

    for (const key of Object.keys(value)) {
      copy[key] = copyPlainData(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        ancestors
      )
    }

    return copy
  } finally {
    ancestors.delete(value)
  }
}
