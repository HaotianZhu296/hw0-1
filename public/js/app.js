import { emptyBoard, evaluate, other } from './game.js';
import { chooseMove, bestMove, DIFFICULTIES } from './ai.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Storage helpers (storage can be unavailable in private windows)
// ---------------------------------------------------------------------------

const safe = (fn, fallback) => {
  try { return fn(); } catch { return fallback; }
};
const local = {
  get: (key, fallback) => safe(() => JSON.parse(localStorage.getItem(key)) ?? fallback, fallback),
  set: (key, value) => safe(() => localStorage.setItem(key, JSON.stringify(value))),
};
const session = {
  get: (key) => safe(() => sessionStorage.getItem(key), null),
  set: (key, value) => safe(() => sessionStorage.setItem(key, value)),
  remove: (key) => safe(() => sessionStorage.removeItem(key)),
};

// ---------------------------------------------------------------------------
// Theme, sound, toast
// ---------------------------------------------------------------------------

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
applyTheme(local.get('theme', null));
$('theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme
    ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  local.set('theme', next);
});

let soundOn = local.get('sound', true);
let audio;
function renderSoundToggle() {
  $('sound-toggle').textContent = soundOn ? '🔊' : '🔇';
  $('sound-toggle').setAttribute('aria-pressed', String(soundOn));
}
renderSoundToggle();
$('sound-toggle').addEventListener('click', () => {
  soundOn = !soundOn;
  local.set('sound', soundOn);
  renderSoundToggle();
});

function tone(notes) {
  if (!soundOn) return;
  safe(() => {
    audio ??= new AudioContext();
    let t = audio.currentTime;
    for (const [freq, duration] of notes) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.12, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
      osc.connect(gain).connect(audio.destination);
      osc.start(t);
      osc.stop(t + duration);
      t += duration * 0.8;
    }
  });
}
const sounds = {
  X: () => tone([[620, 0.08]]),
  O: () => tone([[440, 0.08]]),
  win: () => tone([[523, 0.12], [659, 0.12], [784, 0.22]]),
  lose: () => tone([[392, 0.15], [311, 0.25]]),
  draw: () => tone([[440, 0.12], [440, 0.12]]),
};

let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
}

// ---------------------------------------------------------------------------
// Board rendering (shared by every mode)
// ---------------------------------------------------------------------------

const boardEl = $('board');
const cells = Array.from({ length: 9 }, (_, i) => {
  const cell = document.createElement('button');
  cell.type = 'button';
  cell.className = 'cell';
  cell.dataset.index = i;
  cell.setAttribute('role', 'gridcell');
  boardEl.append(cell);
  return cell;
});
let shownBoard = emptyBoard();

const cellName = (i) => `row ${Math.floor(i / 3) + 1}, column ${(i % 3) + 1}`;

/**
 * view: { board, turn, winner, line, canMove, ghost, names, scores, status, moves }
 */
function render(view) {
  const { board, winner, line, canMove } = view;
  boardEl.classList.toggle('can-move', canMove);
  cells.forEach((cell, i) => {
    const mark = board[i];
    const placed = mark && shownBoard[i] !== mark;
    cell.className = 'cell';
    if (mark) cell.classList.add(mark.toLowerCase());
    if (placed) cell.classList.add('placed');
    if (line?.includes(i)) cell.classList.add('win');
    cell.disabled = Boolean(mark || winner || !canMove);
    if (mark) cell.innerHTML = `<span>${mark}</span>`;
    else cell.innerHTML = canMove && view.ghost ? `<span class="ghost-mark">${view.ghost}</span>` : '';
    cell.setAttribute('aria-label', `${cellName(i)}: ${mark ?? 'empty'}`);
  });
  shownBoard = board.slice();

  for (const mark of ['X', 'O']) {
    $(`name-${mark}`).textContent = view.names[mark];
    $(`score-${mark}`).textContent = view.scores[mark];
    document.querySelector(`.score[data-mark="${mark}"]`)
      .classList.toggle('active', !winner && view.turn === mark);
  }
  $('score-draw').textContent = view.scores.draw;
  $('status').textContent = view.status;

  $('history').innerHTML = view.moves
    .map(({ mark, index }) => `<li><strong class="score-mark ${mark.toLowerCase()}">${mark}</strong> → ${cellName(index)}</li>`)
    .join('');
  $('history').scrollTop = $('history').scrollHeight;
}

