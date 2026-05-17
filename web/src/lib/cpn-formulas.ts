// CP^{K-1} 经典例子 (Guzzetti X gauge) 的精确表达式 + 数据合成.
// 数据本身 (re/im 浮点) 客户端按公式直接算出, 不依赖 cp{N}.json.
//
// 归一化 (canonical / 'guzzetti' variant):
//   u_n = e^(2*pi*i*n/K),                       n = 0..K-1
// (原 sage export 用 u_n = K * e^(...), 这里除掉 K 因子. U → U/K 等同 z → z·K
// 的 rescale, Stokes 矩阵不变. 显示更自然: CP^2 punctures 落在单位圆.)
//
// A[i,j] = (1/(2K)) * Σ_{n=0..K-1} (K-1-2n) * e^(i*pi*(2n+1)*(j-i)/K)
//        = 0 if i==j (μ_diag 求和为 0). A 不随 U 缩放.
//
// expr 字符串生成后再对分子/分母做 gcd 化简 (eg. K=3,5,7,...: 分子分母同除 2).
//
// Variant 字段 = QH^*(CP^{K-1}) 的不同 marked basis (差 σ ∈ S_K 置换),
// 都是同一辫子轨道的代表. 用户拍板: U 同 diagonal (允许差 σ), A 各不相同.

export type CpnVariant = 'guzzetti' | 'coxeter' | 'reversed';

/** σ(k) = canonical-index that goes to position k under this variant. */
function permIdx(K: number, variant: CpnVariant, k: number): number {
  switch (variant) {
    case 'guzzetti': return k;
    case 'coxeter':  return (k + 1) % K;
    case 'reversed': return ((K - 1 - k) % K + K) % K;
  }
}

function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a || 1;
}

/** CP^{K-1} 的第 n 个 puncture u_n 表达式 (归一化后: u_n = e^(2*pi*i*n/K)). */
export function cpnPunctureExpr(K: number, n: number, variant: CpnVariant = 'guzzetti'): string {
  const idx = permIdx(K, variant, n);
  if (idx === 0) return '1';
  if (2 * idx === K) return '-1';
  const g = gcd(2 * idx, K);
  const a = (2 * idx) / g;
  const b = K / g;
  const pre = a === 1 ? '' : `${a}*`;
  const denom = b === 1 ? '' : `/${b}`;
  return `e^(${pre}pi*i${denom})`;
}

/** CP^{K-1} 的 A[i,j] 表达式 (0-indexed 块下标; CP^n 所有 m_k=1, 跟 sub-index 无关).
 *  整体形式: (1/d) * (c_1 * t_1 + c_2 * t_2 + ...), d=2K, c_n=(K-1-2n), t_n=e^(...) 或 ±1.
 *  最后对 d 跟所有 |c| 取 gcd 同除化简 (eg. K=3,5,7,...: ±2 跟 2K 同除 2 → (1/K)*(...)).
 *  variant ≠ 'guzzetti' 时: A^σ_{ij} = A_{σ(i), σ(j)} (置换标号). */
export function cpnAEntryExpr(K: number, i: number, j: number, variant: CpnVariant = 'guzzetti'): string {
  const ri = permIdx(K, variant, i);
  const rj = permIdx(K, variant, j);
  if (ri === rj) return '0';
  const k = rj - ri;
  const denom = 2 * K;
  type Term = { coef: number; powTerm: string };  // powTerm = "1" or "e^(...)"
  const collected: Term[] = [];
  for (let n = 0; n < K; n++) {
    let coef = K - 1 - 2 * n;
    if (coef === 0) continue;
    const num = (2 * n + 1) * k;
    // exponent = num*pi*i/K. 化简 num/K.
    const g = gcd(Math.abs(num), K);
    const a = num / g;
    const b = K / g;
    let powTerm: string;
    if (b === 1) {
      // 整数指数 a*pi*i: e^(a*pi*i) = (-1)^a. 把符号吸进 coef, powTerm 留 "1".
      const am = ((a % 2) + 2) % 2;
      if (am === 1) coef = -coef;
      powTerm = '1';
    } else {
      const am = ((a % (2 * b)) + 2 * b) % (2 * b);
      const pre = am === 1 ? '' : `${am}*`;
      powTerm = `e^(${pre}pi*i/${b})`;
    }
    collected.push({ coef, powTerm });
  }
  if (collected.length === 0) return '0';
  // 同 powTerm 合并系数 (K=6,8,9,... 里同一个根 ζ 在多个 n 上出现).
  const merged = new Map<string, number>();
  for (const t of collected) merged.set(t.powTerm, (merged.get(t.powTerm) ?? 0) + t.coef);
  const aggregated: Term[] = [];
  for (const [powTerm, coef] of merged) if (coef !== 0) aggregated.push({ coef, powTerm });
  if (aggregated.length === 0) return '0';
  // 维持原顺序: 按"首次出现位置"排 (Map 已保 insertion order).
  collected.length = 0; for (const t of aggregated) collected.push(t);
  // gcd(denom, all |coef|) 同除化简.
  let g = denom;
  for (const t of collected) g = gcd(g, Math.abs(t.coef));
  const dRed = denom / g;
  const parts: string[] = [];
  for (let idx = 0; idx < collected.length; idx++) {
    const { coef: c0, powTerm } = collected[idx];
    const c = c0 / g;
    const sign = c < 0 ? '-' : (idx === 0 ? '' : '+');
    const absC = Math.abs(c);
    let body: string;
    if (powTerm === '1') {
      body = String(absC);
    } else if (absC === 1) {
      body = powTerm;
    } else {
      body = `${absC}*${powTerm}`;
    }
    parts.push(`${sign}${body}`);
  }
  const sum = parts.join('');
  if (dRed === 1) {
    return parts.length === 1 ? sum : `(${sum})`;
  }
  return `(1/${dRed})*(${sum})`;
}

