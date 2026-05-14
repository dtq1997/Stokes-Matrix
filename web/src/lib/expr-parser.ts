// 复数表达式 parser + LaTeX emitter.
// 支持: + - * / ^ (), 隐式乘 (2i, 2pi, 2(3)), 常量 pi/e/i, 函数 sqrt sin cos tan exp ln log.
// `e` 区分: 数字 token 内 "1e3" 当科学计数 (digit + e + [+-]?digit+); 否则当 Euler 常量.
//
// parseComplexExpr 返回 {re, im} 或 null (无效输入);
// exprToLatex 返回 KaTeX 可渲染字符串 (无效时返回 raw 文本带 \text 包裹).

export type ComplexVal = { re: number; im: number };

type Tok =
  | { kind: 'num'; val: number }
  | { kind: 'id'; val: string }
  | { kind: 'op'; val: '+' | '-' | '*' | '/' | '^' | '(' | ')' }
  | { kind: 'end' };

type Node =
  | { kind: 'num'; val: number }
  | { kind: 'const'; name: 'pi' | 'e' | 'i' }
  | { kind: 'neg'; v: Node }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/' | '^'; l: Node; r: Node }
  | { kind: 'fn'; name: string; arg: Node };

const FUNCS = new Set(['sqrt', 'sin', 'cos', 'tan', 'exp', 'ln', 'log']);

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
    if (c === 'π') { out.push({ kind: 'id', val: 'pi' }); i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      // 科学计数: 仅当 'e' 后紧跟 [+-]?digit+ 才吃; 否则 'e' 留给 identifier scanner.
      if (j < s.length && (s[j] === 'e' || s[j] === 'E')) {
        let k = j + 1;
        if (k < s.length && (s[k] === '+' || s[k] === '-')) k++;
        if (k < s.length && /[0-9]/.test(s[k])) {
          while (k < s.length && /[0-9]/.test(s[k])) k++;
          j = k;
        }
      }
      const n = Number(s.slice(i, j));
      if (!Number.isFinite(n)) throw new Error('bad number');
      out.push({ kind: 'num', val: n });
      i = j;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      let j = i;
      while (j < s.length && /[a-zA-Z]/.test(s[j])) j++;
      out.push({ kind: 'id', val: s.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/^()'.includes(c)) {
      out.push({ kind: 'op', val: c as any });
      i++;
      continue;
    }
    throw new Error('unknown char: ' + c);
  }
  out.push({ kind: 'end' });
  return out;
}

class Parser {
  p = 0;
  constructor(public toks: Tok[]) {}
  peek(): Tok { return this.toks[this.p]; }
  eat(): Tok { return this.toks[this.p++]; }
  parse(): Node {
    const v = this.expr();
    if (this.peek().kind !== 'end') throw new Error('trailing input');
    return v;
  }
  // expr := term (('+' | '-') term)*
  expr(): Node {
    let lhs = this.term();
    while (true) {
      const t = this.peek();
      if (t.kind === 'op' && (t.val === '+' || t.val === '-')) {
        this.eat();
        lhs = { kind: 'bin', op: t.val, l: lhs, r: this.term() };
      } else break;
    }
    return lhs;
  }
  // term := unary ((('*' | '/') | implicit) unary)*
  term(): Node {
    let lhs = this.unary();
    while (true) {
      const t = this.peek();
      if (t.kind === 'op' && (t.val === '*' || t.val === '/')) {
        this.eat();
        lhs = { kind: 'bin', op: t.val, l: lhs, r: this.unary() };
      } else if (this.isImplicitMultStart(t)) {
        lhs = { kind: 'bin', op: '*', l: lhs, r: this.unary() };
      } else break;
    }
    return lhs;
  }
  isImplicitMultStart(t: Tok): boolean {
    if (t.kind === 'num') return true;
    if (t.kind === 'id') return true;
    if (t.kind === 'op' && t.val === '(') return true;
    return false;
  }
  // unary := ('+'|'-')? power
  unary(): Node {
    const t = this.peek();
    if (t.kind === 'op' && (t.val === '+' || t.val === '-')) {
      this.eat();
      const v = this.unary();
      return t.val === '-' ? { kind: 'neg', v } : v;
    }
    return this.power();
  }
  // power := atom ('^' unary)?    right-assoc; 允许 e^-1
  power(): Node {
    const base = this.atom();
    const t = this.peek();
    if (t.kind === 'op' && t.val === '^') {
      this.eat();
      return { kind: 'bin', op: '^', l: base, r: this.unary() };
    }
    return base;
  }
  atom(): Node {
    const t = this.eat();
    if (t.kind === 'num') return { kind: 'num', val: t.val };
    if (t.kind === 'op' && t.val === '(') {
      const v = this.expr();
      const close = this.eat();
      if (!(close.kind === 'op' && close.val === ')')) throw new Error('expected )');
      return v;
    }
    if (t.kind === 'id') {
      if (t.val === 'pi') return { kind: 'const', name: 'pi' };
      if (t.val === 'e') return { kind: 'const', name: 'e' };
      if (t.val === 'i') return { kind: 'const', name: 'i' };
      const nxt = this.peek();
      if (FUNCS.has(t.val) && nxt.kind === 'op' && nxt.val === '(') {
        this.eat(); // (
        const arg = this.expr();
        const close = this.eat();
        if (!(close.kind === 'op' && close.val === ')')) throw new Error('expected ) after fn arg');
        return { kind: 'fn', name: t.val, arg };
      }
      throw new Error('unknown identifier: ' + t.val);
    }
    throw new Error('unexpected token');
  }
}

