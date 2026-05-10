// d 输入框: 单位固定 π, 支持 "1/3", "-1/2", "0.5", "5", "-2.7" 等.
// 返回 d / π 的 number, null 表示无效输入.

export function parsePiInput(s: string): number | null {
  s = s.trim();
  if (s === '') return null;
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
    return a / b;
  }
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  return null;
}

/** 把 d/π 数字格式化成显示文本; 简短小数 (4 位), 去尾 0. */
export function formatPi(v: number): string {
  if (!Number.isFinite(v)) return '0';
  let s = v.toFixed(4);
  // 去尾 0 跟空小数点
  s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return s;
}