function showHint(index) {
  if (index == null) return;
  cells[index].classList.add('hint');
  setTimeout(() => cells[index].classList.remove('hint'), 1200);
}

/** Plays the right sound for a state change from `before` to `after`. */
function soundFor(before, after, myMark) {
  if (after.winner && !before.winner) {
    if (after.winner === 'draw') sounds.draw();
    else if (!myMark || after.winner === myMark) sounds.win();
    else sounds.lose();
    return;
  }
  const placed = after.board.find((mark, i) => mark && !before.board[i]);
  if (placed) sounds[placed]();
}

// ---------------------------------------------------------------------------
// Screens and controls
// ---------------------------------------------------------------------------

function showScreen(name) {
  for (const screen of document.querySelectorAll('.screen')) {
    screen.hidden = screen.id !== `screen-${name}`;
  }
}

const controls = ['new-game', 'undo', 'hint', 'rematch', 'reset-scores'];
function setControls(config) {
  for (const id of controls) {
    const state = config[id];
    $(id).hidden = !state;
    if (state) {
      $(id).disabled = state === 'disabled';
      if (typeof state === 'object') {
        $(id).textContent = state.label;
        $(id).disabled = Boolean(state.disabled);
      }
    }
  }
}

function setPanels(mode) {
  $('ai-panel').hidden = mode !== 'ai';
  $('online-panel').hidden = mode !== 'online';
}

function bindSegmented(id, value, onChange) {
  const group = $(id);
  const sync = (v) => {
    for (const btn of group.querySelectorAll('button')) {
      btn.setAttribute('aria-checked', String(btn.dataset.value === v));
    }
  };
  sync(value);
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (!btn) return;
    sync(btn.dataset.value);
    onChange(btn.dataset.value);
  });
}

let mode = null; // current controller

function startMode(controller) {
  mode?.stop?.();
  mode = controller;
  setPanels(controller.name);
  controller.start();
}

// ---------------------------------------------------------------------------
// Player vs Computer
// ---------------------------------------------------------------------------

const AI_HELP = {
  easy: 'Easy mostly plays random squares — a good warm-up.',
  medium: 'Medium always wins or blocks when it can, but can be beaten with a fork.',
  hard: 'Hard uses minimax with alpha-beta pruning — the best you can do is draw.',
};

