// SSOT: 矩阵面板 (N×N flat grid + view selector) 的通用渲染.
//
// Stokes 矩阵和中心连接矩阵 Ω_d 共用这套实现. 未来 UI 变化 (字号 / 对齐 /
// selector 样式 / 复数格式 / 块结构分隔) 只改这一个文件, 两边自动跟上.
//
// 用法:
//   buildMatrixGrid({ containerId, ms, onCellClick, isSelected })
//     — 构造 grid 骨架 (header + N×N cells). 调一次, 之后用 refreshMatrixCells 更新数值.
//   refreshMatrixCells({ containerId, ms, view, digits, getCellBlock, isSelected, isStale })
//     — 重画所有 cell 数值. 每次 view / dataset / selection 变都调.
//   buildViewSelector({ selectorId, views, currentView, onChange })
//     — 构造 view 标签 (sd-view-btn 风格). 调一次后改 refresh* 同步 active 态.
//   refreshViewSelector({ selectorId, currentView })
//     — 更新哪个 button 高亮 active.

import type { ComplexNum } from './types.js';

/** 块结构辅助: m_sizes → 累积起点 [0, m_0, m_0+m_1, ...] */
export function blockStarts(ms: number[]): number[] {
  const s = [0];
  for (let k = 0; k < ms.length - 1; k++) s.push(s[k] + ms[k]);
  return s;
}
export function totalMultiplicity(ms: number[]): number {
  return ms.reduce((a, b) => a + b, 0);
}
/** flat index → block index + sub-index. */
export function flatToBlock(ms: number[], fi: number): [number, number] {
  const starts = blockStarts(ms);
  for (let k = ms.length - 1; k >= 0; k--) {
    if (fi >= starts[k]) return [k, fi - starts[k]];
  }
  return [-1, -1];
}
/** flat 索引 label (m_k=1 时只用 "I", 否则 "I,a"). */
export function flatIndexLabel(ms: number[], block: number, sub: number): string {
  return ms[block] > 1 ? `${block + 1},${sub + 1}` : `${block + 1}`;
}

export interface ViewSpec<K extends string> {
  key: K;
  tex: string;
  title: string;
}

export interface BuildGridOpts {
  containerId: string;
  ms: number[];
  /** 点击非对角 cell 触发. 对角 cell 不可点 (cursor:default).
   *  Stokes (`diagSelectable=false`): 对角不可点; Ω/Ω^-1 (`diagSelectable=true`): 对角也可点. */
  onCellClick?: (I: number, J: number) => void;
  /** 是否在行方向显示 block 分隔 (default true). Ω_d (行不分块) 传 false. */
  rowBlocks?: boolean;
  /** 是否在列方向显示 block 分隔 (default true). Ω_d^{-1} (列不分块) 传 false. */
  colBlocks?: boolean;
  /** 对角 cell 也可点击 (default false). */
  diagSelectable?: boolean;
  /** 列宽策略 (default '1fr'): 1fr = cell 等分容器宽度 (Omega 用); 'content' =
   *  全表统一列宽 = max(所有 cell 实测内容宽度), 容器装不下走 overflow-x:auto
   *  横滚 (Stokes 用, ISC 后大整数不被压扁; 同时短 view 例如 plus/minus 不会
   *  被某列内容稀疏压窄, 因为同宽组里所有 view 共享一个 max). */
  columnSizing?: '1fr' | 'content';
  /** KaTeX 渲染函数 (调用方注入, 避免 lib 直接依赖 katex). */
  tex: (s: string) => string;
}

