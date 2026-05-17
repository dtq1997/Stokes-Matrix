// A_n Frobenius manifold mock dataset (n adjustable like cpn).
// 谱 μ̂ = (2k - n - 1)/(2(n+1)) for k = 1, ..., n —— A_n Coxeter Frobenius manifold
// 标准谱 (Dubrovin LNM 1620 §5). 形式 monodromy e^{2πi μ̂} 是 2(n+1) 次单位根.
//
// V 用 block-diagonal mock: 把谱配对 (k, n+1-k) → ±μ_k, 每对放成 2×2 skew 块
//   [[0, iμ_k], [-iμ_k, 0]]
// n 奇时中间 1×1 块为 0.
//
// ⚠ NOT 严格 A_n Frobenius manifold 的 V 矩阵 — 严格 V 需要 Painlevé VI / 高阶
// isomonodromy 数值积分 (Duke CDG §22 只给 A_3 t→0 limit). 这个 mock 谱对,
// 形式 monodromy 谱对, 但跨块 entry 全为 0 (真 V 会有非平凡耦合).
//
// 用途: 让用户在 sd-viz 里直观看到 "μ̂ 非整数 → 子矩阵特征值带简单单位根" 的对比.

function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a || 1;
}

/** 把 sign · num / den 化简成 expr 字符串 (i 为虚单位); num/den 视为正分数. */
function muExpr(num: number, den: number, sign: 1 | -1): string {
  if (num === 0) return '0';
  const g = gcd(num, den);
  const n = num / g;
  const d = den / g;
  const signStr = sign < 0 ? '-' : '';
  const numPart = n === 1 ? 'i' : `${n}*i`;
  return d === 1 ? `${signStr}${numPart}` : `${signStr}${numPart}/${d}`;
}

/** u_α 表达式: α/(n-1) 化简 (端点 0, 1, 中间分数). */
function uExpr(alpha: number, n: number): string {
  if (n <= 1) return '0';
  if (alpha === 0) return '0';
  if (alpha === n - 1) return '1';
  const g = gcd(alpha, n - 1);
  return `${alpha / g}/${(n - 1) / g}`;
}

export function buildAnDataset(n: number): {
  punctures: { re: number; im: number; expr?: string }[];
  A_diag: number[];
  A_diag_block: number[][];
  A_off: { i: number; j: number; a: number; b: number; re: number; im: number; expr?: string }[];
  m_sizes: number[];
} {
  // U: n distinct real values in [0, 1], u_α = α/(n-1) (Duke convention 推广).
  const punctures: { re: number; im: number; expr?: string }[] = [];
  for (let alpha = 0; alpha < n; alpha++) {
    const val = n > 1 ? alpha / (n - 1) : 0;
    punctures.push({ re: val, im: 0, expr: uExpr(alpha, n) });
  }

  const A_diag = Array.from({ length: n }, () => 0);
  const A_diag_block = Array.from({ length: n }, () => [0]);
  const A_off: { i: number; j: number; a: number; b: number; re: number; im: number; expr?: string }[] = [];

  // 全部 off-diag 默认 0. 只有同一 2×2 块 (i 偶 + j=i+1) 上填 ±i·μ_k.
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const sameBlock = Math.floor(i / 2) === Math.floor(j / 2) && Math.abs(i - j) === 1;
      let re = 0, im = 0, expr = '0';
      if (sameBlock) {
        const blockIdx = Math.floor(i / 2); // 0-indexed pair
        const k = blockIdx + 1;             // 1-indexed pair within μ̂ pairing
        const muNum = n + 1 - 2 * k;
        const muDen = 2 * (n + 1);
        if (muNum > 0) {
          // (i, i+1) where i even: +iμ; (i, i-1) where i odd: -iμ
          const sign: 1 | -1 = i < j ? 1 : -1;
          im = sign * (muNum / muDen);
          expr = muExpr(muNum, muDen, sign);
        }
      }
      A_off.push({ i, j, a: 0, b: 0, re, im, expr });
    }
  }

  return { punctures, A_diag, A_diag_block, A_off, m_sizes: Array.from({ length: n }, () => 1) };
}
