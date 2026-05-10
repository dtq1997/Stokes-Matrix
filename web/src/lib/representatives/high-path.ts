// 高路径策略: 三段绕路, 朝 cut 反方向 -e^{-id} 走 N 远.
// cut 沿 e^{-id} 方向, -e^{-id} 严格在 cut 反向半平面, path 不撞 cut.
// 跟 sage 端 isoeq_pusher.pl_path_in_chamber 同一公式 (SSOT 通过几何对齐).

import { C } from '../geometry.js';
import type { ComplexNum, Puncture } from '../types.js';
import type { RepresentativeContext, RepresentativeResult, RepresentativeStrategy } from './types.js';

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
  label: '高路径 (cut 反方向 N 远)',
  description: '三段 PL: 起点 → u_i - N·e^{-id} → u_j - N·e^{-id} → u_j. N=2·max diam, 严格不撞 cut.',

  build({ i, j, d, punctures }: RepresentativeContext): RepresentativeResult {
    const ui = punctures[i];
    const uj = punctures[j];
    if (i === j) throw new Error('high-path: i == j 无效');

    const allPts: ComplexNum[] = [...punctures];
    const N = 2.0 * Math.max(diameter(allPts), 0.5);

    // shift = -N · e^{-id} = N · e^{i(π-d)}
    const shift = C.mul({ re: N, im: 0 }, C.expI(Math.PI - d));

    const pt1 = C.add(ui, shift);
    const pt2 = C.add(uj, shift);

    // 起点切线 = u_i → pt1 方向 (即 -e^{-id} = e^{i(π-d)} 方向)
    const startTangent = Math.PI - d;
    // 终点切线 = pt2 → u_j 方向 (即 +e^{-id} = e^{-id} 方向)
    const endTangent = -d;

    return {
      vertices: [ui, pt1, pt2, uj],
      startTangent,
      endTangent,
      strategyId: this.id,
    };
  },
};