/** 构造 grid 骨架. 不写数值, 由 refreshMatrixCells 填. */
export function buildMatrixGrid(opts: BuildGridOpts): void {
  const sm = document.getElementById(opts.containerId);
  if (!sm) return;
  const ms = opts.ms;
  const N = totalMultiplicity(ms);
  const rowBlocks = opts.rowBlocks !== false;
  const colBlocks = opts.colBlocks !== false;
  const diagSelectable = !!opts.diagSelectable;
  // 列宽: 默认 1fr (cell 等分容器, Omega 用); caller 显式传 max-content 时
  // cell 按内容撑开, 容器装不下时 .matrix-grid 自带 overflow-x:auto 横滚
  // (Stokes 用, ISC 后大整数 cell 不被 1fr 压扁).
  // 列宽: 默认 1fr (Omega 用, cell 等分容器); caller 显式传 'content' 时
  // minmax(var(--cell-w), 1fr) — cell 不小于 --cell-w (按内容算的统一宽度,
  // 大整数撑得开), 但容器有富余时 1fr 平分撑满 (跟 Omega 一致, 矩阵贴左).
  // 容器装不下 N×--cell-w 时 .matrix-grid 自带 overflow-x:auto 横滚.
  const colSize = opts.columnSizing === 'content'
    ? 'minmax(var(--cell-w, 0px), 1fr)'
    : '1fr';
  sm.style.gridTemplateColumns = `auto repeat(${N}, ${colSize})`;
  // diagSelectable 存到容器 dataset, refreshMatrixCells 读它决定 stale 时
  // 对角是否给 .diag 类 (避免 Omega 一直 stale + diagSelectable=true 但对角
  // 被无脑加 diag 不可选的回归, 来自 3bab850).
  sm.dataset.diagSelectable = diagSelectable ? '1' : '0';
  sm.innerHTML = '';
  // corner + 列 labels
  const corner = document.createElement('div');
  corner.className = 'sm-corner';
  sm.appendChild(corner);
  for (let fj = 0; fj < N; fj++) {
    const [J, b] = flatToBlock(ms, fj);
    const th = document.createElement('div');
    th.className = 'sm-header sm-col-header';
    if (colBlocks && fj > 0 && b === 0) th.classList.add('block-left');
    // 没列块结构 → 用 flat "1..N" 连续编号; 有列块 → "I" 或 "I,a"
    th.innerHTML = opts.tex(colBlocks ? flatIndexLabel(ms, J, b) : String(fj + 1));
    sm.appendChild(th);
  }
  // 数据行: 行 label + N cells
  for (let fi = 0; fi < N; fi++) {
    const [I, a] = flatToBlock(ms, fi);
    const rowH = document.createElement('div');
    rowH.className = 'sm-header sm-row-header';
    if (rowBlocks && fi > 0 && a === 0) rowH.classList.add('block-top');
    rowH.innerHTML = opts.tex(rowBlocks ? flatIndexLabel(ms, I, a) : String(fi + 1));
    sm.appendChild(rowH);
    for (let fj = 0; fj < N; fj++) {
      const [J, b] = flatToBlock(ms, fj);
      const cell = document.createElement('div');
      cell.className = 'sm-cell';
      // diag look + click 都是 refresh 时由 cellContent.kind 后置决定 (md view
      // 让对角 block/symbolic 可选, std/plus/minus/eg 的对角 identity/zero 仍灰).
      // diagSelectable 旧 build-time hint 现在只用作 initial state (后续 refresh
      // 会覆盖). 留着是为不破老调用方 (Omega).
      if (I === J && !diagSelectable) cell.classList.add('diag');
      if (rowBlocks && fi > 0 && a === 0) cell.classList.add('block-top');
      if (colBlocks && fj > 0 && b === 0) cell.classList.add('block-left');
      cell.dataset.i = String(I);
      cell.dataset.j = String(J);
      cell.dataset.a = String(a);
      cell.dataset.b = String(b);
      // click listener 始终挂. 是否真的响应由 refreshMatrixCells 写入的 .diag CSS
      // pointer-events:none 屏蔽 (off-diag 永远响应; diag 看 refresh 给的状态).
      if (opts.onCellClick) {
        cell.addEventListener('click', () => opts.onCellClick!(I, J));
      }
      sm.appendChild(cell);
    }
  }
}

/** Cell 内容描述: 'zero' / 'identity' / block matrix / null (unavailable). */
export type CellContent =
  | { kind: 'zero' }
  | { kind: 'identity' }
  | { kind: 'block'; block: ComplexNum[][] }
  | { kind: 'unavailable'; tooltip?: string }
  // ISC 给出的闭式表达, cell 渲染直接走 KaTeX. tooltip 显示原浮点值便于交叉核对.
  | { kind: 'symbolic'; latex: string; tooltip?: string };