// ---------- 复数运算 ----------
const C = (re: number, im = 0): ComplexVal => ({ re, im });
const cadd = (a: ComplexVal, b: ComplexVal): ComplexVal => ({ re: a.re + b.re, im: a.im + b.im });
const csub = (a: ComplexVal, b: ComplexVal): ComplexVal => ({ re: a.re - b.re, im: a.im - b.im });
const cmul = (a: ComplexVal, b: ComplexVal): ComplexVal => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});
const cdiv = (a: ComplexVal, b: ComplexVal): ComplexVal => {
  const d = b.re * b.re + b.im * b.im;
  if (d === 0) throw new Error('division by zero');
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};
const cneg = (a: ComplexVal): ComplexVal => ({ re: -a.re, im: -a.im });
const cexp = (a: ComplexVal): ComplexVal => {
  const r = Math.exp(a.re);
  return { re: r * Math.cos(a.im), im: r * Math.sin(a.im) };
};
const clog = (a: ComplexVal): ComplexVal => {
  const r = Math.hypot(a.re, a.im);
  if (r === 0) throw new Error('log(0)');
  return { re: Math.log(r), im: Math.atan2(a.im, a.re) };
};
const cpow = (a: ComplexVal, b: ComplexVal): ComplexVal => {
  if (a.re === 0 && a.im === 0) {
    if (b.re === 0 && b.im === 0) return C(1);
    return C(0);
  }
  return cexp(cmul(b, clog(a)));
};
const csqrt = (a: ComplexVal): ComplexVal => cpow(a, C(0.5));
const csin = (a: ComplexVal): ComplexVal => ({
  re: Math.sin(a.re) * Math.cosh(a.im),
  im: Math.cos(a.re) * Math.sinh(a.im),
});
const ccos = (a: ComplexVal): ComplexVal => ({
  re: Math.cos(a.re) * Math.cosh(a.im),
  im: -Math.sin(a.re) * Math.sinh(a.im),
});
const ctan = (a: ComplexVal): ComplexVal => cdiv(csin(a), ccos(a));

function evalNode(n: Node): ComplexVal {
  switch (n.kind) {
    case 'num': return C(n.val);
    case 'const':
      if (n.name === 'pi') return C(Math.PI);
      if (n.name === 'e') return C(Math.E);
      return C(0, 1);
    case 'neg': return cneg(evalNode(n.v));
    case 'bin': {
      const a = evalNode(n.l), b = evalNode(n.r);
      switch (n.op) {
        case '+': return cadd(a, b);
        case '-': return csub(a, b);
        case '*': return cmul(a, b);
        case '/': return cdiv(a, b);
        case '^': return cpow(a, b);
      }
    }
    // eslint-disable-next-line no-fallthrough
    case 'fn':
      switch (n.name) {
        case 'sqrt': return csqrt(evalNode(n.arg));
        case 'sin': return csin(evalNode(n.arg));
        case 'cos': return ccos(evalNode(n.arg));
        case 'tan': return ctan(evalNode(n.arg));
        case 'exp': return cexp(evalNode(n.arg));
        case 'ln': case 'log': return clog(evalNode(n.arg));
        default: throw new Error('unknown fn ' + n.name);
      }
  }
}

