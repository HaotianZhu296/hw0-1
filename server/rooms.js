// Room, seat and matchmaking logic for online games.
// A "connection" is any object with a send(message) method, so this module
// can be unit-tested without real sockets.
import { emptyBoard, evaluate, isValidMove, other } from '../public/js/game.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const CODE_LENGTH = 5;
const MAX_NAME = 20;
const MAX_CHAT = 200;
const CHAT_HISTORY = 50;
export const ROOM_IDLE_MS = 10 * 60 * 1000;

export const cleanName = (name, fallback = 'Player') => {
  const trimmed = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return trimmed || fallback;
};

export const normalizeCode = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

class Room {
  constructor(code) {
    this.code = code;
    this.seats = { X: null, O: null }; // { clientId, name, conn }
    this.spectators = new Map();       // conn -> name
    this.scores = { X: 0, O: 0, draw: 0 };
    this.starter = 'X';
    this.chat = [];
    this.lastActive = Date.now();
    this.resetBoard();
  }

  resetBoard() {
    this.board = emptyBoard();
    this.moves = [];
    this.turn = this.starter;
    this.winner = null;
    this.line = null;
    this.reason = null;
    this.rematch = { X: false, O: false };
  }

  get ready() {
    return Boolean(this.seats.X && this.seats.O);
  }

  get moveCount() {
    return this.board.filter(Boolean).length;
  }

  connections() {
    const conns = [...this.spectators.keys()];
    for (const seat of Object.values(this.seats)) if (seat?.conn) conns.push(seat.conn);
    return conns;
  }

  markOf(conn) {
    if (this.seats.X?.conn === conn) return 'X';
    if (this.seats.O?.conn === conn) return 'O';
    return null;
  }

  isEmpty() {
    return this.connections().length === 0;
  }

  snapshot(role) {
    const seat = (mark) => this.seats[mark] && {
      name: this.seats[mark].name,
      connected: Boolean(this.seats[mark].conn),
    };
    return {
      type: 'state',
      code: this.code,
      role,
      board: this.board,
      moves: this.moves,
      turn: this.turn,
      winner: this.winner,
      line: this.line,
      reason: this.reason,
      ready: this.ready,
      players: { X: seat('X'), O: seat('O') },
      spectators: this.spectators.size,
      scores: this.scores,
      rematch: this.rematch,
    };
  }

  broadcast() {
    this.lastActive = Date.now();
    for (const mark of ['X', 'O']) this.seats[mark]?.conn?.send(this.snapshot(mark));
    for (const conn of this.spectators.keys()) conn.send(this.snapshot('spectator'));
  }

  say(entry) {
    const message = { type: 'chat', at: Date.now(), ...entry };
    this.chat.push(message);
    if (this.chat.length > CHAT_HISTORY) this.chat.shift();
    for (const conn of this.connections()) conn.send(message);
  }

  system(text) {
    this.say({ system: true, text });
  }
}

export class RoomManager {
  constructor({ random = Math.random } = {}) {
    this.random = random;
    this.rooms = new Map();
    this.connRoom = new Map(); // conn -> Room
    this.queue = [];           // [{ conn, name, clientId }]
  }

  // ---- public entry point -------------------------------------------------

  handle(conn, msg) {
    if (!msg || typeof msg !== 'object') return this.error(conn, 'Malformed message.');
    switch (msg.type) {
      case 'create': return this.create(conn, msg);
      case 'join': return this.join(conn, msg);
      case 'quick': return this.quickMatch(conn, msg);
      case 'cancelQuick': return this.cancelQuick(conn);
      case 'move': return this.move(conn, msg.index);
      case 'rematch': return this.requestRematch(conn);
      case 'chat': return this.chatMessage(conn, msg.text);
      case 'leave': return this.leave(conn);
      default: return this.error(conn, `Unknown message type "${msg.type}".`);
    }
  }

  disconnect(conn) {
    this.cancelQuick(conn);
    const room = this.connRoom.get(conn);
    if (!room) return;
    this.connRoom.delete(conn);
    if (room.spectators.delete(conn)) return room.broadcast();
    const mark = room.markOf(conn);
    if (mark) {
      // Keep the seat so the same client can reconnect and resume.
      room.seats[mark].conn = null;
      room.system(`${room.seats[mark].name} disconnected.`);
      room.broadcast();
    }
  }

  /** Removes rooms that have had nobody connected for a while. */
  sweep(now = Date.now()) {
    for (const [code, room] of this.rooms) {
      if (room.isEmpty() && now - room.lastActive > ROOM_IDLE_MS) this.rooms.delete(code);
    }
  }

  // ---- handlers -----------------------------------------------------------

  create(conn, { name, clientId }) {
    this.cancelQuick(conn);
    this.detach(conn);
    const room = new Room(this.newCode());
    this.rooms.set(room.code, room);
    this.seat(room, 'X', conn, name, clientId);
    room.broadcast();
    return room;
  }

