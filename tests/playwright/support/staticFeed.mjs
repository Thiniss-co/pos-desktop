/**
 * An isolated, local update feed for the packaged upgrade journey: serves the files of one directory
 * (an AppImage and its latest-linux.yml) over loopback HTTP and records what was requested. Never a
 * production feed; the test package accepts it only through its loopback opt-in.
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, join } from 'node:path'

export async function startStaticFeed(dir, port) {
  const requests = []
  const server = createServer((req, res) => {
    const name = basename(decodeURIComponent(new URL(req.url, 'http://feed').pathname))
    requests.push(`${req.method} /${name}`)
    const file = join(dir, name)
    if (!name || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-length': statSync(file).size })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(file).pipe(res)
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    async stop() {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(() => resolve()))
    }
  }
}
