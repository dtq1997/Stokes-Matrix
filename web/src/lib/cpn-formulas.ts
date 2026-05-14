// CP^{K-1} 经典例子 (Guzzetti X gauge) 的精确表达式合成.
// 数据本身 (re/im 浮点) 仍由 cp{N}.json 提供; 这里只生成 expr 字符串覆盖上去.
//
// u_n = K * e^(2*pi*i*n/K),                     n = 0..K-1
// A[i,j] = (1/(2K)) * Σ_{n=0..K-1} (K-1-2n) * e^(i*pi*(2n+1)*(j-i)/K)
//        = 0 if i==j (μ_diag 求和为 0).

function gcd(a: number, b: number): number {
  a = Math.abs(a); b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a || 1;
}

/** CP^{K-1} 的第 n 个 puncture u_n 表达式. n = 0..K-1. */
export function cpnPunctureExpr(K: number, n: number): string {
  if (n === 0) return String(K);
  if (2 * n === K) return `-${K}`;
  const g = gcd(2 * n, K);
  const a = (2 * n) / g;
  const b = K / g;
  const pre = a === 1 ? '' : `${a}*`;
  const denom = b === 1 ? '' : `/${b}`;
  return `${K}*e^(${pre}pi*i${denom})`;
}

/** CP^{K-1} 的 A[i,j] 表达式 (0-indexed 块下标; CP^n 所有 m_k=1, 跟 sub-index 无关). */
export function cpnAEntryExpr(K: number, i: number, j: number): string {
  if (i === j) return '0';
  const k = j - i;
  const denom = 2 * K;
  const terms: string[] = [];
  for (let n = 0; n < K; n++) {
    const coef = K - 1 - 2 * n;
    if (coef === 0) continue;
    const num = (2 * n + 1) * k;
    // exponent = num*pi*i/K. 化简 num/K.
    const g = gcd(Math.abs(num), K);
    const a = num / g;
    const b = K / g;
    let powTerm: string;
    if (b === 1) {
      const am = ((a % 2) + 2) % 2;  // 整数指数: a*pi*i; 取 mod 2
      powTerm = am === 0 ? '1' : '-1';
    } else {
      // 把 a 收进 [0, 2b) 防止过大数字
      const am = ((a % (2 * b)) + 2 * b) % (2 * b);
      const pre = am === 1 ? '' : `${am}*`;
      powTerm = `e^(${pre}pi*i/${b})`;
    }
    const sign = coef > 0 ? (terms.length === 0 ? '' : '+') : '-';
    const absCoef = Math.abs(coef);
    const isUnit = powTerm === '1' || powTerm === '-1';
    let body: string;
    if (isUnit) {
      // ±absCoef * (±1) → 折叠成 ±absCoef
      const folded = powTerm === '1' ? absCoef : -absCoef;
      body = folded === 0 ? '0' : String(folded);
      // 重新算正负号写入 terms (覆盖前面的 sign 逻辑)
      if (terms.length === 0) terms.push(body);
      else terms.push(folded >= 0 ? `+${body}` : `${body}`);
      continue;
    }
    const coefStr = absCoef === 1 ? '' : `${absCoef}*`;
    body = `${coefStr}${powTerm}`;
    terms.push(`${sign}${body}`);
  }
  if (terms.length === 0) return '0';
  return `(1/${denom})*(${terms.join('')})`;
}

/** 给 CP^{K-1} 的 punctures / A_off 附上 expr 字段, 直接 mutate 传入数组. */
export function attachCpnExprs(K: number, punctures: { re: number; im: number; expr?: string }[],
                                aOff: { i: number; j: number; a?: number; b?: number; re: number; im: number; expr?: string }[]) {
  for (let n = 0; n < punctures.length && n < K; n++) {
    punctures[n].expr = cpnPunctureExpr(K, n);
  }
  for (const e of aOff) {
    e.expr = cpnAEntryExpr(K, e.i, e.j);
  }
}
