// CP^n 整数 Stokes 矩阵的 wall-crossing 精确传播 — A_diag = 0 退化版.
//
// ⚠️ Scope hard-locked: 本文件公式只在以下条件下成立, caller (main.ts
// runIscMatrix) 必须用 (m_sizes 全 1) ∧ (A_diag 全 0) ∧ (base 全整数) 三重 gate
// 收窄到该范围. 不要把这里的公式当一般 wall-crossing 规则推广 — 主算法在
// 50-computation/compute_sd_v5_full.sage 里, 那边有一般 sandwich 公式和
// reduced-word adjacent-swap sequence.
//
// 单 pair 公式 (memory: project_Sd_wall_crossing_rule.md, A_diag=0 化简):
// 跨 wall τ = -arg(u_j - u_i), d-order ... i j ... → ... j i ...:
//   - S'_{ab} = S_{ab}      若 a ≠ j 且 b ≠ j (含 (i, j) 本身)
//   - S'_{ji} = S_{ji}      (一般是 e^{-2πi A_jj}·S_{ji}·e^{2πi A_ii}; A_diag=0 ⇒ sandwich = id)
//   - S'_{kj} = S_{kj} - S_{ki} · S_{ij}     k ≠ i, j (column j)
//   - S'_{jk} = S_{jk} + S_{ji} · S_{ik}     A_diag=0 下两 case 公式相同 (k 在 i,j 前/后)
//
// Degenerate ray (单 wall 多 swap pair): 当前实现假定 pair 索引互不重叠,
// 故 sequential apply 顺序无关 (CP^2/3/4 实测 holds, 见 Codex audit 2026-05-15).
// 一般退化 ray 需要 reduced-word adjacent-swap sequence (sage 端 compute_sd_v5_full.sage:796
// 是参考实现). 索引重叠的 case 当前会跑错, 故 caller gate 必须挡住非 CP 数据.

export type IntMatrix = number[][];  // off-diag 用整数; 对角约定 0 (paper convention)

/** k×k 整数矩阵深拷贝. */
function copyM(S: IntMatrix): IntMatrix {
  return S.map(row => row.slice());
}

/** S → S' 单 wall (i, j) 更新. CP^n A_diag=0 退化版.
 *  Runtime assert: (i, j) 在 labelOrder 中相邻且 rank(i) + 1 == rank(j).
 *  Caller (propagateExactMatrices) 用 detectAllWallPairs 检出 pair, 保证此前置条件. */
export function applyWallCrossingCpA0(S: IntMatrix, i: number, j: number, labelOrder: number[]): IntMatrix {
  const n = S.length;
  // Sanity: (i, j) 相邻 + 顺序对.
  const ri = labelOrder.indexOf(i);
  const rj = labelOrder.indexOf(j);
  // ascending labelOrder 下 i = high-proj (paper d-order 在前), j = low-proj 紧后 → ri = rj + 1.
  if (ri < 0 || rj < 0 || ri !== rj + 1) {
    throw new Error(`applyWallCrossingCpA0: (i=${i}, j=${j}) 在 labelOrder=${JSON.stringify(labelOrder)} 中不相邻或顺序错 (rank ${ri}, ${rj})`);
  }
  const S2 = copyM(S);
  for (let k = 0; k < n; k++) {
    if (k === i || k === j) continue;
    // column j: S'_{kj} = S_{kj} - S_{ki} · S_{ij}
    S2[k][j] = S[k][j] - S[k][i] * S[i][j];
    // row j: S'_{jk} = S_{jk} + S_{ji} · S_{ik}   (A_diag=0 下两 case 公式相同)
    S2[j][k] = S[j][k] + S[j][i] * S[i][k];
  }
  return S2;
}

/** Punctures 在 d 方向的 projection **升序** label 数组.
 *  proj_k = Im(u_k · e^{i·d}). 升序排, 返回 puncture index 数组.
 *
 *  ⚠️ 跟 paper / sage / UI 主代码的 d-order 约定方向相反 — 它们用降序
 *  (projection 大的 label 在前, "最左"). detectAllWallPairs 在 push pair 时
 *  内部反转一次回到降序约定. 想直接拿降序的 caller 自己 reverse() 或写 helper. */
export function ascendingProjectionOrderAt(d: number, punctures: { re: number; im: number }[]): number[] {
  const sd = Math.sin(d), cd = Math.cos(d);
  const proj = punctures.map((u, k) => ({ k, p: u.re * sd + u.im * cd }));
  proj.sort((a, b) => a.p - b.p);
  return proj.map(e => e.k);
}

/** 相邻 chamber 间穿过的单 wall (i, j). detectAllWallPairs 的便利单 pair 版本. */
export function detectWallPair(dA: number, dB: number, punctures: { re: number; im: number }[]): [number, number] | null {
  const all = detectAllWallPairs(dA, dB, punctures);
  return all.length === 0 ? null : all[0];
}

