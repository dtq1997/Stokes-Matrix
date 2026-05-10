// 高路径策略: 在 e^{i(d-π/2)} 旋转坐标系下, path 走在 b_max + ε 上方.
// 三段折线 u_i → up → across → u_j. cuts 沿 -y 朝下, path 在 +y, 闭式不撞.

import { C } from '../geometry.js';
import type { ComplexNum, Puncture } from '../types.js';
import type { RepresentativeContext, RepresentativeResult, RepresentativeStrategy } from './types.js';

const PUNCTURE_TOL = 0.01;

function diameter(pts: ComplexNum[]): number {
  let d = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dist = C.abs(C.sub(pts[i], pts[j]));
      if (dist > d) d = dist;
    }
  }
  return d || 1.0;
}

export const highPathStrategy: RepresentativeStrategy = {
  id: 'high-path',
  label: '高路径 (闭式一次成功)',
  description: '在 -d 反方向 (即 +d 方向) 远离 cuts, 三段 PL: 起点垂直上, 横过, 终点垂直下.',

  build({ i, j, d, punctures }: RepresentativeContext): RepresentativeResult {
    const ui = punctures[i];
    const uj = punctures[j];
    if (i === j) throw new Error('high-path: i == j 无效');
    const U_others = punctures.filter((_, k) => k !== i && k !== j);

    const rot = C.expI(d - Math.PI / 2);
    const rotInv = C.expI(Math.PI / 2 - d);
    const rotPts = U_others.map(p => C.mul(p, rot));
    const rotStart = C.mul(ui, rot);
    const rotEnd = C.mul(uj, rot);
    const bMax = Math.max(
      ...rotPts.map(p => p.im), rotStart.im, rotEnd.im,
    );
    const allPts = [...U_others, ui, uj];
    const buffer = Math.max(0.1 * diameter(allPts), 10 * PUNCTURE_TOL);
    const yTop = bMax + buffer;

    const upRot: ComplexNum = { re: rotStart.re, im: yTop };
    const acrossRot: ComplexNum = { re: rotEnd.re, im: yTop };
    const upPt = C.mul(upRot, rotInv);
    const acrossPt = C.mul(acrossRot, rotInv);

    // 起点切线 = u_i → upPt 方向
    const startVec = C.sub(upPt, ui);
    const startTangent = Math.atan2(startVec.im, startVec.re);
    // 终点切线 = acrossPt → u_j 方向 (path 接近 u_j 的方向)
    const endVec = C.sub(uj, acrossPt);
    const endTangent = Math.atan2(endVec.im, endVec.re);

    return {
      vertices: [ui, upPt, acrossPt, uj],
      startTangent,
      endTangent,
      strategyId: this.id,
    };
  },
};
