// 复矩阵原语 + matrix exponential (Taylor + scaling-squaring).
// 用途: paper monodromy 块版修正 expm(±2πik · A_II), m_I × m_I matrix.

import type { ComplexNum } from './types.js';

type CMat = ComplexNum[][];

const zero: ComplexNum = { re: 0, im: 0 };

export function mident(n: number): CMat {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => i === j ? { re: 1, im: 0 } : { re: 0, im: 0 }));
}

export function mscale(A: CMat, s: number): CMat {
  return A.map(row => row.map(c => ({ re: c.re * s, im: c.im * s })));
}

/** A · B,  A: m×k, B: k×n,  result: m×n */
export function mmul(A: CMat, B: CMat): CMat {
  const m = A.length, k = A[0].length, n = B[0].length;
  const out: CMat = Array.from({ length: m }, () =>
    Array.from({ length: n }, () => ({ ...zero })));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      let re = 0, im = 0;
      for (let l = 0; l < k; l++) {
        const a = A[i][l], b = B[l][j];
        re += a.re * b.re - a.im * b.im;
        im += a.re * b.im + a.im * b.re;
      }
      out[i][j] = { re, im };
    }
  }
  return out;
}

export function madd(A: CMat, B: CMat): CMat {
  return A.map((row, i) => row.map((c, j) => ({ re: c.re + B[i][j].re, im: c.im + B[i][j].im })));
}

/** 矩阵 sup-norm (max |entry|): 用于 scaling 估计. */
export function mnorm(A: CMat): number {
  let m = 0;
  for (const row of A) for (const c of row) {
    const a = Math.hypot(c.re, c.im);
    if (a > m) m = a;
  }
  return m;
}

/** 复矩阵指数 expm(A) via Taylor + scaling-squaring.
 * 算法: A → A/2^s 让 ||A/2^s|| ≤ 0.5, Taylor 截 30 项 (||A||≤0.5 时机器精度内收敛),
 * 再 squaring s 次得 expm(A) = (expm(A/2^s))^{2^s}.
 *
 * 对 m_k ≤ 8 (实际应用) 复杂度 O(s · m³ + 30 · m³) 几十 microsec.
 */
export function expm(A: CMat, terms = 30): CMat {
  const n = A.length;
  if (n === 0) return [];
  const norm = mnorm(A);
  if (norm < 1e-15) return mident(n);  // 零矩阵
  // scaling: 找最小 s 让 norm/2^s ≤ 0.5
  let s = 0; let r = norm;
  while (r > 0.5) { r /= 2; s++; }
  const A_scaled = mscale(A, 1 / Math.pow(2, s));
  // Taylor: result = I + A + A²/2! + A³/3! + ...
  let result = mident(n);
  let term = mident(n);
  for (let k = 1; k <= terms; k++) {
    term = mscale(mmul(term, A_scaled), 1 / k);
    result = madd(result, term);
    if (mnorm(term) < 1e-18) break;
  }
  // Squaring: result^(2^s)
  for (let k = 0; k < s; k++) result = mmul(result, result);
  return result;
}
