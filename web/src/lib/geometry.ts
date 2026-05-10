// 几何原语: 复数运算, 线段-线段交, 扫掠三角形 puncture 包含判定.
// 全部纯函数, 不依赖 D3.

import type { ComplexNum, Puncture } from './types.js';

export const C = {
  add: (a: ComplexNum, b: ComplexNum): ComplexNum => ({ re: a.re + b.re, im: a.im + b.im }),
  sub: (a: ComplexNum, b: ComplexNum): ComplexNum => ({ re: a.re - b.re, im: a.im - b.im }),
  mul: (a: ComplexNum, b: ComplexNum): ComplexNum => ({
    re: a.re * b.re - a.im * b.im,
    im: a.re * b.im + a.im * b.re,
  }),
  scale: (a: ComplexNum, s: number): ComplexNum => ({ re: a.re * s, im: a.im * s }),
  abs: (a: ComplexNum): number => Math.hypot(a.re, a.im),
  arg: (a: ComplexNum): number => Math.atan2(a.im, a.re),
  expI: (theta: number): ComplexNum => ({ re: Math.cos(theta), im: Math.sin(theta) }),
};

/**
 * 线段 [a, b] 与线段 [c, d] 的交点. 严格内部交返回 (s, t, P), s/t ∈ (0,1).
 * 端点接触不算 (用 epsilon 排除).
 */
export function segSegIntersect(
  a: ComplexNum, b: ComplexNum, c: ComplexNum, d: ComplexNum,
  eps: number = 1e-9,
): { s: number; t: number; P: ComplexNum } | null {
  const dx1 = b.re - a.re, dy1 = b.im - a.im;
  const dx2 = d.re - c.re, dy2 = d.im - c.im;
  const det = dx1 * (-dy2) - (-dx2) * dy1;
  if (Math.abs(det) < eps) return null;
  const rhsX = c.re - a.re, rhsY = c.im - a.im;
  const s = (rhsX * (-dy2) - (-dx2) * rhsY) / det;
  const t = (dx1 * rhsY - rhsX * dy1) / det;
  if (s <= eps || s >= 1 - eps || t <= eps || t >= 1 - eps) return null;
  return { s, t, P: { re: a.re + s * dx1, im: a.im + s * dy1 } };
}

/**
 * 一条折线 (vertices) 跟另一条折线的所有交点.
 */
export function pathPathIntersections(
  vsA: ComplexNum[], vsB: ComplexNum[],
): Array<{ idxA: number; idxB: number; sA: number; sB: number; P: ComplexNum }> {
  const out: Array<{ idxA: number; idxB: number; sA: number; sB: number; P: ComplexNum }> = [];
  for (let a = 0; a < vsA.length - 1; a++) {
    for (let b = 0; b < vsB.length - 1; b++) {
      const r = segSegIntersect(vsA[a], vsA[a + 1], vsB[b], vsB[b + 1]);
      if (r) out.push({ idxA: a, idxB: b, sA: r.s, sB: r.t, P: r.P });
    }
  }
  return out;
}

/**
 * 三角形 [P, Q, R] 是否包含点 X (含边).
 */
export function triangleContains(P: ComplexNum, Q: ComplexNum, R: ComplexNum, X: ComplexNum): boolean {
  const sign = (a: ComplexNum, b: ComplexNum, c: ComplexNum) =>
    (a.re - c.re) * (b.im - c.im) - (b.re - c.re) * (a.im - c.im);
  const d1 = sign(X, P, Q);
  const d2 = sign(X, Q, R);
  const d3 = sign(X, R, P);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * 拖动 path vertex 从 oldPos 到 newPos, 邻居为 prev/next.
 * 旧路径 [prev, oldPos, next] 跟新路径 [prev, newPos, next] 之间扫出两个三角形:
 *   T1 = [prev, oldPos, newPos], T2 = [next, oldPos, newPos]
 * 任何 puncture 落入 T1 ∪ T2 → 同伦类变了 → 拒绝.
 */
export function homotopyPreserved(
  prev: ComplexNum,
  oldPos: ComplexNum,
  newPos: ComplexNum,
  next: ComplexNum,
  punctures: Puncture[],
): { ok: boolean; offending?: number } {
  for (let k = 0; k < punctures.length; k++) {
    const u = punctures[k];
    if (
      triangleContains(prev, oldPos, newPos, u) ||
      triangleContains(next, oldPos, newPos, u)
    ) {
      return { ok: false, offending: k };
    }
  }
  return { ok: true };
}

/**
 * 折线穿过沿 -d 方向 cut (从 u_k 出发) 的次数 (有向, 跟 lift 跳变正负相关).
 * cut: { u_k + t · e^{-i d} : t ≥ 0 }
 */
export function cutCrossings(
  vertices: ComplexNum[], punctures: Puncture[], d: number,
): Array<{ k: number; segIdx: number; sign: number; P: ComplexNum }> {
  const out: Array<{ k: number; segIdx: number; sign: number; P: ComplexNum }> = [];
  const dir: ComplexNum = C.expI(-d);
  for (let segIdx = 0; segIdx < vertices.length - 1; segIdx++) {
    const a = vertices[segIdx];
    const b = vertices[segIdx + 1];
    const segDir = C.sub(b, a);
    for (let k = 0; k < punctures.length; k++) {
      const u = punctures[k];
      // ray-segment 交: 段参数化 a + s*(b-a), s∈(0,1); ray u + t*dir, t > 0
      const rhs = C.sub(u, a);
      const det = segDir.re * (-dir.im) - (-dir.re) * segDir.im;
      if (Math.abs(det) < 1e-12) continue;
      const s = (rhs.re * (-dir.im) - (-dir.re) * rhs.im) / det;
      const t = (segDir.re * rhs.im - rhs.re * segDir.im) / det;
      if (s <= 1e-9 || s >= 1 - 1e-9 || t <= 1e-9) continue;
      // sign = 段方向跨 cut 是 ccw 还是 cw 相对 cut 方向
      // cross(segDir, dir) > 0 → ccw 跨, lift +1
      const sign = (segDir.re * dir.im - segDir.im * dir.re) > 0 ? 1 : -1;
      out.push({ k, segIdx, sign, P: { re: a.re + s * segDir.re, im: a.im + s * segDir.im } });
    }
  }
  return out;
}

/**
 * 把绝对方向角 d 落入区间 [0, 2π).
 */
export function modTwoPi(x: number): number {
  const tp = 2 * Math.PI;
  return ((x % tp) + tp) % tp;
}

/**
 * 给定 d, 找最近的 chamber 索引 (chambers 是按 d 升序的代表方向).
 */
export function chamberOfDirection(d: number, chamberDs: number[]): number {
  const dMod = modTwoPi(d);
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < chamberDs.length; i++) {
    const dist = Math.min(
      Math.abs(chamberDs[i] - dMod),
      Math.abs(chamberDs[i] + 2 * Math.PI - dMod),
      Math.abs(chamberDs[i] - 2 * Math.PI - dMod),
    );
    if (dist < bestDist) { bestDist = dist; bestIdx = i; }
  }
  return bestIdx;
}
