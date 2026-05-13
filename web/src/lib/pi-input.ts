// 通用有理数 / 小数 parser. 支持:
//   "5", "-2.7", "+1.5", "0.5"  → 直接数
//   "1/3", "-1/2", "1.5/-2.3"   → 分式 (分子/分母都可带 +/- sign + 小数)
// 返回 null 表示无效输入. 用于 d 输入 (π 单位) 跟 U/A 表实/虚部输入.
// 不接受 U+2212 minus sign — 解析前自行 normalize.

export function parseRational(s: string): number | null {
  s = s.trim();
  if (s === '') return null;
  const m = s.match(/^([+-]?\d+(?:\.\d+)?)\s*\/\s*([+-]?\d+(?:\.\d+)?)$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
    return a / b;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// d 输入框: 单位固定 π, 沿用通用 parser. 返回 d / π 的 number, null 表示无效.
export function parsePiInput(s: string): number | null {
  return parseRational(s);
}

/** 把 d/π 数字格式化成显示文本; 简短小数 (4 位), 去尾 0. */
export function formatPi(v: number): string {
  if (!Number.isFinite(v)) return '0';
  let s = v.toFixed(4);
  // 去尾 0 跟空小数点
  s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return s;
}
