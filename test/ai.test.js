import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, availableMoves, emptyBoard, other } from '../public/js/game.js';
import { bestMove, chooseMove } from '../public/js/ai.js';

const parse = (s) => [...s].map((c) => (c === '.' ? null : c));

/** Plays every possible opponent line against the hard AI; returns outcome counts. */
function exhaust(board, turn, ai, tally = { win: 0, draw: 0, loss: 0 }) {
  const { winner } = evaluate(board);
  if (winner) {
    tally[winner === 'draw' ? 'draw' : winner === ai ? 'win' : 'loss'] += 1;
    return tally;
  }
  if (turn === ai) {
    const next = board.slice();
    next[bestMove(board, ai)] = ai;
    return exhaust(next, other(turn), ai, tally);
  }
  for (const i of availableMoves(board)) {
    const next = board.slice();
    next[i] = turn;
    exhaust(next, other(turn), ai, tally);
  }
  return tally;
}

test('hard AI never loses when moving first', () => {
  const tally = exhaust(emptyBoard(), 'X', 'X');
  assert.equal(tally.loss, 0);
  assert.ok(tally.win > 0);
});

test('hard AI never loses when moving second', () => {
  const tally = exhaust(emptyBoard(), 'X', 'O');
  assert.equal(tally.loss, 0);
  assert.ok(tally.draw > 0);
});

test('takes an immediate win over blocking', () => {
  // O can win at 5; X threatens at 2.
  assert.equal(bestMove(parse('XX.OO....'), 'O'), 5);
});

test('blocks an immediate threat', () => {
  assert.equal(bestMove(parse('XX..O....'), 'O'), 2);
});

test('medium always takes wins and blocks', () => {
  for (let i = 0; i < 50; i++) {
    assert.equal(chooseMove(parse('OO.XX....'), 'O', 'medium'), 2);
    assert.equal(chooseMove(parse('XX..O....'), 'O', 'medium'), 2);
  }
});

test('every difficulty returns a legal move', () => {
  const board = parse('XO.X.O...');
  for (const level of ['easy', 'medium', 'hard']) {
    for (let i = 0; i < 30; i++) {
      const move = chooseMove(board, 'X', level);
      assert.ok(availableMoves(board).includes(move), `${level} chose ${move}`);
    }
  }
  assert.equal(chooseMove(parse('XOXXOOOXX'), 'X', 'hard'), null);
});

test('hard AI is fast enough for the browser', () => {
  const start = performance.now();
  bestMove(emptyBoard(), 'X');
  assert.ok(performance.now() - start < 500);
});
