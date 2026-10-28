import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager, ROOM_IDLE_MS } from '../server/rooms.js';

function fakeConn() {
  const inbox = [];
  return {
    inbox,
    send: (msg) => inbox.push(msg),
    last: (type) => inbox.filter((m) => m.type === type).at(-1),
  };
}

function setup() {
  const manager = new RoomManager();
  const a = fakeConn();
  const b = fakeConn();
  manager.handle(a, { type: 'create', name: 'Alice', clientId: 'a' });
  const { code } = a.last('state');
  manager.handle(b, { type: 'join', code, name: 'Bob', clientId: 'b' });
  return { manager, a, b, code };
}

const play = (manager, conn, index) => manager.handle(conn, { type: 'move', index });

test('creator is X, joiner is O, game becomes ready', () => {
  const { a, b, code } = setup();
  assert.match(code, /^[A-Z2-9]{5}$/);
  assert.equal(a.last('state').role, 'X');
  assert.equal(b.last('state').role, 'O');
  assert.equal(a.last('state').ready, true);
  assert.deepEqual(a.last('state').players.O, { name: 'Bob', connected: true });
});

test('join is case-insensitive and rejects unknown rooms', () => {
  const manager = new RoomManager();
  const a = fakeConn();
  const b = fakeConn();
  const c = fakeConn();
  manager.handle(a, { type: 'create', name: 'A' });
  manager.handle(b, { type: 'join', code: a.last('state').code.toLowerCase(), name: 'B' });
  assert.equal(b.last('state').role, 'O');
  manager.handle(c, { type: 'join', code: 'ZZZZZ' });
  assert.match(c.last('error').message, /not found/);
});

test('enforces turns, occupied squares and waiting for opponent', () => {
  const manager = new RoomManager();
  const a = fakeConn();
  manager.handle(a, { type: 'create', name: 'A' });
  play(manager, a, 0);
  assert.match(a.last('error').message, /Waiting/);

  const { manager: m, a: x, b: o } = setup();
  play(m, o, 0);
  assert.match(o.last('error').message, /not your turn/);
  play(m, x, 4);
  play(m, o, 4);
  assert.match(o.last('error').message, /not available/);
  play(m, o, 'hack');
  assert.match(o.last('error').message, /not available/);
  assert.deepEqual(x.last('state').board.filter(Boolean), ['X']);
});

test('detects a win, updates scores and blocks further moves', () => {
  const { manager, a, b } = setup();
  for (const [conn, i] of [[a, 0], [b, 3], [a, 1], [b, 4], [a, 2]]) play(manager, conn, i);
  const state = b.last('state');
  assert.equal(state.winner, 'X');
  assert.deepEqual(state.line, [0, 1, 2]);
  assert.deepEqual(state.scores, { X: 1, O: 0, draw: 0 });
  assert.equal(state.moves.length, 5);
  play(manager, b, 8);
  assert.match(b.last('error').message, /over/);
});

test('rematch needs both players and alternates the starting player', () => {
  const { manager, a, b } = setup();
  for (const [conn, i] of [[a, 0], [b, 3], [a, 1], [b, 4], [a, 2]]) play(manager, conn, i);
  manager.handle(a, { type: 'rematch' });
  assert.equal(a.last('state').winner, 'X');
  assert.deepEqual(a.last('state').rematch, { X: true, O: false });
  manager.handle(b, { type: 'rematch' });
  const state = a.last('state');
  assert.equal(state.winner, null);
  assert.equal(state.turn, 'O');
  assert.deepEqual(state.board, Array(9).fill(null));
  assert.equal(state.scores.X, 1);
});

test('draws are counted', () => {
  const { manager, a, b } = setup();
  // X O X / X O O / O X X
  for (const [conn, i] of [[a, 0], [b, 1], [a, 2], [b, 4], [a, 3], [b, 5], [a, 7], [b, 6], [a, 8]]) {
    play(manager, conn, i);
  }
  assert.equal(a.last('state').winner, 'draw');
  assert.equal(a.last('state').scores.draw, 1);
});