const aiMode = {
  name: 'ai',
  difficulty: DIFFICULTIES.includes(local.get('ai-difficulty')) ? local.get('ai-difficulty') : 'hard',
  human: local.get('ai-mark') === 'O' ? 'O' : 'X',
  scores: local.get('ai-scores', {}), // { [difficulty]: { you, cpu, draw } }
  board: emptyBoard(),
  moves: [],
  thinking: null,

  get cpu() { return other(this.human); },
  get record() {
    this.scores[this.difficulty] ??= { you: 0, cpu: 0, draw: 0 };
    return this.scores[this.difficulty];
  },
  get result() { return evaluate(this.board); },
  get turn() { return this.moves.length % 2 === 0 ? 'X' : 'O'; },

  start() {
    showScreen('game');
    this.newGame();
  },

  stop() {
    clearTimeout(this.thinking);
    this.thinking = null;
  },

  newGame() {
    this.stop();
    this.board = emptyBoard();
    this.moves = [];
    this.update();
    if (this.turn === this.cpu) this.scheduleCpu();
  },

  play(index) {
    const before = { board: this.board.slice(), winner: this.result.winner };
    this.board[index] = this.turn;
    this.moves.push({ mark: this.board[index], index });
    const { winner } = this.result;
    if (winner) {
      const key = winner === 'draw' ? 'draw' : winner === this.human ? 'you' : 'cpu';
      this.record[key] += 1;
      local.set('ai-scores', this.scores);
    }
    soundFor(before, { board: this.board, winner }, this.human);
    this.update();
  },

  click(index) {
    if (this.thinking || this.result.winner || this.turn !== this.human || this.board[index]) return;
    this.play(index);
    if (!this.result.winner) this.scheduleCpu();
  },

  scheduleCpu() {
    this.thinking = setTimeout(() => {
      this.thinking = null;
      this.play(chooseMove(this.board, this.cpu, this.difficulty));
    }, 380 + Math.random() * 250);
    this.update();
  },

  undo() {
    if (this.thinking || this.result.winner) return;
    // Roll back to the human's previous turn (their move plus the computer's reply).
    do {
      const last = this.moves.pop();
      if (!last) break;
      this.board[last.index] = null;
    } while (this.turn !== this.human);
    this.update();
  },

  hint() {
    if (this.thinking || this.result.winner || this.turn !== this.human) return;
    showHint(bestMove(this.board, this.human));
  },

  resetScores() {
    this.scores[this.difficulty] = { you: 0, cpu: 0, draw: 0 };
    local.set('ai-scores', this.scores);
    this.update();
  },

  update() {
    const { winner, line } = this.result;
    const label = { easy: 'Easy', medium: 'Medium', hard: 'Hard' }[this.difficulty];
    $('ai-help').textContent = AI_HELP[this.difficulty];
    const names = { [this.human]: 'You', [this.cpu]: `Computer (${label})` };
    const scores = { [this.human]: this.record.you, [this.cpu]: this.record.cpu, draw: this.record.draw };
    let status;
    if (winner === 'draw') status = "It's a draw 🤝";
    else if (winner === this.human) status = 'You win! 🎉';
    else if (winner) status = 'The computer wins 🤖';
    else if (this.turn === this.human) status = `Your turn (${this.human})`;
    else status = 'Computer is thinking…';

    const myTurn = !winner && !this.thinking && this.turn === this.human;
    render({
      board: this.board, turn: this.turn, winner, line, names, scores, status,
      moves: this.moves, canMove: myTurn, ghost: this.human,
    });
    const humanMoves = this.moves.filter((m) => m.mark === this.human).length;
    setControls({
      'new-game': true,
      undo: myTurn && humanMoves > 0 ? true : 'disabled',
      hint: myTurn ? true : 'disabled',
      'reset-scores': true,
    });
  },
};

bindSegmented('difficulty', aiMode.difficulty, (value) => {
  aiMode.difficulty = value;
  local.set('ai-difficulty', value);
  aiMode.newGame();
});
bindSegmented('ai-mark', aiMode.human, (value) => {
  aiMode.human = value;
  local.set('ai-mark', value);
  aiMode.newGame();
});

// ---------------------------------------------------------------------------
// Local two-player (same device)
// ---------------------------------------------------------------------------

