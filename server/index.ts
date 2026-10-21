import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { WebSocketServer } from 'ws'
import { Hub } from './hub.ts'
import { Store } from './store.ts'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

export function startServer(options: { port: number; dbPath?: string; staticDir?: string }) {
  const store = new Store(options.dbPath)
  const hub = new Hub(store)
  const root = options.staticDir

  const serveStatic = (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
      return
    }
    if (!root) {
      res.writeHead(404).end()
      return
    }
    // Every /r/<room> path is the same single-page app.
    const path = new URL(req.url ?? '/', 'http://x').pathname
    let file = normalize(join(root, path === '/' || path.startsWith('/r/') ? 'index.html' : path))
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html')
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  }

  const http = createServer(serveStatic)
  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 64 * 1024 })
  wss.on('connection', (socket) => hub.connect(socket))

  // Drop connections that stopped answering pings (laptop lid closed, Wi-Fi gone).
  const alive = new WeakSet<object>()
  wss.on('connection', (socket) => {
    alive.add(socket)
    socket.on('pong', () => alive.add(socket))
  })
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!alive.has(socket)) {
        socket.terminate()
        continue
      }
      alive.delete(socket)
      socket.ping()
    }
  }, 30_000)

  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    http.listen(options.port, () => {
      const address = http.address()
      resolve({
        port: typeof address === 'object' && address ? address.port : options.port,
        close: () =>
          new Promise((done) => {
            clearInterval(heartbeat)
            for (const s of wss.clients) s.terminate()
            wss.close()
            http.close(() => {
              store.close()
              done()
            })
          }),
      })
    })
  })
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8080)
  const { port: actual } = await startServer({
    port,
    dbPath: process.env.DB_PATH ?? 'chat.db',
    staticDir: new URL('../dist', import.meta.url).pathname,
  })
  console.log(`http://localhost:${actual}`)
}