/** 返回相邻 chamber 间穿过的所有 (i, j) wall pairs.
 *  CP^n 等对称 dataset 单 ray 上常多对 (i, j) 同时 swap (退化 ray);
 *  例如 CP^3 ray π/4 上 (2,3) 跟 (1,0) 同时交换. caller 对每对独立调
 *  applyWallCrossingCpA0.
 *
 *  返回的 (i, j) 满足 paper 降序 d-order 约定: i = high-proj 排前面, j = low-proj 紧后.
 *
 *  ⚠️ 退化 ray 多 pair sequential apply 一般 NOT commutative — pair 2 公式读
 *  S[k'][i2] 等 entry, 若 k'∈{i1, j1} 则会拿到 pair 1 已写入的更新. 当前实现
 *  依赖 "CP^n A_diag=0 对称 case 经验性 commute" (CP^2/3/4 实测验证, Codex audit
 *  2026-05-15). 不要把本函数当一般 wall-crossing 多 pair 规则推广 — 一般 case
 *  需要 reduced-word adjacent-swap sequence, 见 sage compute_sd_v5_full.sage:796. */
export function detectAllWallPairs(dA: number, dB: number, punctures: { re: number; im: number }[]): Array<[number, number]> {
  const labelsA = ascendingProjectionOrderAt(dA, punctures);
  const labelsB = ascendingProjectionOrderAt(dB, punctures);
  const pairs: Array<[number, number]> = [];
  let r = 0;
  while (r < labelsA.length - 1) {
    if (labelsA[r] !== labelsB[r] && labelsA[r] === labelsB[r + 1] && labelsA[r + 1] === labelsB[r]) {
      // ascending labelsA[r] = lower-proj, labelsA[r+1] = higher-proj.
      // paper 降序: (i, j) i = high-proj 排前. push (labelsA[r+1], labelsA[r]).
      pairs.push([labelsA[r + 1], labelsA[r]]);
      r += 2;
    } else {
      r += 1;
    }
  }
  return pairs;
}

/** 从 base chamber 出发, 沿 chambers (按 d 升序排) 链式应用 wall-crossing.
 *  返回 chamberIdx → IntMatrix. 未能传播的 chamber 不在 map 中. */
export function propagateExactMatrices(
  baseChamberIdx: number,
  baseMatrix: IntMatrix,
  chambers: { d: number; originalIdx: number }[],   // 已按 d 排序; originalIdx = dataset.chambers[].index
  punctures: { re: number; im: number }[],
): Map<number, IntMatrix> {
  // 在 sorted chambers 里找 base 的位置.
  const baseSortedPos = chambers.findIndex(c => c.originalIdx === baseChamberIdx);
  if (baseSortedPos < 0) return new Map();
  const result = new Map<number, IntMatrix>();
  result.set(baseChamberIdx, copyM(baseMatrix));
  // 向上 (d 增) 走
  let S = baseMatrix;
  for (let pos = baseSortedPos; pos < chambers.length - 1; pos++) {
    const cur = chambers[pos], next = chambers[pos + 1];
    const walls = detectAllWallPairs(cur.d, next.d, punctures);
    if (walls.length === 0) break;
    const labelOrder = ascendingProjectionOrderAt(cur.d, punctures);
    for (const [i, j] of walls) S = applyWallCrossingCpA0(S, i, j, labelOrder);
    result.set(next.originalIdx, copyM(S));
  }
  // 向下 (d 减) 走 — 用反向公式.
  S = baseMatrix;
  for (let pos = baseSortedPos; pos > 0; pos--) {
    const cur = chambers[pos], prev = chambers[pos - 1];
    const walls = detectAllWallPairs(prev.d, cur.d, punctures);
    if (walls.length === 0) break;
    const labelOrder = ascendingProjectionOrderAt(prev.d, punctures);
    for (const [i, j] of walls) S = applyWallCrossingCpA0Inverse(S, i, j, labelOrder);
    result.set(prev.originalIdx, copyM(S));
  }
  return result;
}

/** 反向 wall-crossing (B → A). CP^n A_diag=0 退化版.
 *   S^A_{kj} = S^B_{kj} + S^B_{ki} · S^B_{ij}    (列符号相反)
 *   S^A_{jk} = S^B_{jk} - S^B_{ji} · S^B_{ik}    (行符号相反, A_diag=0 下 sandwich = id)
 *   其他不变.
 *  Runtime assert 同 forward. */
export function applyWallCrossingCpA0Inverse(S: IntMatrix, i: number, j: number, labelOrder: number[]): IntMatrix {
  const n = S.length;
  const ri = labelOrder.indexOf(i);
  const rj = labelOrder.indexOf(j);
  // ascending labelOrder 下 i = high-proj (paper d-order 在前), j = low-proj 紧后 → ri = rj + 1.
  if (ri < 0 || rj < 0 || ri !== rj + 1) {
    throw new Error(`applyWallCrossingCpA0Inverse: (i=${i}, j=${j}) 在 labelOrder=${JSON.stringify(labelOrder)} 中不相邻或顺序错 (rank ${ri}, ${rj})`);
  }
  const S2 = copyM(S);
  for (let k = 0; k < n; k++) {
    if (k === i || k === j) continue;
    S2[k][j] = S[k][j] + S[k][i] * S[i][j];
    S2[j][k] = S[j][k] - S[j][i] * S[i][k];
  }
  return S2;
}