// ---------- LaTeX 输出 ----------
const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 5 };

function fmtNum(x: number): string {
  if (Number.isInteger(x)) return String(x);
  // 短小数, 保留至 6 位有效数字
  return String(parseFloat(x.toPrecision(6)));
}

// 常数 e, i 用 \mathrm 渲染成正体 (ISO 80000-2 数学常数约定).
// π 用 \pi: KaTeX 不原生支持 \uppi (要 upgreek 包扩展), 这里 fallback 到斜体 π.
function nodeToLatex(n: Node, parentPrec = 0): string {
  switch (n.kind) {
    case 'num': return fmtNum(n.val);
    case 'const':
      if (n.name === 'pi') return '\\pi';
      if (n.name === 'e') return '\\mathrm{e}';
      return '\\mathrm{i}';
    case 'neg': {
      const s = '-' + nodeToLatex(n.v, 3);
      return parentPrec > 1 ? `\\left(${s}\\right)` : s;
    }
    case 'fn': {
      const inner = nodeToLatex(n.arg, 0);
      if (n.name === 'sqrt') return `\\sqrt{${inner}}`;
      if (n.name === 'exp') return `\\mathrm{e}^{${inner}}`;
      if (n.name === 'ln' || n.name === 'log') return `\\ln\\left(${inner}\\right)`;
      return `\\${n.name}\\left(${inner}\\right)`;
    }
    case 'bin': {
      const p = PREC[n.op];
      let s: string;
      if (n.op === '/') {
        s = `\\frac{${nodeToLatex(n.l, 0)}}{${nodeToLatex(n.r, 0)}}`;
      } else if (n.op === '^') {
        // base 用 atom 优先级 (避免 `2+3` 之类被吃进底数); 5+ 强迫 paren
        s = `${nodeToLatex(n.l, 6)}^{${nodeToLatex(n.r, 0)}}`;
      } else if (n.op === '*') {
        const lstr = nodeToLatex(n.l, p);
        const rstr = nodeToLatex(n.r, p);
        // 右端是符号 (\pi / 单字母 const / 函数) 时用 juxtaposition; 否则 \cdot.
        // 控制序列 (\pi 等) 后接字母会被解析成新命令 (e.g. \pii 无效) → 始终插入空格.
        const juxt = /^[\\a-zA-Z]/.test(rstr);
        s = juxt ? `${lstr} ${rstr}` : `${lstr}\\cdot ${rstr}`;
      } else {
        // + 或 -: 左结合, 右子高一级以避免 a-(b-c) 输出无 paren
        s = `${nodeToLatex(n.l, p)} ${n.op} ${nodeToLatex(n.r, p + 1)}`;
      }
      return parentPrec > p ? `\\left(${s}\\right)` : s;
    }
  }
}

// ---------- 对外 API ----------

export function parseComplexExpr(s: string): ComplexVal | null {
  try {
    const trimmed = s.trim().replace(/−/g, '-');  // U+2212 minus → ASCII
    if (trimmed === '') return null;
    const ast = new Parser(tokenize(trimmed)).parse();
    const v = evalNode(ast);
    if (!Number.isFinite(v.re) || !Number.isFinite(v.im)) return null;
    return v;
  } catch {
    return null;
  }
}

/** 试图把表达式渲染成 LaTeX. 解析失败时返回 \text{...} 包裹原文 (KaTeX 不会抛). */
export function exprToLatex(s: string): string {
  try {
    const trimmed = s.trim().replace(/−/g, '-');
    if (trimmed === '') return '';
    const ast = new Parser(tokenize(trimmed)).parse();
    return nodeToLatex(ast);
  } catch {
    // KaTeX 安全转义
    const esc = s.replace(/[\\{}#&%$_^~]/g, m => '\\' + m);
    return `\\text{${esc}}`;
  }
}

/** 从 {re, im} 构造一个默认表达式字符串 — 用户首次切到 expr 模式时填进输入框. */
export function complexToExpr(re: number, im: number): string {
  const rPart = re !== 0 ? fmtNum(re) : '';
  if (im === 0) return rPart || '0';
  const sign = im < 0 ? '-' : (rPart ? '+' : '');
  const mag = Math.abs(im);
  const imPart = mag === 1 ? 'i' : `${fmtNum(mag)}i`;
  return rPart ? `${rPart}${sign}${imPart}` : `${im < 0 ? '-' : ''}${imPart}`;
}