const localMode = {
  name: 'local',
  scores: local.get('local-scores', { X: 0, O: 0, draw: 0 }),
  starter: 'X',
  board: emptyBoard(),
  moves: [],

  get result() { return evaluate(this.board); },
  get turn() { return this.moves.length % 2 === 0 ? this.starter : other(this.starter); },

  start() {
    showScreen('game');
    this.starter = 'X';
    this.reset();
  },

  reset() {
    this.board = emptyBoard();
    this.moves = [];
    this.update();
  },

  newGame() {
    // Loser-friendly alternation: whoever did not start last game starts this one.
    if (this.moves.length) this.starter = other(this.starter);
    this.reset();
  },

  click(index) {
    if (this.result.winner || this.board[index]) return;
    const before = { board: this.board.slice(), winner: null };
    this.board[index] = this.turn;
    this.moves.push({ mark: this.board[index], index });
    const { winner } = this.result;
    if (winner) {
      this.scores[winner] += 1;
      local.set('local-scores', this.scores);
    }
    soundFor(before, { board: this.board, winner }, null);
    this.update();
  },

  undo() {
    if (this.result.winner) return;
    const last = this.moves.pop();
    if (last) this.board[last.index] = null;
    this.update();
  },

  hint() {
    if (!this.result.winner) showHint(bestMove(this.board, this.turn));
  },

  resetScores() {
    this.scores = { X: 0, O: 0, draw: 0 };
    local.set('local-scores', this.scores);
    this.update();
  },

  update() {
    const { winner, line } = this.result;
    let status;
    if (winner === 'draw') status = "It's a draw 🤝";
    else if (winner) status = `Player ${winner} wins! 🎉`;
    else status = `Player ${this.turn}'s turn`;
    render({
      board: this.board, turn: this.turn, winner, line, status,
      names: { X: 'Player X', O: 'Player O' }, scores: this.scores,
      moves: this.moves, canMove: !winner, ghost: this.turn,
    });
    setControls({
      'new-game': true,
      undo: !winner && this.moves.length ? true : 'disabled',
      hint: winner ? 'disabled' : true,
      'reset-scores': true,
    });
  },
};

// ---------------------------------------------------------------------------
// Online Player vs Player
// ---------------------------------------------------------------------------

const clientId = session.get('clientId') ?? (() => {
  const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  session.set('clientId', id);
  return id;
})();

