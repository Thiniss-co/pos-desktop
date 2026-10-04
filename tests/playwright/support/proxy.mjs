/**
 * A controllable HTTP proxy between the real Electron app and the disposable Laravel backend.
 *
 * The app's API origin is baked into the main bundle at build time, so journeys build against this
 * proxy's port. Nothing in the app changes: it talks real HTTP to what it believes is its backend.
 * The proxy lets a journey inject network conditions that a real network produces — a slow
 * response, a server error, an outage — without touching application code or business guards.
 *
 * Each rule matches `METHOD path` (regex) and may delay, answer with a status, drop the answer
 * after the server processed the request (`dropResponse`), drop the connection, or `hold()` the
 * request (the client's connection fails at once; the request reaches the server only when released).
 * `offline()` stops accepting connections entirely (connection refused). `preserveHost` forwards the
 * client's Host header (a browser journey needs the server to build URLs for the proxy origin).
 */
import { createServer, request as httpRequest } from 'node:http'
import { freePort } from './sandbox.mjs'

export async function startProxy(targetOrigin, port = null, { preserveHost = false } = {}) {
  const listenPort = port ?? (await freePort())
  const target = new URL(targetOrigin)
  const rules = []
  const log = []
  let server = null

  const handler = (req, res) => {
    const line = `${req.method} ${req.url}`
    const rule = rules.find((r) => r.match.test(line) && (r.times === undefined || r.times > 0))
    log.push({ at: Date.now(), line, rule: rule?.label ?? null })
    const forward = () => {
      const upstream = httpRequest(
        {
          host: target.hostname,
          port: target.port,
          method: req.method,
          path: req.url,
          headers: preserveHost ? req.headers : { ...req.headers, host: target.host }
        },
        (up) => {
          if (rule?.dropResponse) {
            // The server received and processed the request; its answer never reaches the client.
            up.resume()
            req.socket.destroy()
            return
          }
          const respond = () => {
            res.writeHead(up.statusCode ?? 502, up.headers)
            up.pipe(res)
          }
          if (rule?.delayResponseMs) {
            setTimeout(respond, rule.delayResponseMs)
          } else {
            respond()
          }
        }
      )
      upstream.on('error', () => {
        res.writeHead(502)
        res.end()
      })
      req.pipe(upstream)
    }

    if (!rule) {
      forward()
      return
    }
    if (rule.hold) {
      // Held: the request is fully read, the CLIENT's connection fails at once (its answer is lost),
      // and the request reaches the backend only when the journey releases it — so the original is
      // genuinely still "in flight" while the client resolves its outcome.
      if (rule.times !== undefined) rule.times -= 1
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        req.socket.destroy()
        rule.hold.captured(
          () =>
            new Promise((resolve) => {
              const upstream = httpRequest(
                {
                  host: target.hostname,
                  port: target.port,
                  method: req.method,
                  path: req.url,
                  headers: preserveHost ? req.headers : { ...req.headers, host: target.host }
                },
                (up) => {
                  const body = []
                  up.on('data', (chunk) => body.push(chunk))
                  up.on('end', () =>
                    resolve({
                      status: up.statusCode,
                      headers: up.headers,
                      body: Buffer.concat(body).toString('utf8')
                    })
                  )
                }
              )
              upstream.on('error', (error) => resolve({ status: 0, error: String(error) }))
              upstream.end(Buffer.concat(chunks))
            })
        )
      })
      return
    }
    if (rule.times !== undefined) rule.times -= 1

    const act = () => {
      if (rule.drop) {
        req.socket.destroy()
        return
      }
      if (rule.status) {
        req.resume()
        const body = JSON.stringify({
          success: false,
          message: 'Injected by the Playwright proxy',
          code: rule.code ?? 'SERVER_ERROR',
          errors: {},
          meta: { trace_id: 'playwright-proxy' }
        })
        res.writeHead(rule.status, {
          'content-type': 'application/json',
          ...(rule.retryAfter ? { 'retry-after': String(rule.retryAfter) } : {})
        })
        res.end(body)
        return
      }
      forward()
    }

    if (rule.delayMs) {
      setTimeout(act, rule.delayMs)
    } else {
      act()
    }
  }

  const listen = async () =>
    await new Promise((resolve) => {
      server = createServer(handler)
      server.listen(listenPort, '127.0.0.1', resolve)
    })

  await listen()

  return {
    origin: `http://127.0.0.1:${listenPort}`,
    port: listenPort,
    log,
    rule(label, match, action) {
      rules.push({ label, match, ...action })
    },
    /**
     * Holds the next request matching `match`: the client sees a dropped connection immediately, and
     * the held request is sent to the backend only on `release()`, which resolves with the backend's
     * answer (never delivered to the client).
     */
    hold(label, match) {
      let forward = null
      let markCaptured
      const captured = new Promise((resolve) => (markCaptured = resolve))
      rules.push({
        label,
        match,
        times: 1,
        hold: {
          captured(send) {
            forward = send
            markCaptured()
          }
        }
      })
      return {
        captured,
        async release() {
          await captured
          return await forward()
        }
      }
    },
    clear(label) {
      for (let i = rules.length - 1; i >= 0; i -= 1) {
        if (!label || rules[i].label === label) rules.splice(i, 1)
      }
    },
    requests(pattern) {
      return log.filter((entry) => pattern.test(entry.line))
    },
    async offline() {
      if (!server) return
      await new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
      server = null
    },
    async online() {
      if (server) return
      await listen()
    },
    async stop() {
      await this.offline()
    }
  }
}
