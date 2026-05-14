// Wall-crossing 精确传播 — A_diag=0 退化版 (前端 ISC symbolic display 捷径).
//
// ⚠️ Scope hard-locked: 本文件公式只在以下条件下成立, caller (main.ts
// runIscMatrix) 必须用 (m_sizes 全 1) ∧ (A_diag 全 0) ∧ (base 全整数) ∧
// (pairwise-disjoint degenerate walls, runtime-checked) 四重 gate 收窄到该范围.
// 不要把这里的公式当一般 wall-crossing 规则推广 — 主算法在
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
// Degenerate ray (单 wall 多 swap pair): A_diag=0 下 pairwise-disjoint
// (即 ∀ pair1 ≠ pair2, {i1,j1} ∩ {i2,j2} = ∅) ⇒ sequential apply commute
// 是 update 公式的局部代数性质 (read/write set 解耦 + (j1,j2) (j2,j1) 唯一
// 重叠 entry 逐项展开等式成立), 不依赖 CP^n 对称性也不依赖整数性. 代数验证
// 跟 CP^2/3/4 all-base bit-exact 实测一致 (Codex audit 2026-05-15).
// pairwise-disjoint 由 propagateExactMatrices 内 hasIndexOverlap runtime guard
// 捕获; 索引重叠 case 当前会 short-circuit, 该 chamber 落回 RIES fallback.
// 一般退化 ray (索引重叠) 走 sage compute_sd_v5_full.sage:796 reduced-word 实现.

export type IntMatrix = number[][];  // off-diag 用整数; 对角约定 0 (paper convention)

// ---------------- Integer monodromy factor (A_diag=0 gate 内) ----------------
//
// 给定 propagated std S_d 整数矩阵 M + 该 chamber 的 -d label 排序, 整数闭算
//   e^{2πi M_d} = (S_d^-)^{-1} · exp(2πi δ_u A) · S_d^+
// 在 A_diag=0 时 exp 因子 = I, 即 md_int = (S_d^-)^{-1} · S_d^+.
// S_d^± 在 -d-label 排序后 unipotent triangular 整数, det=1, inverse 闭在 Z.
// 用 Neumann 级数 (I + L_-)^{-1} = Σ_{k=0}^{n-1} (-L_-)^k 算 (S^-)^{-1}, 全整数.
//
// 跟前端 main.ts stokesTriangularFactor / dLabels 完全同 sign / label 约定:
//   labels[k] = puncture k 的 DESCENDING projection rank (1..n).
//   S^+[I,J] = M[I][J] if labels[I] < labels[J] else (I==J ? 1 : 0).
//   S^-[I,J] = -M[I][J] if labels[I] > labels[J] else (I==J ? 1 : 0).

function identInt(n: number): IntMatrix {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => i === j ? 1 : 0));
}

function mmulInt(A: IntMatrix, B: IntMatrix): IntMatrix {
  const n = A.length, k = B.length, m = B[0].length;
  const out: IntMatrix = Array.from({ length: n }, () => Array(m).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    let s = 0;
    for (let l = 0; l < k; l++) s += A[i][l] * B[l][j];
    out[i][j] = s;
  }
  return out;
}

export function stokesPlusInt(M: IntMatrix, labels: number[]): IntMatrix {
  const n = M.length;
  const out = identInt(n);
  for (let I = 0; I < n; I++) for (let J = 0; J < n; J++) {
    if (I !== J && labels[I] < labels[J]) out[I][J] = M[I][J];
  }
  return out;
}

export function stokesMinusInt(M: IntMatrix, labels: number[]): IntMatrix {
  const n = M.length;
  const out = identInt(n);
  for (let I = 0; I < n; I++) for (let J = 0; J < n; J++) {
    if (I !== J && labels[I] > labels[J]) out[I][J] = -M[I][J];
  }
  return out;
}

/** Integer inverse of unipotent matrix I + L (L 在 -d-label 排序后 strictly
 *  triangular, nilpotent). Neumann 级数, 全整数无除法.
 *  caller 保证 S 的对角全 1; off-diag 非零结构是 strictly triangular w.r.t.
 *  某个排序 (这里是 labels DESCENDING). */
export function minvIntUnipotent(S: IntMatrix): IntMatrix {
  const n = S.length;
  const L: IntMatrix = S.map((row, i) => row.map((v, j) => i === j ? 0 : v));
  const result = identInt(n);
  let term: IntMatrix = identInt(n);
  let sign = 1;
  for (let k = 1; k < n; k++) {
    term = mmulInt(term, L);
    sign = -sign;
    let anyNonzero = false;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (term[i][j] !== 0) {
        anyNonzero = true;
        result[i][j] += sign * term[i][j];
      }
    }
    if (!anyNonzero) break;
  }
  return result;
}

/** 整数 monodromy factor (A_diag=0 gate 内). */
export function monodromyFactorInt(M: IntMatrix, labels: number[]): IntMatrix {
  const Splus = stokesPlusInt(M, labels);
  const Sminus = stokesMinusInt(M, labels);
  const SminusInv = minvIntUnipotent(Sminus);
  return mmulInt(SminusInv, Splus);
}

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
 *  Sequential apply commutativity: A_diag=0 下 pairwise-disjoint ⇒ commute 是
 *  update 公式的局部代数性质 (见文件头说明), 不依赖 CP^n 对称性. caller 通过
 *  propagateExactMatrices 的 hasIndexOverlap guard 保证此前置. 索引重叠 case
 *  走 sage compute_sd_v5_full.sage 的 reduced-word adjacent-swap sequence. */
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
    if (hasIndexOverlap(walls)) break;  // commute 假设不成立, 该方向到此为止 (caller fallback).
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
    if (hasIndexOverlap(walls)) break;
    const labelOrder = ascendingProjectionOrderAt(prev.d, punctures);
    for (const [i, j] of walls) S = applyWallCrossingCpA0Inverse(S, i, j, labelOrder);
    result.set(prev.originalIdx, copyM(S));
  }
  return result;
}

/** 退化 ray 多 pair 索引是否重叠. CP^2/3/4 实测无重叠 (Codex audit 2026-05-15).
 *  有重叠 ⇒ sequential apply 顺序敏感, 当前 commute 假设失效, caller bail out. */
function hasIndexOverlap(pairs: Array<[number, number]>): boolean {
  const seen = new Set<number>();
  for (const [i, j] of pairs) {
    if (seen.has(i) || seen.has(j)) return true;
    seen.add(i); seen.add(j);
  }
  return false;
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
