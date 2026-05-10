// 几何原语 + chamber 索引 + paper monodromy phase. 全部纯函数, 不依赖 D3.

import type { ComplexNum } from './types.js';

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
 * 把绝对方向角 d 落入区间 [0, 2π).
 */
export function modTwoPi(x: number): number {
  const tp = 2 * Math.PI;
  return ((x % tp) + tp) % tp;
}

/**
 * Paper monodromy phase 修正 (S_d)_{ij} 跨周期值.
 *
 * dataset 存的 entry 是在 d_sample 处用 paper inf product 公式算的 (S_{d_sample}).
 * user 滑块上的真实 d 跟 d_sample 同 chamber 但可能差 2π·m 周期 (因 sample d 单调
 * 递增不 mod 2π, viz 滑块 d ∈ ℝ). 真 (S_{d_user}) 跟 (S_{d_sample}) 差 paper
 * monodromy phase: m = round((d_user - d_sample) / 2π).
 *
 * 推导: paper 公式 (S_{[\tau]})_{st} 含 (u_t-u_s)^{A_ss} · (u_t-u_s)^{-A_tt}, lift
 * 用 -τ. τ → τ+2π 时 lift -2π, (u_t-u_s)^{A_ss} 多 exp(-2πi·A_ss),
 * (u_t-u_s)^{-A_tt} 多 exp(+2πi·A_tt), 整体 (S_{d+2π}) = (S_d)·exp(2πi·(A_tt-A_ss)).
 * 所以修正 (S_{d_user}) = (S_{d_sample}) · exp(2πi·m·(A_jj-A_ii)).
 *
 * Simple-spectrum 假设: A_ii / A_jj 是 scalar (block size 1).
 */
export function monodromyPhase(
  d_user: number, d_sample: number, A_ii: number, A_jj: number,
): { re: number; im: number } {
  const tp = 2 * Math.PI;
  const m = Math.round((d_user - d_sample) / tp);
  if (m === 0) return { re: 1, im: 0 };
  const theta = tp * m * (A_jj - A_ii);
  return { re: Math.cos(theta), im: Math.sin(theta) };
}

/**
 * 给定 d, 找包含它的 chamber 索引.
 * rays 必须已 sorted 升序 (sage 端 anti_stokes_rays 已 sort). chamber k 对应
 * ray-interval (rays[k], rays[k+1]) (k=last 时绕回到 rays[0]+2π).
 * dataset.chambers[k] 顺序严格对齐 (sage chamber_midpoints 按同顺序生成).
 *
 * 严禁用"找最近 chamber center" — chamber 不等宽, 某些 d 离错 chamber center 更近.
 */
export function chamberOfDirection(d: number, rays: number[]): number {
  const dMod = modTwoPi(d);
  for (let k = 0; k < rays.length - 1; k++) {
    if (dMod >= rays[k] && dMod < rays[k + 1]) return k;
  }
  // wrap: dMod 在 (last, 2π) ∪ [0, first) 都属于最后一个 chamber
  return rays.length - 1;
}
