// Representative 策略注册表. 加新策略只需 import + 加进 ALL_STRATEGIES.

import { highPathStrategy } from './high-path.js';
import { straightDetourStrategy } from './straight-detour.js';
import type { RepresentativeStrategy } from './types.js';

export const ALL_STRATEGIES: Record<string, RepresentativeStrategy> = {
  [highPathStrategy.id]: highPathStrategy,
  [straightDetourStrategy.id]: straightDetourStrategy,
};

export const DEFAULT_STRATEGY_ID = highPathStrategy.id;

export function getStrategy(id: string): RepresentativeStrategy {
  const s = ALL_STRATEGIES[id];
  if (!s) throw new Error(`unknown representative strategy: ${id}`);
  return s;
}

export type { RepresentativeStrategy, RepresentativeContext, RepresentativeResult } from './types.js';
