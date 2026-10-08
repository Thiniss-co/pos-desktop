import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every IPC channel answers only the application's own main frame. Each `ipcMain.handle`
 * registration must run the sender check -- through `handleTrustedIpcRequest(event, …)`,
 * `assertTrustedSender(event)`, or the two file-local wrappers around it (`trusted(event)` in
 * catalogInstall.ipc.ts, `rejectUntrustedSender(event)` in preferences.ipc.ts) -- so a new channel
 * cannot be added without it.
 */
const SENDER_CHECKS = [
  /handleTrustedIpcRequest\(\s*event,/,
  /assertTrustedSender\(event\)/,
  /\btrusted\(event\)/,
  /rejectUntrustedSender(?:<[^>]+>)?\(event\)/
]
const IPC_DIRECTORY = __dirname

function registrations(source: string): string[] {
  const starts = [...source.matchAll(/ipcMain\.handle\(/g)].map((match) => match.index ?? 0)

  return starts.map((start, index) => source.slice(start, starts[index + 1] ?? source.length))
}

describe('IPC sender coverage', () => {
  const files = readdirSync(IPC_DIRECTORY).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts')
  )
  const all = files.flatMap((name) =>
    registrations(readFileSync(join(IPC_DIRECTORY, name), 'utf8')).map((block) => ({
      name,
      channel: /IPC_CHANNELS\.(\w+)/.exec(block)?.[1] ?? block.slice(0, 80),
      block
    }))
  )

  it('finds the registered channels', () => {
    expect(all.length).toBeGreaterThan(80)
  })

  it('checks the sender on every registered channel', () => {
    const unchecked = all
      .filter(({ block }) => !SENDER_CHECKS.some((check) => check.test(block)))
      .map(({ name, channel }) => `${name}: ${channel}`)

    expect(unchecked).toEqual([])
  })
})
