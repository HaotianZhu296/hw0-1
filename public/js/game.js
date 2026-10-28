// Core Tic Tac Toe rules, shared by the browser and the Node server.

export const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
  [0, 4, 8], [2, 4, 6],            // diagonals
];

export const emptyBoard = () => Array(9).fill(null);

export const other = (mark) => (mark === 'X' ? 'O' : 'X');

/** Returns { winner: 'X' | 'O' | 'draw' | null, line: number[] | null }. */
export function evaluate(board) {
  for (const line of LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line };
    }
  }
  if (board.every(Boolean)) return { winner: 'draw', line: null };
  return { winner: null, line: null };
}

export const availableMoves = (board) =>
  board.reduce((moves, cell, i) => (cell ? moves : [...moves, i]), []);

export const isValidMove = (board, index) =>
  Number.isInteger(index) && index >= 0 && index < 9 && board[index] === null;
