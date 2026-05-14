// CP^n 整数 Stokes 矩阵的 wall-crossing 精确传播 (A_diag = 0 假设).
//
// 从一个 base chamber 的整数矩阵 S^{(0)} 出发, 沿 d-direction 链式应用
// wall-crossing 规则推出其他 chamber 的整数矩阵, 零误差累积.
//
// Wall-crossing 规则 (memory: project_Sd_wall_crossing_rule.md):
// 跨 wall τ = -arg(u_j - u_i), d-order ... i j ... → ... j i ...:
//   - S'_{ab} = S_{ab}      若 a ≠ j 且 b ≠ j (含 (i, j) 本身)
//   - S'_{ji} = S_{ji}      (A_diag = 0 时 sandwich = identity)
//   - S'_{kj} = S_{kj} - S_{ki} · S_{ij}     k ≠ i, j (column j)
//   - S'_{jk} = S_{jk} + S_{ji} · S_{ik}     若 k 在 d-order 中 i, j 之前
//   - S'_{jk} = S_{jk} + S'_{ji} · S_{ik}    若 k 在 i, j 之后
//
// A_diag = 0 时 S'_{ji} = S_{ji}, 两种情况公式一致, 直接 S_{ji}·S_{ik}.

export type IntMatrix = number[][];  // off-diag 用整数; 对角约定 0 (paper convention)

/** k×k 整数矩阵深拷贝. */
function copyM(S: IntMatrix): IntMatrix {
  return S.map(row => row.slice());
}

/** S → S' 单 wall (i, j) 更新. CP^n A_diag=0 简化版. */
export function applyWallCrossing(S: IntMatrix, i: number, j: number, labelOrder: number[]): IntMatrix {
  const n = S.length;
  const S2 = copyM(S);
  // rank in labelOrder: lower index in labelOrder = "smaller label" = earlier in d-order
  const rankOf: Record<number, number> = {};
  for (let r = 0; r < labelOrder.length; r++) rankOf[labelOrder[r]] = r;
  const ri = rankOf[i], rj = rankOf[j];
  // 一致性: 假设 i, j 在 labelOrder 中相邻且 ri < rj (caller 保证)
  for (let k = 0; k < n; k++) {
    if (k === i || k === j) continue;
    // column j: S'_{kj} = S_{kj} - S_{ki} · S_{ij}
    S2[k][j] = S[k][j] - S[k][i] * S[i][j];
    // row j: S'_{jk} = S_{jk} + S_{ji} · S_{ik}   (A_diag=0 下两 case 公式相同)
    S2[j][k] = S[j][k] + S[j][i] * S[i][k];
  }
  // 防御性: 让 TS 知道 ri, rj 用过
  void ri; void rj;
  return S2;
}

/** d 方向的 label 排序: rank by Im(u_k · e^{i·d}). 升序排, 返回 label index 数组. */
export function dLabelsAt(d: number, punctures: { re: number; im: number }[]): number[] {
  // proj_k = Im(u_k · e^{i·d}) = u_k.re·sin(d) + u_k.im·cos(d)
  const sd = Math.sin(d), cd = Math.cos(d);
  const proj = punctures.map((u, k) => ({ k, p: u.re * sd + u.im * cd }));
  proj.sort((a, b) => a.p - b.p);
  // labelOrder[r] = puncture index at rank r (smallest projection first)
  return proj.map(e => e.k);
}

/** 相邻 chamber 间穿过的 wall (i, j). caller 保证 chamberB.d > chamberA.d 仅差一个 ray.
 *  约定 (跟 paper / 项目 memory 一致):
 *    label = descending rank of Im(u_k · e^{i·d}), label 最小者 = 最 "左".
 *    d-order BEFORE = (..., i, j, ...), AFTER = (..., j, i, ...).
 *    dLabelsAt 内部按 projection 升序, 所以 memory 的 d-order 是 reversed view.
 *  返回 (i, j) 跟 memory 公式一致. */
export function detectWallPair(dA: number, dB: number, punctures: { re: number; im: number }[]): [number, number] | null {
  const all = detectAllWallPairs(dA, dB, punctures);
  return all.length === 0 ? null : all[0];
}

/** 返回相邻 chamber 间穿过的所有 (i, j) wall pairs.
 *  CP^n 等对称 dataset 单条 ray 上常多对 (i, j) 同时 swap (退化 ray);
 *  例如 CP^3 ray π/4 上 (2,3) 跟 (1,0) 同时交换. caller 对每对独立调 applyWallCrossing.
 *  注意: 一般退化 ray 上多 pair 的乘积并非顺序无关 — pair 2 公式读 S[k'][i2] 等
 *  entry, 若 k'∈{i1,j1} 则会拿到 pair 1 已写入的更新. 当前实现依赖 "CP^n A_diag=0
 *  对称 case 经验性 commute" — caller (main.ts runIscMatrix) 已用 m_sizes 全 1 +
 *  A_diag 全 0 + base 整数 三重 gate 收窄到该 case. 不要把本函数当作一般 wall-
 *  crossing 多 pair 规则推广. */
export function detectAllWallPairs(dA: number, dB: number, punctures: { re: number; im: number }[]): Array<[number, number]> {
  const labelsA = dLabelsAt(dA, punctures);
  const labelsB = dLabelsAt(dB, punctures);
  const pairs: Array<[number, number]> = [];
  let r = 0;
  while (r < labelsA.length - 1) {
    if (labelsA[r] !== labelsB[r] && labelsA[r] === labelsB[r + 1] && labelsA[r + 1] === labelsB[r]) {
      // ascending labelsA[r] = lower-proj puncture, labelsA[r+1] = higher-proj.
      // memory descending: (i, j) with i = high-proj 排前面, j = low-proj 紧后. → (labelsA[r+1], labelsA[r]).
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
    const labelOrder = dLabelsAt(cur.d, punctures);
    for (const [i, j] of walls) S = applyWallCrossing(S, i, j, labelOrder);
    result.set(next.originalIdx, copyM(S));
  }
  // 向下 (d 减) 走 — 用反向公式.
  S = baseMatrix;
  for (let pos = baseSortedPos; pos > 0; pos--) {
    const cur = chambers[pos], prev = chambers[pos - 1];
    const walls = detectAllWallPairs(prev.d, cur.d, punctures);
    if (walls.length === 0) break;
    const labelOrder = dLabelsAt(prev.d, punctures);
    for (const [i, j] of walls) S = applyWallCrossingInverse(S, i, j, labelOrder);
    result.set(prev.originalIdx, copyM(S));
  }
  return result;
}

/** 反向 wall-crossing (B → A): A_diag=0 下
 *   S^A_{kj} = S^B_{kj} + S^B_{ki} · S^B_{ij}    (列符号相反)
 *   S^A_{jk} = S^B_{jk} - S^B_{ji} · S^B_{ik}    (行符号相反, A_diag=0 下 sandwich = id)
 *   其他不变. */
export function applyWallCrossingInverse(S: IntMatrix, i: number, j: number, _labelOrder: number[]): IntMatrix {
  const n = S.length;
  const S2 = copyM(S);
  for (let k = 0; k < n; k++) {
    if (k === i || k === j) continue;
    S2[k][j] = S[k][j] + S[k][i] * S[i][j];
    S2[j][k] = S[j][k] - S[j][i] * S[i][k];
  }
  return S2;
}
