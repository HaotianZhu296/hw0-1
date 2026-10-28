// HTTP static file server + WebSocket endpoint for online play.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager } from './server/rooms.js';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

async function serveStatic(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  let relative;
  try {
    relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  const file = join(PUBLIC_DIR, relative || 'index.html');
  if (!file.startsWith(PUBLIC_DIR) || file.split(sep).includes('..')) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}

export function startServer({ port = 3000, host } = {}) {
  const manager = new RoomManager();
  const server = createServer((req, res) => {
    serveStatic(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 });

  wss.on('connection', (ws) => {
    const conn = {
      send(message) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
      },
    };
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return conn.send({ type: 'error', message: 'Malformed message.' });
      }
      manager.handle(conn, msg);
    });
    ws.on('close', () => manager.disconnect(conn));
    ws.on('error', () => ws.terminate());
  });

  // Drop dead connections and stale rooms.
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    manager.sweep();
  }, 30_000);
  timer.unref();

  server.on('close', () => clearInterval(timer));

  return new Promise((resolve) => {
    server.listen(port, host, () => resolve({ server, wss, manager, port: server.address().port }));
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (isMain) {
  const { port } = await startServer({ port: Number(process.env.PORT) || 3000 });
  console.log(`Tic Tac Toe running at http://localhost:${port}`);
}
