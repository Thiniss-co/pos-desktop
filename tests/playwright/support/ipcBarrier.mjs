/**
 * A controlled barrier on one real IPC channel, installed in the running app's MAIN process.
 *
 * The real handler still runs (validation, sender check, service, SQLite); only its ANSWER is held
 * until the journey releases it. This turns a race ("the lookup is still in flight when …") into an
 * ordered sequence the journey proves step by step, instead of assuming a timing.
 *
 * It replaces the registered invoke handler through Electron's handler registry
 * (`ipcMain._invokeHandlers`, present in Electron 39) and restores the original on `restore()`.
 * Test harness only: the app itself is unchanged.
 */

export async function installIpcBarrier(app, channel) {
  await app.evaluate(({ ipcMain }, name) => {
    const registry = ipcMain._invokeHandlers
    const original = registry instanceof Map ? registry.get(name) : undefined
    if (typeof original !== 'function') {
      throw new Error(`no invoke handler registered for ${name}`)
    }
    const barrier = { original, waiting: [], answered: 0 }
    globalThis.__pwIpcBarriers = { ...(globalThis.__pwIpcBarriers ?? {}), [name]: barrier }
    ipcMain.removeHandler(name)
    ipcMain.handle(name, async (event, input) => {
      const answer = await original(event, input)
      await new Promise((release) => barrier.waiting.push(release))
      barrier.answered += 1
      return answer
    })
  }, channel)

  const state = () =>
    app.evaluate((_electron, name) => {
      const barrier = globalThis.__pwIpcBarriers[name]
      return { held: barrier.waiting.length, answered: barrier.answered }
    }, channel)

  return {
    state,
    /** Polls (no fixed sleep) until `predicate(state)` holds, or fails with the last state. */
    async until(predicate, label, timeout = 15_000) {
      const deadline = Date.now() + timeout
      let current = await state()
      while (!predicate(current)) {
        if (Date.now() > deadline) throw new Error(`${label}: ${JSON.stringify(current)}`)
        await new Promise((resolve) => setTimeout(resolve, 25))
        current = await state()
      }
      return current
    },
    /** Lets the oldest held answer go to the renderer. */
    async releaseOne() {
      const released = await app.evaluate((_electron, name) => {
        const next = globalThis.__pwIpcBarriers[name].waiting.shift()
        next?.()
        return Boolean(next)
      }, channel)
      if (!released) throw new Error(`no held answer on ${channel} to release`)
    },
    /** Releases anything still held and puts the original handler back. */
    async restore() {
      await app.evaluate(({ ipcMain }, name) => {
        const barrier = globalThis.__pwIpcBarriers?.[name]
        if (!barrier) return
        for (const release of barrier.waiting.splice(0)) release()
        ipcMain.removeHandler(name)
        ipcMain.handle(name, barrier.original)
        delete globalThis.__pwIpcBarriers[name]
      }, channel)
    }
  }
}