  join(conn, { code, name, clientId }) {
    const room = this.rooms.get(normalizeCode(code));
    if (!room) return this.error(conn, 'Room not found. Check the code and try again.');
    if (this.connRoom.get(conn) === room) return room.broadcast();
    this.cancelQuick(conn);
    this.detach(conn);

    // Reconnect: the same client reclaims its old seat.
    const mine = ['X', 'O'].find((m) => clientId && room.seats[m]?.clientId === clientId);
    if (mine) {
      const previous = room.seats[mine].conn;
      if (previous && previous !== conn) {
        this.connRoom.delete(previous);
        previous.send({ type: 'kicked', message: 'You opened this game somewhere else.' });
      }
      room.seats[mine].conn = conn;
      room.seats[mine].name = cleanName(name, room.seats[mine].name);
      this.connRoom.set(conn, room);
      this.sendHistory(room, conn);
      room.system(`${room.seats[mine].name} reconnected.`);
      room.broadcast();
      return room;
    }

    const free = ['X', 'O'].find((m) => !room.seats[m]);
    if (free) {
      this.seat(room, free, conn, name, clientId);
      // A new opponent means a fresh match.
      room.scores = { X: 0, O: 0, draw: 0 };
      room.starter = 'X';
      room.resetBoard();
      room.broadcast();
      return room;
    }

    room.spectators.set(conn, cleanName(name, 'Spectator'));
    this.connRoom.set(conn, room);
    this.sendHistory(room, conn);
    room.system(`${room.spectators.get(conn)} is watching.`);
    room.broadcast();
    return room;
  }

  quickMatch(conn, { name, clientId }) {
    this.detach(conn);
    this.cancelQuick(conn);
    const opponent = this.queue.shift();
    if (!opponent) {
      this.queue.push({ conn, name, clientId });
      conn.send({ type: 'queued' });
      return null;
    }
    const room = new Room(this.newCode());
    this.rooms.set(room.code, room);
    // Randomise who plays X (and therefore moves first).
    const [first, second] = this.random() < 0.5
      ? [opponent, { conn, name, clientId }]
      : [{ conn, name, clientId }, opponent];
    this.seat(room, 'X', first.conn, first.name, first.clientId);
    this.seat(room, 'O', second.conn, second.name, second.clientId);
    room.broadcast();
    return room;
  }

  cancelQuick(conn) {
    this.queue = this.queue.filter((entry) => entry.conn !== conn);
  }

  move(conn, index) {
    const room = this.connRoom.get(conn);
    if (!room) return this.error(conn, 'You are not in a room.');
    const mark = room.markOf(conn);
    if (!mark) return this.error(conn, 'Spectators cannot move.');
    if (!room.ready) return this.error(conn, 'Waiting for an opponent to join.');
    if (room.winner) return this.error(conn, 'The game is over.');
    if (room.turn !== mark) return this.error(conn, 'It is not your turn.');
    if (!isValidMove(room.board, index)) return this.error(conn, 'That square is not available.');

    room.board[index] = mark;
    room.moves.push({ mark, index });
    const { winner, line } = evaluate(room.board);
    if (winner) {
      room.winner = winner;
      room.line = line;
      room.scores[winner] += 1;
    } else {
      room.turn = other(mark);
    }
    room.broadcast();
  }

  requestRematch(conn) {
    const room = this.connRoom.get(conn);
    const mark = room?.markOf(conn);
    if (!mark) return this.error(conn, 'Only players can request a rematch.');
    if (!room.winner) return this.error(conn, 'The game is still in progress.');
    room.rematch[mark] = true;
    if (room.rematch.X && room.rematch.O) {
      room.starter = other(room.starter); // alternate who goes first
      room.resetBoard();
      room.system(`New round — ${room.seats[room.starter].name} (${room.starter}) starts.`);
    }
    room.broadcast();
  }

  chatMessage(conn, text) {
    const room = this.connRoom.get(conn);
    if (!room) return this.error(conn, 'You are not in a room.');
    const clean = String(text ?? '').trim().slice(0, MAX_CHAT);
    if (!clean) return;
    const mark = room.markOf(conn);
    const name = mark ? room.seats[mark].name : room.spectators.get(conn);
    room.say({ from: name, mark: mark ?? 'spectator', text: clean });
  }

  leave(conn) {
    this.cancelQuick(conn);
    this.detach(conn);
    conn.send({ type: 'left' });
  }

  // ---- helpers ------------------------------------------------------------

  /** Removes a connection from its current room, freeing its seat for good. */
  detach(conn) {
    const room = this.connRoom.get(conn);
    if (!room) return;
    this.connRoom.delete(conn);
    if (room.spectators.delete(conn)) return room.broadcast();

    const mark = room.markOf(conn);
    if (!mark) return;
    const { name } = room.seats[mark];
    room.seats[mark] = null;
    if (!room.winner && room.moveCount > 0 && room.seats[other(mark)]) {
      room.winner = other(mark);
      room.reason = 'forfeit';
      room.scores[room.winner] += 1;
    }
    room.rematch = { X: false, O: false };
    room.system(`${name} left the room.`);
    if (room.isEmpty()) this.rooms.delete(room.code);
    else room.broadcast();
  }

  seat(room, mark, conn, name, clientId) {
    room.seats[mark] = { clientId: clientId ? String(clientId).slice(0, 64) : null, name: cleanName(name), conn };
    this.connRoom.set(conn, room);
    this.sendHistory(room, conn);
    room.system(`${room.seats[mark].name} joined as ${mark}.`);
  }

  sendHistory(room, conn) {
    for (const message of room.chat) conn.send(message);
  }

  newCode() {
    let code;
    do {
      code = Array.from({ length: CODE_LENGTH },
        () => CODE_ALPHABET[Math.floor(this.random() * CODE_ALPHABET.length)]).join('');
    } while (this.rooms.has(code));
    return code;
  }

  error(conn, message) {
    conn.send({ type: 'error', message });
    return null;
  }
}
