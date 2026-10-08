import { launchApp, t } from '../support/app.mjs'
import { activate, openSandboxAndApp, signIn, waitForRoute } from '../support/journey.mjs'
import { queryLocal } from '../support/localDb.mjs'

/**
 * V1 closeout — credential storage fails closed on an unprotected Linux key store.
 *
 *  A. The workstation is activated normally (keyring available).
 *  B. Relaunched with `--password-store=basic` (Chromium's fallback: a fixed, publicly known key),
 *     sign-in is refused before the password leaves the workstation, with the actionable
 *     SECURE_STORAGE_* message; no secret is stored and no session starts.
 *  C. Relaunched with the run-local GNOME keyring, the same cashier signs in and the token is stored.
 */
function secretKeys(profileDir) {
  return queryLocal(profileDir, 'SELECT key FROM secure_secrets ORDER BY key').map((row) => row.key)
}

export async function run(ctx) {
  const session = await openSandboxAndApp(ctx)
  const { sandbox } = session
  try {
    await activate(ctx, session.page)
    await session.app.close()

    // B. Unprotected key store: refused, nothing stored.
    Object.assign(
      session,
      await launchApp({
        outDir: session.outDir,
        profileDir: session.profileDir,
        passwordStore: 'basic'
      })
    )
    const page = session.page
    await page.getByRole('button', { name: await t(page, 'auth.signIn') }).waitFor()
    const status = await page.evaluate(async () => await window.posApi.system.getRuntimeInfo())
    ctx.step('B: relaunched with --password-store=basic', { runtime: status.ok })
    await signIn(ctx, page)
    const messages = [
      await t(page, 'errors.SECURE_STORAGE_INSECURE_BACKEND'),
      await t(page, 'errors.SECURE_STORAGE_UNAVAILABLE')
    ]
    const shown = await page.waitForFunction(
      (candidates) => candidates.find((text) => document.body.innerText.includes(text)) ?? null,
      messages,
      { timeout: 30_000 }
    )
    const refusal = await shown.jsonValue()
    await ctx.shot(page, 'B1-sign-in-refused-unprotected-keystore')
    const session1 = await page.evaluate(async () => await window.posApi.auth.getSessionSummary())
    const storedB = secretKeys(session.profileDir)
    ctx.step('B: sign-in refused', {
      code:
        refusal === messages[0] ? 'SECURE_STORAGE_INSECURE_BACKEND' : 'SECURE_STORAGE_UNAVAILABLE',
      authenticated: session1.ok ? session1.data.isAuthenticated : null,
      storedSecrets: storedB
    })
    if (storedB.length !== 0) throw new Error('B: a secret was stored on an unprotected key store')
    if (!session1.ok || session1.data.isAuthenticated)
      throw new Error('B: a session started on an unprotected key store')
    await session.app.close()

    // C. Protected key store: the same cashier signs in.
    Object.assign(
      session,
      await launchApp({ outDir: session.outDir, profileDir: session.profileDir })
    )
    await signIn(ctx, session.page)
    await waitForRoute(session.page, 'pos')
    const storedC = secretKeys(session.profileDir)
    ctx.step('C: signed in with the keyring', { storedSecrets: storedC })
    await ctx.shot(session.page, 'C1-signed-in-with-keyring')
    if (!storedC.includes('desktop_access_token'))
      throw new Error('C: the token was not stored with the keyring available')
  } finally {
    await session.app.close().catch(() => undefined)
    await sandbox.stop()
  }
}
