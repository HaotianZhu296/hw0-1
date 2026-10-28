import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, availableMoves, isValidMove, emptyBoard, other } from '../public/js/game.js';

const parse = (s) => [...s].map((c) => (c === '.' ? null : c));

test('detects row, column and diagonal wins', () => {
  assert.deepEqual(evaluate(parse('XXX......')), { winner: 'X', line: [0, 1, 2] });
  assert.deepEqual(evaluate(parse('.O..O..O.')), { winner: 'O', line: [1, 4, 7] });
  assert.deepEqual(evaluate(parse('..X.X.X..')), { winner: 'X', line: [2, 4, 6] });
});

test('detects draws and games in progress', () => {
  assert.deepEqual(evaluate(parse('XOXXOOOXX')), { winner: 'draw', line: null });
  assert.deepEqual(evaluate(parse('XO.......')), { winner: null, line: null });
  assert.deepEqual(evaluate(emptyBoard()), { winner: null, line: null });
});

test('a win on the last square is a win, not a draw', () => {
  assert.equal(evaluate(parse('XOXOXOOXX')).winner, 'X');
});

test('move helpers', () => {
  const board = parse('X...O...X');
  assert.deepEqual(availableMoves(board), [1, 2, 3, 5, 6, 7]);
  assert.equal(isValidMove(board, 1), true);
  assert.equal(isValidMove(board, 0), false);
  assert.equal(isValidMove(board, 9), false);
  assert.equal(isValidMove(board, -1), false);
  assert.equal(isValidMove(board, '1'), false);
  assert.equal(isValidMove(board, 1.5), false);
  assert.equal(other('X'), 'O');
  assert.equal(other('O'), 'X');
});