/** 给 CP^{K-1} 的 punctures / A_off 附上 expr 字段, 直接 mutate 传入数组.
 *  punctures 同时被 1/K rescale (归一化到单位圆), A_off 不动 (residue 不随 U 缩放). */
export function attachCpnExprs(K: number, punctures: { re: number; im: number; expr?: string }[],
                                aOff: { i: number; j: number; a?: number; b?: number; re: number; im: number; expr?: string }[]) {
  for (let n = 0; n < punctures.length && n < K; n++) {
    punctures[n].expr = cpnPunctureExpr(K, n);
    punctures[n].re /= K;
    punctures[n].im /= K;
  }
  for (const e of aOff) {
    e.expr = cpnAEntryExpr(K, e.i, e.j);
  }
}

/** 数值求 A[i,j] = (1/(2K)) Σ_n (K-1-2n) e^(i*pi*(2n+1)*(j-i)/K). i==j 时为 0.
 *  variant 非 guzzetti 时按 σ 置换标号 (A^σ_{ij} = A_{σ(i), σ(j)}). */
function cpnAEntryNumeric(K: number, i: number, j: number, variant: CpnVariant = 'guzzetti'): { re: number; im: number } {
  const ri = permIdx(K, variant, i);
  const rj = permIdx(K, variant, j);
  if (ri === rj) return { re: 0, im: 0 };
  let re = 0, im = 0;
  const k = rj - ri;
  for (let n = 0; n < K; n++) {
    const coef = K - 1 - 2 * n;
    if (coef === 0) continue;
    const theta = Math.PI * (2 * n + 1) * k / K;
    re += coef * Math.cos(theta);
    im += coef * Math.sin(theta);
  }
  re /= 2 * K;
  im /= 2 * K;
  return { re, im };
}

/** 客户端按公式生成 QH^*(CP^{K-1}) 整个 dataset (替代 cp{N}.json fetch).
 *  - punctures: e^(2πin/K), n=0..K-1
 *  - A_diag = 0 (μ_diag 求和为 0)
 *  - A_off: K*(K-1) 个非对角 entry, 带精确 expr
 *  - m_sizes = [1]*K
 *  - rays / chambers 由前端 antiStokesRays 处填, 这里给空占位 (loadDataset 接管). */
export function buildCpnDataset(K: number, variant: CpnVariant = 'guzzetti'): {
  punctures: { re: number; im: number; expr?: string }[];
  A_diag: number[];
  A_diag_block: number[][];
  A_off: { i: number; j: number; a: number; b: number; re: number; im: number; expr?: string }[];
  m_sizes: number[];
} {
  const punctures: { re: number; im: number; expr?: string }[] = [];
  for (let n = 0; n < K; n++) {
    const idx = permIdx(K, variant, n);
    const ang = 2 * Math.PI * idx / K;
    punctures.push({ re: Math.cos(ang), im: Math.sin(ang), expr: cpnPunctureExpr(K, n, variant) });
  }
  const A_diag = Array.from({ length: K }, () => 0);
  const A_diag_block = Array.from({ length: K }, () => [0]);
  const A_off: { i: number; j: number; a: number; b: number; re: number; im: number; expr?: string }[] = [];
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < K; j++) {
      if (i === j) continue;
      const v = cpnAEntryNumeric(K, i, j, variant);
      A_off.push({ i, j, a: 0, b: 0, re: v.re, im: v.im, expr: cpnAEntryExpr(K, i, j, variant) });
    }
  }
  const m_sizes = Array.from({ length: K }, () => 1);
  return { punctures, A_diag, A_diag_block, A_off, m_sizes };
}