test('disconnect keeps the seat and the same client can resume', () => {
  const { manager, a, b, code } = setup();
  play(manager, a, 4);
  manager.disconnect(b);
  assert.equal(a.last('state').players.O.connected, false);

  const b2 = fakeConn();
  manager.handle(b2, { type: 'join', code, name: 'Bob', clientId: 'b' });
  const state = b2.last('state');
  assert.equal(state.role, 'O');
  assert.equal(state.board[4], 'X');
  assert.equal(a.last('state').players.O.connected, true);
  play(manager, b2, 0);
  assert.equal(a.last('state').board[0], 'O');
});

test('a third client becomes a spectator and cannot move', () => {
  const { manager, a, code } = setup();
  const c = fakeConn();
  manager.handle(c, { type: 'join', code, name: 'Carol', clientId: 'c' });
  assert.equal(c.last('state').role, 'spectator');
  assert.equal(a.last('state').spectators, 1);
  play(manager, c, 0);
  assert.match(c.last('error').message, /Spectators/);
});

test('leaving mid-game forfeits and frees the seat for a new opponent', () => {
  const { manager, a, b, code } = setup();
  play(manager, a, 0);
  manager.handle(b, { type: 'leave' });
  assert.equal(b.last('left').type, 'left');
  let state = a.last('state');
  assert.equal(state.winner, 'X');
  assert.equal(state.reason, 'forfeit');
  assert.equal(state.players.O, null);

  const d = fakeConn();
  manager.handle(d, { type: 'join', code, name: 'Dan', clientId: 'd' });
  state = a.last('state');
  assert.equal(d.last('state').role, 'O');
  assert.equal(state.winner, null);
  assert.deepEqual(state.scores, { X: 0, O: 0, draw: 0 });
});

test('room is deleted when everyone leaves', () => {
  const { manager, a, b, code } = setup();
  manager.handle(a, { type: 'leave' });
  manager.handle(b, { type: 'leave' });
  assert.equal(manager.rooms.has(code), false);
});

test('idle rooms with no connections are swept', () => {
  const { manager, a, b, code } = setup();
  manager.disconnect(a);
  manager.disconnect(b);
  manager.sweep(Date.now());
  assert.equal(manager.rooms.has(code), true);
  manager.sweep(Date.now() + ROOM_IDLE_MS + 1);
  assert.equal(manager.rooms.has(code), false);
});

test('quick match pairs two waiting players and supports cancel', () => {
  const manager = new RoomManager();
  const a = fakeConn();
  const b = fakeConn();
  const c = fakeConn();
  manager.handle(a, { type: 'quick', name: 'A' });
  assert.ok(a.last('queued'));
  manager.handle(a, { type: 'cancelQuick' });
  manager.handle(b, { type: 'quick', name: 'B' });
  assert.equal(b.last('state'), undefined);
  manager.handle(c, { type: 'quick', name: 'C' });
  const roles = [b.last('state').role, c.last('state').role].sort();
  assert.deepEqual(roles, ['O', 'X']);
  assert.equal(b.last('state').code, c.last('state').code);
  assert.equal(a.last('state'), undefined);
});

test('chat is broadcast, trimmed and length-limited', () => {
  const { manager, a, b } = setup();
  manager.handle(a, { type: 'chat', text: `  ${'x'.repeat(500)}  ` });
  const msg = b.last('chat');
  assert.equal(msg.from, 'Alice');
  assert.equal(msg.mark, 'X');
  assert.equal(msg.text.length, 200);
  const before = b.inbox.length;
  manager.handle(a, { type: 'chat', text: '   ' });
  assert.equal(b.inbox.length, before);
});

test('names are sanitised and malformed messages are rejected', () => {
  const manager = new RoomManager();
  const a = fakeConn();
  manager.handle(a, { type: 'create', name: `   ${'N'.repeat(40)}  ` });
  assert.equal(a.last('state').players.X.name.length, 20);
  manager.handle(a, null);
  manager.handle(a, { type: 'nope' });
  assert.equal(a.inbox.filter((m) => m.type === 'error').length, 2);
});
