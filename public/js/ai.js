// Computer opponent: minimax with alpha-beta pruning plus weaker difficulty levels.
import { evaluate, availableMoves, other, LINES } from './game.js';

const pick = (list, rng) => list[Math.floor(rng() * list.length)];

/**
 * Scores every legal move for `me` with full-depth minimax.
 * Faster wins score higher and slower losses score less negative.
 */
export function scoreMoves(board, me) {
  return availableMoves(board).map((index) => {
    const next = board.slice();
    next[index] = me;
    return { index, score: minimax(next, other(me), me, 1, -Infinity, Infinity) };
  });
}

function minimax(board, turn, me, depth, alpha, beta) {
  const { winner } = evaluate(board);
  if (winner === me) return 10 - depth;
  if (winner === 'draw') return 0;
  if (winner) return depth - 10;

  const maximizing = turn === me;
  let best = maximizing ? -Infinity : Infinity;
  for (const index of availableMoves(board)) {
    board[index] = turn;
    const score = minimax(board, other(turn), me, depth + 1, alpha, beta);
    board[index] = null;
    if (maximizing) {
      best = Math.max(best, score);
      alpha = Math.max(alpha, score);
    } else {
      best = Math.min(best, score);
      beta = Math.min(beta, score);
    }
    if (beta <= alpha) break;
  }
  return best;
}

/** Perfect play; ties between equally good moves are broken randomly. */
export function bestMove(board, me, rng = Math.random) {
  const scored = scoreMoves(board, me);
  if (scored.length === 0) return null;
  const top = Math.max(...scored.map((m) => m.score));
  return pick(scored.filter((m) => m.score === top).map((m) => m.index), rng);
}

/** Wins if it can, blocks if it must, otherwise prefers center, corners, then edges. */
function heuristicMove(board, me, rng) {
  const moves = availableMoves(board);
  const completing = (mark) =>
    moves.find((i) =>
      LINES.some((line) => line.includes(i) &&
        line.filter((j) => j !== i).every((j) => board[j] === mark)));

  const win = completing(me);
  if (win !== undefined) return win;
  const block = completing(other(me));
  if (block !== undefined) return block;
  if (moves.includes(4)) return 4;
  const corners = moves.filter((i) => [0, 2, 6, 8].includes(i));
  return pick(corners.length ? corners : moves, rng);
}

export const DIFFICULTIES = ['easy', 'medium', 'hard'];

export function chooseMove(board, me, difficulty = 'hard', rng = Math.random) {
  const moves = availableMoves(board);
  if (moves.length === 0) return null;
  switch (difficulty) {
    case 'easy':
      // Mostly random, but takes an immediate win a third of the time.
      return rng() < 0.33 ? heuristicMove(board, me, rng) : pick(moves, rng);
    case 'medium':
      // Plays sensibly but can be beaten with forks; occasionally plays perfectly.
      return rng() < 0.3 ? bestMove(board, me, rng) : heuristicMove(board, me, rng);
    default:
      return bestMove(board, me, rng);
  }
}
