/**
 * An HTTPS front for the disposable backend, so a RELEASE-configured package (an `https://` API
 * origin, no loopback opt-in) can run its real journey.
 *
 * - `createTestCa(dir)`: a throwaway CA and a `localhost` / 127.0.0.1 server certificate (openssl),
 *   written inside the run directory only.
 * - `trustInIsolatedNss(homeDir, caPem)`: an NSS database at `<homeDir>/.pki/nssdb` that trusts the
 *   throwaway CA. Chromium on Linux reads user trust from `$HOME/.pki/nssdb`, so the packaged app is
 *   launched with HOME=<homeDir>. `certutil` runs in a disposable ubuntu:24.04 container (the host
 *   needs no extra package); the files are handed back to the current user. The real home, the host
 *   trust store and the system certificates are never touched.
 * - `startTlsProxy(target, { port, key, cert })`: an HTTPS server that forwards every request to the
 *   plain-HTTP sandbox, and records the request lines it served.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}):\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

export function createTestCa(dir) {
  mkdirSync(dir, { recursive: true })
  const path = (name) => join(dir, name)
  writeFileSync(
    path('server.ext'),
    'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n' +
      'extendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n'
  )
  run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=Thinis POS journey throwaway CA',
    '-keyout',
    path('ca.key'),
    '-out',
    path('ca.pem')
  ])
  run('openssl', [
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=localhost',
    '-keyout',
    path('server.key'),
    '-out',
    path('server.csr')
  ])
  run('openssl', [
    'x509',
    '-req',
    '-in',
    path('server.csr'),
    '-CA',
    path('ca.pem'),
    '-CAkey',
    path('ca.key'),
    '-CAcreateserial',
    '-days',
    '2',
    '-extfile',
    path('server.ext'),
    '-out',
    path('server.pem')
  ])
  return {
    caPem: path('ca.pem'),
    key: readFileSync(path('server.key')),
    cert: readFileSync(path('server.pem'))
  }
}

export function trustInIsolatedNss(homeDir, caPem) {
  if (homeDir === process.env.HOME || homeDir.includes('/.config/pos-desktop')) {
    throw new Error('refusing to change a real home or profile')
  }
  mkdirSync(join(homeDir, '.pki', 'nssdb'), { recursive: true })
  const uid = `${process.getuid()}:${process.getgid()}`
  run('docker', [
    'run',
    '--rm',
    '-v',
    `${join(homeDir, '.pki', 'nssdb')}:/nssdb`,
    '-v',
    `${caPem}:/ca.pem:ro`,
    'ubuntu:24.04',
    'bash',
    '-c',
    'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null && ' +
      'apt-get install -y -qq libnss3-tools >/dev/null && ' +
      'certutil -N -d sql:/nssdb --empty-password && ' +
      "certutil -A -d sql:/nssdb -n 'Thinis POS journey throwaway CA' -t 'C,,' -i /ca.pem && " +
      `certutil -L -d sql:/nssdb && chown -R ${uid} /nssdb`
  ])
}

export async function startTlsProxy(targetOrigin, { port, key, cert }) {
  const target = new URL(targetOrigin)
  const served = []
  const server = createServer({ key, cert }, (req, res) => {
    served.push(`${req.method} ${req.url}`)
    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: target.host }
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      }
    )
    upstream.on('error', () => {
      res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    origin: `https://localhost:${port}`,
    served,
    async stop() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(() => resolve()))
    }
  }
}
