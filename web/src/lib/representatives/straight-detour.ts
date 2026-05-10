// 直线代表元 + 撞 cut 时绕 puncture 的策略.
// 候选: 大部分 (i, j) 直线 u_i → u_j 不撞 cut → 直接用直线.
// 直线撞 cut → 在撞点附近绕过 puncture (沿 +d 方向 ε-绕).
// 比 high-path 更"直", 视觉上更紧致, 但实现细节复杂, 第一版未实现.
// 这里只是占位, 标记 TODO.

import type { RepresentativeStrategy } from './types.js';

export const straightDetourStrategy: RepresentativeStrategy = {
  id: 'straight-detour',
  label: '直线 + 局部绕路 (TODO)',
  description: '直线 u_i → u_j, 撞 cut 时仅在 puncture 附近 ε-绕过. 视觉更紧凑.',

  build() {
    throw new Error('straight-detour 策略未实现, 用 high-path');
  },
};
