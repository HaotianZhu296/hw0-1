import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../server.js';

let app;
let base;

before(async () => {
  app = await startServer({ port: 0, host: '127.0.0.1' });
  base = `127.0.0.1:${app.port}`;
});

after(() => {
  for (const ws of app.wss.clients) ws.terminate();
  app.wss.close();
  app.server.close();
});

function client() {
  const ws = new WebSocket(`ws://${base}/ws`);
  const messages = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    messages.push(msg);
    for (const w of waiters.splice(0)) w();
  });
  return {
    ws,
    open: () => new Promise((resolve) => ws.once('open', resolve)),
    send: (msg) => ws.send(JSON.stringify(msg)),
    /** Resolves with the first message (old or new) that matches. */
    async waitFor(pred, seen = 0) {
      for (;;) {
        const found = messages.slice(seen).find(pred);
        if (found) return found;
        seen = messages.length;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timed out')), 2000);
          waiters.push(() => { clearTimeout(timer); resolve(); });
        });
      }
    },
    get count() { return messages.length; },
  };
}

test('serves the app and static files', async () => {
  const html = await fetch(`http://${base}/`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.match(await html.text(), /Tic Tac Toe/);

  const js = await fetch(`http://${base}/js/game.js`);
  assert.match(js.headers.get('content-type'), /javascript/);

  assert.equal((await fetch(`http://${base}/healthz`)).status, 200);
  assert.equal((await fetch(`http://${base}/missing.txt`)).status, 404);
  assert.notEqual((await fetch(`http://${base}/..%2fpackage.json`)).status, 200);
});

test('two clients play a full game over WebSocket', async () => {
  const alice = client();
  const bob = client();
  await Promise.all([alice.open(), bob.open()]);

  alice.send({ type: 'create', name: 'Alice', clientId: 'alice' });
  const created = await alice.waitFor((m) => m.type === 'state');
  bob.send({ type: 'join', code: created.code, name: 'Bob', clientId: 'bob' });
  await bob.waitFor((m) => m.type === 'state' && m.ready);

  const moves = [[alice, 4], [bob, 0], [alice, 2], [bob, 6], [alice, 3], [bob, 5], [alice, 1], [bob, 7], [alice, 8]];
  for (const [player, index] of moves) {
    const seen = alice.count;
    player.send({ type: 'move', index });
    await alice.waitFor((m) => m.type === 'state' && m.board[index], seen);
  }
  // O X X / X X O / O O X — a full board with no line.
  const final = await bob.waitFor((m) => m.type === 'state' && m.winner);
  assert.equal(final.winner, 'draw');
  assert.equal(final.scores.draw, 1);

  alice.send({ type: 'chat', text: 'gg' });
  const chat = await bob.waitFor((m) => m.type === 'chat' && m.text === 'gg');
  assert.equal(chat.from, 'Alice');

  alice.ws.close();
  bob.ws.close();
});

test('a reconnecting client resumes its seat', async () => {
  const alice = client();
  const bob = client();
  await Promise.all([alice.open(), bob.open()]);
  alice.send({ type: 'create', name: 'Alice', clientId: 'a2' });
  const { code } = await alice.waitFor((m) => m.type === 'state');
  bob.send({ type: 'join', code, name: 'Bob', clientId: 'b2' });
  await alice.waitFor((m) => m.type === 'state' && m.ready);
  alice.send({ type: 'move', index: 0 });
  await bob.waitFor((m) => m.type === 'state' && m.board[0] === 'X');

  bob.ws.close();
  await alice.waitFor((m) => m.type === 'state' && m.players.O && !m.players.O.connected);

  const bob2 = client();
  await bob2.open();
  bob2.send({ type: 'join', code, name: 'Bob', clientId: 'b2' });
  const resumed = await bob2.waitFor((m) => m.type === 'state');
  assert.equal(resumed.role, 'O');
  assert.equal(resumed.board[0], 'X');
  assert.equal(resumed.turn, 'O');

  alice.ws.close();
  bob2.ws.close();
});

test('invalid JSON gets an error instead of crashing the server', async () => {
  const c = client();
  await c.open();
  c.ws.send('{not json');
  const err = await c.waitFor((m) => m.type === 'error');
  assert.match(err.message, /Malformed/);
  c.ws.close();
});