export interface RefreshOpts {
  containerId: string;
  ms: number[];
  digits: number;
  /** 数据 fresh: 任何 cell 没 fresh 全显示 '—'. */
  isStale: boolean;
  staleMessage?: string;
  /** stale 时是否对对角 cell 也显 '—' (default false, 保 Stokes 旧行为: diag 永远走 getCellContent).
   *  Ω/Ω^-1 对角不特殊, 传 true 让 stale 时 diag 也 '—'. */
  staleIncludesDiag?: boolean;
  /** 取 (I, J) entry block. I==J 也可调 (取对角 view 决定 zero/identity). */
  getCellContent: (I: number, J: number, a: number, b: number) => CellContent;
  /** 跨 view 同尺寸保证: 调用方提供 view-independent 的"宽度上界" block 集合.
   *  通常是 std view 的所有 off-diag block (即未做 sign 过滤/取负). 不传则
   *  退化成 view-specific 自己扫一遍 — 但会出现 plus/minus 比 std 窄的不稳定. */
  widthReferenceBlocks?: () => Iterable<ComplexNum[][]>;
  /** 跨 view 同尺寸 (symbolic 支线): 调用方提供当前 view (或其同宽组) 内所有
   *  symbolic cell 的 latex 字符串. panel 估算这些字符串的 ch 等价宽度, 跟
   *  浮点宽度合并取 max 设到 --cs-sym-w. ISC 出大整数 / 表达式时, 单元格框
   *  不再被浮点公式 (var(--cs-int-w)+var(--cs-frac-w)+4ch) 压窄. */
  widthReferenceLatex?: () => Iterable<string>;
  selectedEntry: [number, number] | null;
  /** 高亮模式:
   *  - 'entry' (default): 仅 (I,J) 匹配 selectedEntry 时高亮.
   *  - 'row': selectedEntry[0] 给出行索引, 该行所有 cell 高亮 (Ω 行块).
   *  - 'col': selectedEntry[1] 给出列索引, 该列所有 cell 高亮 (Ω^-1 列块). */
  selectionMode?: 'entry' | 'row' | 'col';
  /** 拍 cell 显示用. 调用方注入 (跟 buildMatrixGrid 一致). */
  renderComplex: (v: ComplexNum, digits: number) => string;
  tex: (s: string) => string;
}