const online = {
  name: 'online',
  ws: null,
  retries: 0,
  retryTimer: null,
  pending: [],
  room: session.get('room'), // code we believe we are in (survives reloads)
  state: null,
  searching: false,

  get playerName() {
    return $('player-name').value.trim() || 'Player';
  },

  // ---- connection ----
  connect() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    clearTimeout(this.retryTimer);
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    this.setConn('Connecting…');
    ws.addEventListener('open', () => {
      this.retries = 0;
      this.setConn('Connected');
      // Resume the room we were in (server matches us by clientId).
      if (this.room) ws.send(JSON.stringify({ type: 'join', code: this.room, name: this.playerName, clientId }));
      for (const msg of this.pending.splice(0)) ws.send(JSON.stringify(msg));
    });
    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.receive(msg);
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.searching) this.setSearching(false);
      if (mode !== this) return this.setConn('Disconnected');
      const delay = Math.min(1000 * 2 ** this.retries++, 10_000);
      this.setConn(`Connection lost — reconnecting in ${Math.round(delay / 1000)}s…`);
      if (this.state) {
        $('status').textContent = 'Connection lost — reconnecting…';
        boardEl.classList.remove('can-move');
        cells.forEach((cell) => { cell.disabled = true; });
      }
      this.retryTimer = setTimeout(() => this.connect(), delay);
    });
  },

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else {
      this.pending.push(msg);
      this.connect();
    }
  },

  setConn(text) {
    $('conn-status').textContent = text;
  },

  // ---- lifecycle ----
  start() {
    $('player-name').value = local.get('name', '');
    const params = new URLSearchParams(location.search);
    const invited = params.get('room');
    if (invited) $('room-code').value = invited.toUpperCase();
    $('lobby-status').textContent = '';
    showScreen('lobby');
    this.connect();
    // Invite links auto-join if we already know the player's name.
    if (invited && !this.room && $('player-name').value) this.join(invited);
    else if (!this.room) $('player-name').focus();
  },

  stop() {
    if (this.room) this.send({ type: 'leave' });
    if (this.searching) this.send({ type: 'cancelQuick' });
    this.setSearching(false);
    this.clearRoom();
  },

  rememberName() {
    local.set('name', $('player-name').value.trim());
  },

  create() {
    this.rememberName();
    this.send({ type: 'create', name: this.playerName, clientId });
  },

  join(code) {
    const clean = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.length !== 5) {
      $('lobby-status').textContent = 'Room codes are 5 characters.';
      return;
    }
    this.rememberName();
    this.send({ type: 'join', code: clean, name: this.playerName, clientId });
  },

  quick() {
    this.rememberName();
    if (this.searching) {
      this.send({ type: 'cancelQuick' });
      this.setSearching(false);
      $('lobby-status').textContent = 'Search cancelled.';
    } else {
      this.send({ type: 'quick', name: this.playerName, clientId });
    }
  },

  setSearching(on) {
    this.searching = on;
    $('quick-match').textContent = on ? 'Cancel search' : 'Find opponent';
    $('quick-match').classList.toggle('primary', on);
  },

  clearRoom() {
    this.room = null;
    this.state = null;
    session.remove('room');
    $('chat-log').innerHTML = '';
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url);
  },

  leave() {
    this.send({ type: 'leave' });
    this.clearRoom();
    $('lobby-status').textContent = 'You left the room.';
    showScreen('lobby');
  },

  // ---- incoming messages ----
  receive(msg) {
    switch (msg.type) {
      case 'state': return this.applyState(msg);
      case 'chat': return this.addChat(msg);
      case 'queued':
        this.setSearching(true);
        $('lobby-status').textContent = 'Looking for an opponent…';
        return;
      case 'error':
        if (msg.message.startsWith('Room not found') && this.room && !this.state) {
          // The room we tried to resume no longer exists.
          this.clearRoom();
          showScreen('lobby');
        }
        if (mode === this && !$('screen-lobby').hidden) $('lobby-status').textContent = msg.message;
        else toast(msg.message);
        return;
      case 'kicked':
        this.clearRoom();
        $('lobby-status').textContent = msg.message;
        showScreen('lobby');
        return;
      default:
    }
  },

  applyState(state) {
    if (mode !== this) return;
    const before = this.state;
    if (!before || before.code !== state.code) {
      // Chat history for the room arrives just before its first state, so keep the log.
      this.setSearching(false);
      showScreen('game');
    }
    this.state = state;
    this.room = state.code;
    session.set('room', state.code);
    const url = new URL(location.href);
    url.searchParams.set('room', state.code);
    history.replaceState(null, '', url);
    const mine = state.role === 'spectator' ? null : state.role;
    if (before && before.code === state.code) soundFor(before, state, mine);
    this.update();
  },

  addChat({ system, from, mark, text }) {
    const li = document.createElement('li');
    if (system) {
      li.className = 'system';
      li.textContent = text;
    } else {
      const who = document.createElement('span');
      who.className = `from ${mark}`;
      who.textContent = `${from}: `;
      li.append(who, document.createTextNode(text));
    }
    const log = $('chat-log');
    log.append(li);
    log.scrollTop = log.scrollHeight;
  },

  click(index) {
    const s = this.state;
    if (!s || s.winner || !s.ready || s.turn !== s.role || s.board[index]) return;
    this.send({ type: 'move', index });
  },

  rematch() {
    this.send({ type: 'rematch' });
  },

  update() {
    const s = this.state;
    if (!s) return;
    const me = s.role === 'spectator' ? null : s.role;
    const opp = me && other(me);
    const nameOf = (mark) => s.players[mark]?.name ?? 'Waiting…';
    const names = {
      X: `${nameOf('X')}${me === 'X' ? ' (you)' : ''}`,
      O: `${nameOf('O')}${me === 'O' ? ' (you)' : ''}`,
    };

    let status;
    if (s.winner === 'draw') status = "It's a draw 🤝";
    else if (s.winner && s.reason === 'forfeit') {
      status = s.winner === me ? 'Your opponent left — you win by forfeit 🏳️' : `${nameOf(s.winner)} wins by forfeit`;
    } else if (s.winner) status = s.winner === me ? 'You win! 🎉' : `${nameOf(s.winner)} wins${me ? ' 😢' : '!'}`;
    else if (!s.ready) status = `Waiting for an opponent… share code ${s.code}`;
    else if (me && !s.players[opp].connected) status = `${nameOf(opp)} disconnected — waiting for them to come back…`;
    else if (!me) status = `${nameOf(s.turn)}'s turn (${s.turn})`;
    else if (s.turn === me) status = `Your turn (${me})`;
    else status = `Waiting for ${nameOf(opp)}…`;

    if (s.winner && me && s.rematch[opp] && !s.rematch[me]) status += ' — opponent wants a rematch!';

    const canMove = Boolean(me && s.ready && !s.winner && s.turn === me);
    render({
      board: s.board, turn: s.turn, winner: s.winner, line: s.line,
      names, scores: s.scores, status, moves: s.moves ?? [], canMove, ghost: me,
    });

    let rematch = false;
    if (me && s.winner) {
      if (!s.players[opp]) rematch = { label: 'Waiting for a new opponent', disabled: true };
      else if (s.rematch[me]) rematch = { label: 'Rematch requested…', disabled: true };
      else rematch = { label: s.rematch[opp] ? 'Accept rematch' : 'Rematch' };
    }
    setControls({ rematch });

    $('room-code-label').textContent = s.code;
    const invite = new URL(location.href);
    invite.search = `?room=${s.code}`;
    invite.hash = '';
    $('invite-link').value = invite.href;
    $('you-are').textContent = me ? `You are playing ${me}${me === 'X' && !s.winner && !s.moves?.length ? ' — you move first' : ''}.` : 'You are spectating.';
    $('spectators').textContent = s.spectators ? `👀 ${s.spectators} watching` : '';
  },
};

