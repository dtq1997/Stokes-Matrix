// 本地 simple-identify (整数/有理/√有理/π·有理). 跟 server push_server.py 的
// _simple_identify 严格一致 — 每个 cell 渲染都跑, 必须秒级.
//
// SSOT: 所有矩阵 (Stokes / Omega / 未来其他) 都走这个模块. cell 渲染逻辑:
//   1) 拿浮点 (re, im)
//   2) localSimpleIdentify → 拿到 value-form 表达式 (可选)
//   3) 失败回退到 iscCache (后端 RIES/WA 结果)
//   4) 都失败 → 显示浮点

/** sqrt(n) 化简: 提出完美平方因子. n > 0 整数. */
function sqrtToken(n: number): string {
  if (n <= 0) return String(n);
  const s = Math.floor(Math.sqrt(n));
  if (s * s === n) return String(s);
  let a = 1;
  let m = n;
  for (let d = 2; d * d <= m; d++) {
    while (m % (d * d) === 0) {
      m = m / (d * d);
      a = a * d;
    }
  }
  if (a === 1) return `sqrt(${m})`;
  if (m === 1) return String(a);
  return `${a}*sqrt(${m})`;
}

/** 连分数法找 x 的最接近有理数 p/q, q ≤ maxDenom. 返回 null 仅 x 非有限. */
export function approxFrac(x: number, maxDenom: number): { n: number; d: number } | null {
  if (!Number.isFinite(x)) return null;
  if (Math.abs(x - Math.round(x)) < 1e-15) return { n: Math.round(x), d: 1 };
  let sign = 1;
  if (x < 0) { sign = -1; x = -x; }
  // CF expansion: track convergents h_k / k_k.
  let h0 = 0, k0 = 1, h1 = 1, k1 = 0;
  let xx = x;
  for (let iter = 0; iter < 64; iter++) {
    const a = Math.floor(xx);
    const h2 = a * h1 + h0;
    const k2 = a * k1 + k0;
    if (k2 > maxDenom) break;
    h0 = h1; k0 = k1;
    h1 = h2; k1 = k2;
    const frac = xx - a;
    if (frac < 1e-15) break;
    xx = 1 / frac;
  }
  return { n: sign * h1, d: k1 };
}

/** 试图识别浮点 v 的简单闭式. 返回值表达式字符串 (能喂给 expr-parser) 或 null.
 *  tol 默认 1e-6: precomputed dataset (CP^n medium 精度) 经 chamber 间传播后
 *  entry 噪声达 ~5e-7, 严容差识别不到整数. 调用方可显式压低 tol 防误识别. */
export function simpleIdentifyValue(v: number, maxDenom = 1000, tol = 1e-6): string | null {
  if (!Number.isFinite(v)) return null;
  const av = Math.abs(v);
  const tol_abs = tol * Math.max(av, 1);
  // 1) integer
  const n = Math.round(v);
  if (Math.abs(v - n) < tol_abs) return String(n);
  // 2) rational p/q
  const r = approxFrac(v, maxDenom);
  if (r && Math.abs(v - r.n / r.d) < tol_abs) {
    return `${r.n}/${r.d}`;
  }
  // 3) sqrt of rational: v^2 = p/q  →  v = ±sqrt(p/q)
  if (av > 0) {
    const sq = v * v;
    const rsq = approxFrac(sq, maxDenom);
    if (rsq && rsq.n > 0 && Math.abs(sq - rsq.n / rsq.d) < tol_abs * Math.max(sq, 1)) {
      const sign = v < 0 ? '-' : '';
      const numTok = sqrtToken(rsq.n);
      const denTok = sqrtToken(rsq.d);
      let body: string;
      if (rsq.d === 1) {
        body = numTok;
      } else {
        body = numTok === '1' ? `1/${denTok}` : `${numTok}/${denTok}`;
      }
      if (body.includes('sqrt')) return `${sign}${body}`;
      // 否则 body 已是纯有理, 上面 step 2 应已抓到, 不重复
    }
  }
  // 4) π · rational
  const rp = approxFrac(v / Math.PI, maxDenom);
  if (rp && rp.n !== 0 && Math.abs(v - (rp.n / rp.d) * Math.PI) < tol_abs) {
    const p = rp.n, q = rp.d;
    if (Math.abs(p) === 1 && q === 1) return p < 0 ? '-pi' : 'pi';
    if (q === 1) return `${p}*pi`;
    if (Math.abs(p) === 1) return p > 0 ? `pi/${q}` : `-pi/${q}`;
    return `${p}*pi/${q}`;
  }
  return null;
}

/** 把 re/im 各自的值表达式合并成单个复数表达式 (供 expr-parser 渲染). */
export function buildComplexExprFromForms(reForm: string | null, imForm: string | null): string | null {
  const r = reForm ?? '0';
  const im = imForm ?? '0';
  const reZero = r === '0' || r === '+0' || r === '-0';
  const imZero = im === '0' || im === '+0' || im === '-0';
  if (reZero && imZero) return '0';
  if (imZero) return r;
  let imPart: string;
  if (im === '1' || im === '+1') imPart = 'i';
  else if (im === '-1') imPart = '-i';
  else imPart = `(${im})*i`;
  if (reZero) return imPart;
  return imPart.startsWith('-') ? `${r}${imPart}` : `${r}+${imPart}`;
}