/** 重画所有 cell. 自动跨 cell 小数点对齐 (--cs-int-w / --cs-frac-w). */
export function refreshMatrixCells(opts: RefreshOpts): void {
  const sm = document.getElementById(opts.containerId);
  if (!sm) return;

  // 跨 cell 对齐: 先扫所有 block 收集最大整数位 / 小数位.
  let maxInt = 1, maxFrac = 0;
  const accumulate = (block: ComplexNum[][]) => {
    for (const row of block) for (const v of row) {
      for (const x of [v.re, v.im]) {
        if (x === 0 || !Number.isFinite(x)) continue;
        const mag = Math.floor(Math.log10(Math.abs(x)));
        maxInt = Math.max(maxInt, Math.max(1, mag + 1));
        maxFrac = Math.max(maxFrac, Math.max(0, opts.digits - mag - 1));
      }
    }
  };
  if (!opts.isStale) {
    // 跨 view 同尺寸: 优先用 widthReferenceBlocks (调用方传入 view-independent
    // 上界, 通常是 std view 全 off-diag block). 否则扫当前 view block 当 fallback.
    if (opts.widthReferenceBlocks) {
      for (const b of opts.widthReferenceBlocks()) accumulate(b);
    }
    const n_ch = opts.ms.length;
    for (let I = 0; I < n_ch; I++) for (let J = 0; J < n_ch; J++) {
      if (I === J) continue;
      const c = opts.getCellContent(I, J, 0, 0);
      if (c.kind === 'block') accumulate(c.block);
    }
  }
  sm.style.setProperty('--cs-int-w', `${maxInt}ch`);
  sm.style.setProperty('--cs-frac-w', `${maxFrac > 0 ? maxFrac + 1 : 0}ch`);

  // Symbolic cell 宽度估算: KaTeX 字体下整数/分数/√/π 表达式按字符长度粗估
  // (~0.65 ch/char, 经验值). 比浮点公式宽时撑大 cell, 否则不影响 (max 取大).
  // 简单字符长度估; 复杂表达式 (sqrt/pi) 实际比字符数稍宽, 留 1ch 余量.
  let maxSymCh = 0;
  if (!opts.isStale && opts.widthReferenceLatex) {
    for (const s of opts.widthReferenceLatex()) {
      // 粗估: 数字字符 ~0.6ch, 字母/符号 ~0.7ch. 取均值 0.65ch.
      // \sqrt{} / \pi 等 KaTeX 命令实际渲染比字符数短, 这里高估安全.
      const visible = s.replace(/[\\{}]/g, '');
      const est = visible.length * 0.65 + 1;
      if (est > maxSymCh) maxSymCh = est;
    }
  }
  sm.style.setProperty('--cs-sym-w', `${maxSymCh.toFixed(2)}ch`);

  // 全表统一列宽 (columnSizing='content' 时生效, '1fr' 时被覆盖不参与 layout):
  // 跟 .sm-cell min-width 公式同步 — max(浮点宽, symbolic 宽), 写入 --cell-w.
  // CSS calc 解不了 max() with mixed units inside grid-template-columns
  // (浏览器实现差异), 这里 JS 端先算好 ch 值再写.
  const floatCh = maxInt + (maxFrac > 0 ? maxFrac + 1 : 0) + 4;  // sign+i+padding ≈ 4ch
  const cellCh = Math.max(floatCh, maxSymCh);
  sm.style.setProperty('--cell-w', `${cellCh.toFixed(2)}ch`);

  const cells = sm.querySelectorAll<HTMLElement>('.sm-cell');
  const staleTip = opts.staleMessage ?? 'stale: recompute';
  // diagSelectable 由 buildMatrixGrid 存到 sm.dataset (3bab850 起 .diag 由
  // refresh 后置决定, 之前漏掉 stale 分支没看 diagSelectable, 导致 Omega 一直
  // stale + 对角不可选).
  const diagSelectable = sm.dataset.diagSelectable === '1';
  for (const cell of Array.from(cells)) {
    const I = Number(cell.dataset.i!);
    const J = Number(cell.dataset.j!);
    const a = Number(cell.dataset.a!);
    const b = Number(cell.dataset.b!);

    const mode = opts.selectionMode ?? 'entry';
    const sel = !!(opts.selectedEntry && (
      mode === 'entry' ? (opts.selectedEntry[0] === I && opts.selectedEntry[1] === J) :
      mode === 'row'   ? (opts.selectedEntry[0] === I) :
      /* col */          (opts.selectedEntry[1] === J)
    ));
    cell.classList.toggle('selected', sel);

    if (opts.isStale && (opts.staleIncludesDiag || I !== J)) {
      cell.innerHTML = `<span class="cs-zero" title="${staleTip}">—</span>`;
      // stale 时对角按"无信息" 处理 → 显灰不可选; 但 diagSelectable (Omega 那种
      // 对角不特殊的 panel) 时仍要可选, 不加 .diag.
      if (I === J && !diagSelectable) cell.classList.add('diag');
      else if (I === J) cell.classList.remove('diag');
      continue;
    }

    const content = opts.getCellContent(I, J, a, b);
    // 后置决定对角 cell 显灰 + 可选: 内容是 block/symbolic 时正常 (md view 对角
    // 有信息); identity/zero/unavailable 时显灰不可选 (std/plus/minus/eg 对角).
    // off-diag 永远不打 .diag, 保持原有可点行为 (含 plus/minus 过滤成 0 的 cell
    // 和 unavailable cell). Omega (diagSelectable=true) 永远不加 .diag, 对角可选.
    if (I === J) {
      const diagInert = !diagSelectable && (
        content.kind === 'identity' || content.kind === 'zero' || content.kind === 'unavailable'
      );
      cell.classList.toggle('diag', diagInert);
    } else {
      cell.classList.remove('diag');
    }
    switch (content.kind) {
      case 'zero':
        cell.innerHTML = `<span class="cs-zero">${opts.tex('0')}</span>`;
        break;
      case 'identity':
        cell.innerHTML = `<span class="cs-zero">${opts.tex(a === b ? '1' : '0')}</span>`;
        break;
      case 'unavailable':
        cell.innerHTML = `<span class="cs-zero"${content.tooltip ? ` title="${content.tooltip}"` : ''}>—</span>`;
        break;
      case 'block': {
        const v = content.block[a]?.[b] ?? { re: 0, im: 0 };
        cell.innerHTML = opts.renderComplex(v, opts.digits);
        break;
      }
      case 'symbolic': {
        const tipAttr = content.tooltip ? ` title="${content.tooltip.replace(/"/g, '&quot;')}"` : '';
        cell.innerHTML = `<span class="cs-symbolic"${tipAttr}>${opts.tex(content.latex)}</span>`;
        break;
      }
    }
  }
}

export interface BuildSelectorOpts<K extends string> {
  selectorId: string;
  views: ViewSpec<K>[];
  /** 当前选中 view (动态读取, 闭包友好). */
  getCurrentView: () => K;
  onChange: (k: K) => void;
}

export function buildViewSelector<K extends string>(opts: BuildSelectorOpts<K>): void {
  const el = document.getElementById(opts.selectorId);
  if (!el) return;
  el.innerHTML = opts.views.map(o =>
    `<button type="button" class="sd-view-btn" data-view="${o.key}" title="${o.title}">` +
      `<span data-tex="${o.tex}"></span></button>`
  ).join('');
  el.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('.sd-view-btn');
    if (!btn) return;
    const v = btn.dataset.view as K | undefined;
    if (!v || v === opts.getCurrentView()) return;
    opts.onChange(v);
  });
  refreshViewSelector(opts.selectorId, opts.getCurrentView());
}

export function refreshViewSelector<K extends string>(selectorId: string, currentView: K): void {
  document.querySelectorAll<HTMLElement>(`#${selectorId} .sd-view-btn`).forEach(b => {
    b.classList.toggle('active', b.dataset.view === currentView);
  });
}