$('create-room').addEventListener('click', () => online.create());
$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  online.join($('room-code').value);
});
$('quick-match').addEventListener('click', () => online.quick());
$('room-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});
$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text) return;
  online.send({ type: 'chat', text });
  $('chat-input').value = '';
});
$('copy-link').addEventListener('click', async () => {
  const link = $('invite-link').value;
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied');
  } catch {
    $('invite-link').select();
    toast('Press ⌘C / Ctrl+C to copy');
  }
});

// ---------------------------------------------------------------------------
// Global wiring
// ---------------------------------------------------------------------------

const modes = { ai: aiMode, local: localMode, online };

function goHome() {
  mode?.stop?.();
  mode = null;
  showScreen('home');
}

for (const card of document.querySelectorAll('.mode-card')) {
  card.addEventListener('click', () => startMode(modes[card.dataset.mode]));
}
$('brand').addEventListener('click', goHome);
for (const btn of document.querySelectorAll('[data-back]')) {
  btn.addEventListener('click', () => {
    if (mode === online && online.state) online.leave();
    else goHome();
  });
}

boardEl.addEventListener('click', (e) => {
  const cell = e.target.closest('.cell');
  if (cell && !cell.disabled) mode?.click(Number(cell.dataset.index));
});
$('new-game').addEventListener('click', () => mode?.newGame?.());
$('undo').addEventListener('click', () => mode?.undo?.());
$('hint').addEventListener('click', () => mode?.hint?.());
$('rematch').addEventListener('click', () => mode?.rematch?.());
$('reset-scores').addEventListener('click', () => mode?.resetScores?.());

// Keys 1–9 place a mark (left-to-right, top-to-bottom).
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if ($('screen-game').hidden || !/^[1-9]$/.test(e.key)) return;
  const cell = cells[Number(e.key) - 1];
  if (!cell.disabled) mode?.click(Number(e.key) - 1);
});

// Deep links: ?room=CODE opens the online lobby (or resumes the room after a reload).
if (online.room || new URLSearchParams(location.search).has('room')) startMode(online);
else showScreen('home');
