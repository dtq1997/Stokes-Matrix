// 入口: 给定 (i, j, d, punctures) + strategy id, 用注册的代表元策略生成 path.
// 具体策略实现在 representatives/ 文件夹.

import type { ComplexNum, Puncture } from './types.js';
import { getStrategy, DEFAULT_STRATEGY_ID } from './representatives/index.js';
import type { RepresentativeResult } from './representatives/index.js';

export function buildRepresentative(
  i: number, j: number, d: number,
  punctures: Puncture[],
  strategyId: string = DEFAULT_STRATEGY_ID,
): RepresentativeResult {
  return getStrategy(strategyId).build({ i, j, d, punctures });
}

/** Backward-compat: 旧 buildPathForViz, 只返回 vertices. */
export function buildPathForViz(
  i: number, j: number, d: number, punctures: Puncture[],
  strategyId?: string,
): ComplexNum[] {
  return buildRepresentative(i, j, d, punctures, strategyId).vertices;
}
