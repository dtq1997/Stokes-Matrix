// 前端实时 PL path 构造: 跟 sage 端 pl_path_in_chamber 算法对齐.
// d 变化时实时重新画 path, 同伦类正确 (在 ℂ_d(u) 内绕 cuts).

import { C } from './geometry.js';
import type { ComplexNum, Puncture } from './types.js';

/** 段 [a, b] 跟射线 {origin + t·dir : t > 0} 的交点 (内部, 不端点). */
function segRayIntersect(
  a: ComplexNum, b: ComplexNum,
  origin: ComplexNum, dir: ComplexNum,
  tol = 1e-9,
): { s: number; P: ComplexNum } | null {
  const segDir = C.sub(b, a);
  const rhs = C.sub(origin, a);
  const det = segDir.re * (-dir.im) - (-dir.re) * segDir.im;
  if (Math.abs(det) < tol) return null;
  const s = (rhs.re * (-dir.im) - (-dir.re) * rhs.im) / det;
  const t = (segDir.re * rhs.im - rhs.re * segDir.im) / det;
  if (s <= tol || s >= 1 - tol || t <= tol) return null;
  return { s, P: { re: a.re + s * segDir.re, im: a.im + s * segDir.im } };
}

/** 段 [a, b] 是否撞任何 cut (从 U_cuts 各点沿 -d 半射线). 返回最近撞的. */
function findFirstCutHit(
  a: ComplexNum, b: ComplexNum,
  U_cuts: Puncture[], d: number,
): { k: number; s: number; P: ComplexNum } | null {
  const dir = C.expI(-d);
  let best: { k: number; s: number; P: ComplexNum } | null = null;
  for (let k = 0; k < U_cuts.length; k++) {
    const r = segRayIntersect(a, b, U_cuts[k], dir);
    if (r && (!best || r.s < best.s)) best = { k, s: r.s, P: r.P };
  }
  return best;
}

/** 段 [a, b] 跟 puncture u_l 距离 < tol 时返回 (l, dist). */
function segAvoidsPunctures(
  a: ComplexNum, b: ComplexNum,
  U_others: Puncture[], tol = 0.01,
): { k: number; dist: number } | null {
  const segDir = C.sub(b, a);
  const segLen = C.abs(segDir);
  if (segLen < 1e-12) return null;
  const segUnit = C.scale(segDir, 1 / segLen);
  let closest: { k: number; dist: number } | null = null;
  for (let k = 0; k < U_others.length; k++) {
    const u = U_others[k];
    const rel = C.sub(u, a);
    const proj = rel.re * segUnit.re + rel.im * segUnit.im;
    let d_pt: number;
    if (proj < 0) d_pt = C.abs(rel);
    else if (proj > segLen) d_pt = C.abs(C.sub(u, b));
    else {
      const perp = C.sub(rel, C.scale(segUnit, proj));
      d_pt = C.abs(perp);
    }
    if (d_pt < tol && (!closest || d_pt < closest.dist)) closest = { k, dist: d_pt };
  }
  return closest;
}

/**
 * 构造 ℂ_d(u) 内从 u_start 到 u_end_target 的 PL path waypoints.
 * 算法跟 sage 端 pl_path_in_chamber 同: 试直推, 撞了用 (+d 方向) 三段高路径.
 *
 * @param U_others 路径区域内可能挡的 punctures (含端点 puncture 也行, 自动 avoid)
 * @returns waypoints list (含 u_end_target). 起点 u_start 不在内.
 */
export function plPathInChamber(
  uStart: ComplexNum,
  uEnd: ComplexNum,
  U_others: Puncture[],
  d: number,
  punctureTol = 0.01,
): ComplexNum[] {
  // 试直推
  const directHit = findFirstCutHit(uStart, uEnd, U_others, d);
  const directNear = segAvoidsPunctures(uStart, uEnd, U_others, punctureTol);
  if (!directHit && !directNear) return [uEnd];

  // 三段高路径: 在 exp(i(d-π/2)) 旋转坐标系下, cuts 沿 -y, path 走在 b_max + ε 上方.
  // 一次成功, 不 retry: y_top > b_max → cut 不撞 (cut 朝 -y, path 在 +y); 距 puncture
  // ≥ ε > tol → puncture 不撞.
  const rot = C.expI(d - Math.PI / 2);
  const rotInv = C.expI(Math.PI / 2 - d);
  const rotPts = U_others.map(p => C.mul(p, rot));
  const rotStart = C.mul(uStart, rot);
  const rotEnd = C.mul(uEnd, rot);
  const bMax = Math.max(
    ...rotPts.map(p => p.im), rotStart.im, rotEnd.im,
  );

  // 闭式 buffer: 取 max(diam, 端点距离) 的 ~10% + 固定 tol margin, 保证 ε > punctureTol
  const allPts = [...U_others, uStart, uEnd];
  let diam = 0.0;
  for (let i = 0; i < allPts.length; i++) {
    for (let j = i + 1; j < allPts.length; j++) {
      const dist = C.abs(C.sub(allPts[i], allPts[j]));
      if (dist > diam) diam = dist;
    }
  }
  const buffer = Math.max(0.1 * diam, 10 * punctureTol);
  const yTop = bMax + buffer;

  const upRot: ComplexNum = { re: rotStart.re, im: yTop };
  const acrossRot: ComplexNum = { re: rotEnd.re, im: yTop };
  const upPt = C.mul(upRot, rotInv);
  const acrossPt = C.mul(acrossRot, rotInv);
  return [upPt, acrossPt, uEnd];
}

/**
 * 给定方向 d、起点 i、终点 j、所有 punctures, 构造完整 viz path:
 *   起点 u_i → ... → 终点 u_j (display 用 u_j 自己, evaluation 不在前端做)
 */
export function buildPathForViz(
  i: number, j: number, d: number, punctures: Puncture[],
): ComplexNum[] {
  const ui = punctures[i];
  const uj = punctures[j];
  // path target = u_j + ε e^{id} 跟 sage 端一致 (避免数值 ODE 撞奇异点)
  // 视觉上把最后 vertex 替换成 u_j 自己
  const otherDists = punctures
    .map((_, l) => l === j ? Infinity : C.abs(C.sub(punctures[l], uj)))
    .filter(d => Number.isFinite(d));
  const targetDist = 0.5 * Math.min(...otherDists);
  const uTarget: ComplexNum = {
    re: uj.re + targetDist * Math.cos(d),
    im: uj.im + targetDist * Math.sin(d),
  };
  const U_others = punctures.filter((_, k) => k !== i && k !== j);
  const wp = plPathInChamber(ui, uTarget, U_others, d);
  // 用 u_j 替换最后 vertex (display)
  const visualWaypoints = wp.slice(0, -1).concat([uj]);
  return [ui, ...visualWaypoints];
}
