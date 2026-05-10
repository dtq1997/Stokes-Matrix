// 代表元策略 (representative strategy):
// 给定 path algebroid 元素 γ_{ij}^{(d)} 的 abstract data (i, j, d, punctures),
// 选一个具体的 PL 折线代表它. 不同策略 = 不同视觉/数值 trade-off.
// path algebroid 元素是 fixed-endpoint homotopy 类 + lift, 任何代表元都给同一 S 值.

import type { ComplexNum, Puncture } from '../types.js';

export interface RepresentativeContext {
  /** path algebroid 元素 γ_{ij}^{(d)} 的 (起 block, 终 block) 索引 (0-indexed). */
  i: number;
  j: number;
  /** admissible direction d (rad, 任意实数, 不限 [0, 2π)). */
  d: number;
  /** punctures 全集 (含 i, j, others). */
  punctures: Puncture[];
}

export interface RepresentativeResult {
  /** PL 折线 vertices, [u_i, ...intermediate, u_j]. 起终点必须是 puncture i, j. */
  vertices: ComplexNum[];
  /** 起点切线方向 (radian, 路径在 u_i 处出发的几何 tangent). 用于 lift indicator viz. */
  startTangent: number;
  /** 终点切线方向 (路径在 u_j 处接近的 tangent). */
  endTangent: number;
  /** 此代表元的标识 (调试/UI 显示). */
  strategyId: string;
}

export interface RepresentativeStrategy {
  /** 唯一 ID, e.g. 'high-path', 'straight-detour', 'lift-aligned'. */
  id: string;
  /** UI 显示名 (中文). */
  label: string;
  /** 简短说明. */
  description: string;
  /** 构造代表元. 失败应 throw 不静默退化. */
  build(ctx: RepresentativeContext): RepresentativeResult;
}
