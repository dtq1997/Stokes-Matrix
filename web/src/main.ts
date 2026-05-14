import katex from 'katex';
import { loadDataset, recomputeAsync, cancelJob, backendOnline, getBackendBase, setBackendBase, DATASET_REGISTRY, getDatasetKey, iscQuery, iscIsValueForm, type IscCandidate } from './lib/data.js';
import type { JobStatus } from './lib/data.js';
import type { VizState, ComplexNum, PathRep, SdEntryData } from './lib/types.js';
import {
  buildMatrixGrid, refreshMatrixCells, buildViewSelector, refreshViewSelector,
  type CellContent, type ViewSpec,
} from './lib/matrix-panel.js';
import { Canvas } from './components/canvas.js';
import { chamberOfDirection, monodromyTransforms, antiStokesRays } from './lib/geometry.js';
import { mmul } from './lib/matexp.js';
import { parsePiInput, parseRational, formatPi } from './lib/pi-input.js';
import { parseComplexExpr, exprToLatex, complexToExpr } from './lib/expr-parser.js';
import { simpleIdentifyValue, buildComplexExprFromForms as buildLocalComplexExpr } from './lib/local-isc.js';
import { propagateExactMatrices, type IntMatrix } from './lib/wall-crossing.js';

function tex(s: string, displayMode = false): string {
  return katex.renderToString(s, { displayMode, throwOnError: false, strict: false });
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]!));
}
function renderAllTex(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-tex]').forEach(el => {
    const src = el.dataset.tex!;
    if (el.dataset.texRendered === src) return;
    el.innerHTML = tex(src);
    el.dataset.texRendered = src;
  });
}

// SSOT: 所有复数虚部 i 字符的 HTML 表示走这一份, 输入框 (cx-pair) 和输出
// (cs-grid) 共用. 不要在别处写 `<span class="im-unit">i</span>` 字面量.
const IM_UNIT = '<span class="im-unit">i</span>';

function precisionToDigits(p: string): number {
  switch (p) {
    case 'fast': return 4;
    case 'low': return 5;
    case 'medium': return 7;
    case 'high': return 8;
    default: return 7;
  }
}

function selectedPrecisionDigits(): number {
  const sel = document.getElementById('precision-select') as HTMLSelectElement | null;
  return precisionToDigits(sel?.value ?? 'medium');
}

function splitBySigDigits(x: number, digits: number): [string, string] {
  if (x === 0) return ['0', ''];
  const ax = Math.abs(x);
  const mag = Math.floor(Math.log10(ax));
  const fracDigits = Math.max(0, digits - mag - 1);
  const s = ax.toFixed(fracDigits);
  const dot = s.indexOf('.');
  return dot < 0 ? [s, ''] : [s.slice(0, dot), s.slice(dot)];
}

function setupDatasetSelect() {
  const sel = document.getElementById('dataset-select') as HTMLSelectElement | null;
  if (!sel) return;
  const currentKey = getDatasetKey();
  for (const entry of DATASET_REGISTRY) {
    const opt = document.createElement('option');
    opt.value = entry.key;
    // KaTeX 不便嵌 <option>, dropdown 用纯文本; CP^n 用 unicode 上标.
    opt.textContent = entry.label
      .replace(/\\mathbb\{CP\}/g, 'CP')
      .replace(/QH\^\*/g, 'QH*')
      .replace(/\^2/g, '²').replace(/\^3/g, '³').replace(/\^4/g, '⁴');
    if (entry.key === currentKey) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    const key = sel.value;
    const url = new URL(window.location.href);
    if (key === DATASET_REGISTRY[0].key) url.searchParams.delete('dataset');
    else url.searchParams.set('dataset', key);
    window.location.href = url.toString();
  });
}

async function main() {
  setupDatasetSelect();
  const dataset = await loadDataset();
  const datasetKey = getDatasetKey();
  const datasetEntry = DATASET_REGISTRY.find(d => d.key === datasetKey);
  const hideOnLoad = !!datasetEntry?.hideOnLoad;

  let n = dataset.punctures.length;
  // 块结构: n 个块, 每块 m_k 大小, 总维度 N = sum m_k.
  // SSOT: A 内部存 N×N 复矩阵, 块结构由 m_sizes 描述.
  const totalMultiplicity = (ms: number[]) => ms.reduce((a, b) => a + b, 0);
  const N0 = totalMultiplicity(dataset.m_sizes);
  const blockStarts = (ms: number[]) => {
    const s = [0]; for (let k = 0; k < ms.length - 1; k++) s.push(s[k] + ms[k]); return s;
  };
  const flatIndexLabel = (ms: number[], block: number, sub: number) =>
    ms[block] > 1 ? `${block + 1},${sub + 1}` : `${block + 1}`;
  function rebuildInitialA(): ComplexNum[][] {
    const ms = dataset.m_sizes;
    const N = totalMultiplicity(ms);
    const starts = blockStarts(ms);
    const A: ComplexNum[][] = Array.from({ length: N }, () =>
      Array.from({ length: N }, () => ({ re: 0, im: 0 })));
    // 对角块: A_diag_block 优先 (块版), 否则 A_diag (simple 退化, m_k 个 entry 全填 A_diag[k]).
    for (let k = 0; k < n; k++) {
      const s = starts[k], mk = ms[k];
      const diagVals = dataset.A_diag_block?.[k]
        ?? Array.from({ length: mk }, () => dataset.A_diag[k]);
      for (let a = 0; a < mk; a++) A[s + a][s + a] = { re: diagVals[a], im: 0 };
    }
    // off: 块下标 (i, j) + 可选 sub (a, b). simple case 没 (a, b) 时填到 block 的 (0, 0).
    for (const e of dataset.A_off) {
      const sI = starts[e.i], sJ = starts[e.j];
      const a = e.a ?? 0, b = e.b ?? 0;
      A[sI + a][sJ + b] = { re: e.re, im: e.im, ...(e.expr ? { expr: e.expr } : {}) };
    }
    return A;
  }
  const initialA = rebuildInitialA();

  const state: VizState = {
    dataset,
    selectedChamber: 0,
    selectedEntry: null,
    paths: new Map(),
    punctureOverrides: dataset.punctures.map(p => ({ ...p })),
    AOverrides: initialA.map(row => row.map(c => ({ ...c }))),
    mOverrides: [...dataset.m_sizes],
    stokesStale: hideOnLoad,
    exampleAwaitingCompute: hideOnLoad,
    sdView: 'std',
    omegaView: 'omega',
    selectedOmegaBlock: null,
  };

  // U/A 表输入模式. 'pair' = 现有 Re/Im 双框; 'expr' = 单行复数表达式 + KaTeX 预览.
  // 独立切换, 不进 snapshot/undo (纯 UI 状态; expr 原文存在 ComplexNum.expr 持久化).
  // 默认按 dataset 决定: 任一 puncture / A_off 自带 expr 字段 ⇒ 'expr' 模式开局 (例: CP^n).
  const datasetHasPunctureExpr = dataset.punctures.some(p => p.expr);
  const datasetHasAExpr = dataset.A_off.some(e => e.expr);
  let uInputMode: 'pair' | 'expr' = datasetHasPunctureExpr ? 'expr' : 'pair';
  let aInputMode: 'pair' | 'expr' = datasetHasAExpr ? 'expr' : 'pair';
  // "Hide source" 子状态: 仅 expr 模式下生效, 隐藏 input 仅显示 KaTeX 预览.
  // 点 cell → 临时显示 input 可编辑, blur 后回隐藏 (.editing class 控制单 cell).
  // dataset 自带 expr ⇒ 默认 hide source (CP^n 等); 否则默认显示源码.
  let uSourceHidden = datasetHasPunctureExpr;
  let aSourceHidden = datasetHasAExpr;

  function complexExprInputHtml(attrs: string, placeholder = 'a + bi'): string {
    return `<div class="cx-expr-cell">` +
      `<input class="cx cx-expr" ${attrs} placeholder="${placeholder}" />` +
      `<div class="cx-preview" ${attrs}></div>` +
      `</div>`;
  }
  function renderExprPreview(el: Element | null, text: string) {
    if (!el) return;
    const t = text.trim();
    if (t === '') { el.innerHTML = ''; return; }
    el.innerHTML = katex.renderToString(exprToLatex(t), { throwOnError: false, strict: false });
  }

  function currentRays(): number[] {
    const ps = state.punctureOverrides ?? dataset.punctures;
    return antiStokesRays(ps);
  }

  const onStateChange = (_s: VizState) => {
    // canvas 触发 (拖 puncture / path vertex) 后, 标 Stokes 数值 stale.
    // path-vertex drag 不改 punctureOverrides 但 path 几何变了 — 数值还是旧 dataset 的
    // 值 (因为算法走的 algo_wp 没变, 同伦类 cache 命中). 这里宁可标 stale 用户决定.
    state.stokesStale = !!state.punctureOverrides || !!state.AOverrides;
    if (state.stokesStale) state.exampleAwaitingCompute = false;
    // Live: puncture 拖动后, anti-Stokes rays + γ_ij^(d) 实时跟随 (Stokes 数值仍 stale).
    state.selectedChamber = chamberOfDirection(currentD, currentRays());
    buildMarkerStrip(markStrip);
    refreshAllPaths();
    refreshUTable();  // U 表 input 跟 puncture 拖动同步 (用户能直接看到/复制坐标)
    canvas?.setState(state);  // 让 path layer 也跟着 punctures 重画 (live γ)
    refreshRecomputeBtn();
    updateStaleBanner();
    updateStokesPanel();
    updatePathInfo();
  };

  const svg = document.getElementById('canvas') as unknown as SVGSVGElement;
  const canvas: Canvas = new Canvas(svg, state, onStateChange);
  const zoomResetBtn = document.getElementById('zoom-reset');
  if (zoomResetBtn) zoomResetBtn.addEventListener('click', () => canvas.resetZoom());

  // ---------- Undo history ----------
  // 每次"用户级"动作前 pushHistory() 抓 snapshot. Undo = 弹栈+整体回放.
  // 不收 selectEntry / view 切换这类轻动作 (太噪).
  interface Snapshot {
    punctureOverrides: any;
    AOverrides: any;
    mOverrides: number[];
    n: number;
    currentD: number;
    currentK: number;
    selectedEntry: [number, number] | null;
    selectedChamber: number;
    sdView: any;
    stokesStale: boolean;
    exampleAwaitingCompute: boolean;
    precision: string;
    datasetJson: string;  // 序列化 dataset 用于回滚 compute
  }
  const history: Snapshot[] = [];
  const HISTORY_MAX = 200;
  let applyingSnapshot = false;
  const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement | null;
  function refreshUndoBtn() {
    if (undoBtn) undoBtn.disabled = history.length === 0;
  }
  function takeSnapshot(): Snapshot {
    return {
      punctureOverrides: JSON.parse(JSON.stringify(state.punctureOverrides ?? dataset.punctures)),
      AOverrides: JSON.parse(JSON.stringify(state.AOverrides)),
      mOverrides: [...(state.mOverrides ?? dataset.m_sizes)],
      n,
      currentD,
      currentK,
      selectedEntry: state.selectedEntry ? [state.selectedEntry[0], state.selectedEntry[1]] : null,
      selectedChamber: state.selectedChamber,
      sdView: state.sdView,
      stokesStale: state.stokesStale,
      exampleAwaitingCompute: state.exampleAwaitingCompute,
      precision: (document.getElementById('precision-select') as HTMLSelectElement)?.value ?? 'medium',
      datasetJson: JSON.stringify(dataset),
    };
  }
  function pushHistory() {
    if (applyingSnapshot) return;
    history.push(takeSnapshot());
    if (history.length > HISTORY_MAX) history.shift();
    refreshUndoBtn();
  }
  function applySnapshot(s: Snapshot) {
    applyingSnapshot = true;
    try {
      // dataset 内容回滚
      const restored = JSON.parse(s.datasetJson);
      Object.keys(dataset).forEach(k => delete (dataset as any)[k]);
      Object.assign(dataset, restored);
      // state
      state.punctureOverrides = JSON.parse(JSON.stringify(s.punctureOverrides));
      state.AOverrides = JSON.parse(JSON.stringify(s.AOverrides));
      state.mOverrides = [...s.mOverrides];
      state.selectedEntry = s.selectedEntry ? [s.selectedEntry[0], s.selectedEntry[1]] : null;
      state.selectedChamber = s.selectedChamber;
      state.sdView = s.sdView;
      state.stokesStale = s.stokesStale;
      state.exampleAwaitingCompute = s.exampleAwaitingCompute;
      // n + 维度
      n = s.n;
      nInput.value = String(n);
      buildUTable();
      buildATable();
      buildStokesMatrix();
      buildOmegaMatrix();
      // precision + sd-view 按钮态
      const psel = document.getElementById('precision-select') as HTMLSelectElement | null;
      if (psel) psel.value = s.precision;
      document.querySelectorAll<HTMLElement>('#sd-view-selector .sd-view-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.view === s.sdView);
      });
      // d (走 setD; 顺带刷新 marker / chamber / slider)
      setD(s.currentD, 'init');
      // 兜底刷新 (setD 内部已 cover 大部分, 这里保险 + 让 stale banner 反映 snapshot)
      canvas.setState(state);
      updateStaleBanner();
      refreshRecomputeBtn();
      refreshStokesMatrix();
      refreshAllPaths();
      updateStokesPanel();
      updatePathInfo();
      updateDimInfo();
    } finally {
      applyingSnapshot = false;
    }
    refreshUndoBtn();
  }
  function undo() {
    if (applyingSnapshot) return;
    const s = history.pop();
    if (!s) return;
    applySnapshot(s);
  }
  if (undoBtn) undoBtn.addEventListener('click', undo);
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      const tag = (e.target as HTMLElement)?.tagName;
      // 在 input 内的原生 undo 不要劫持
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      undo();
    }
  });
  canvas.onDragStart = () => pushHistory();
  refreshUndoBtn();

  // ---------- left panel: entry grid ----------
  // entry 选择: 右栏 Stokes matrix 每个 cell 已经支持点击 (selectEntry),
  // 左栏不再放冗余的 N×N 小方格选择器. (用户 2026-05-12 反馈)

  // ---------- d slider (连续, 区间 [2kπ, (2k+2)π], 输入框 π 单位) ----------
  const sliderWrap = document.getElementById('d-slider-wrap')!;
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.step = '0.0001';
  sliderWrap.appendChild(slider);
  const dHeading = document.getElementById('d-heading')!;
  const dInput = document.getElementById('d-input') as HTMLInputElement;


  const markStrip = document.createElement('div');
  markStrip.id = 'd-marker-strip';
  sliderWrap.appendChild(markStrip);
  // buildMarkerStrip 推迟到 setD('init') 第一次调用时 (那时 currentK 才确定)

  // 默认 d: 优先用 dataset 里的 d_reg (v5 的 reference direction, 落在 [-π, π) 内);
  // 没有时 fallback -π/2.
  let initialD = -Math.PI / 2;
  try {
    const meta = (dataset as any)._v5;
    const dReg = meta && typeof meta.d_reg === 'number' ? meta.d_reg : null;
    if (dReg !== null) {
      // d_reg 已经在 (-π, π] 区间内; normalize 到 [-π, π) 避开 +π 边界
      let normalized = dReg;
      while (normalized >= Math.PI) normalized -= 2 * Math.PI;
      while (normalized < -Math.PI) normalized += 2 * Math.PI;
      initialD = normalized;
    }
  } catch { /* ignore, use fallback */ }
  let currentD = initialD;

  // 当前 d-window 的 k: d-window = [(2k-1)π, (2k+1)π).
  // 0-branch (k=0) 是 [-π, π); 输入 d=2.3π 时 k 切到 1, window = [π, 3π).
  let currentK = 0;

  function windowOf(d: number): number {
    // round(d / 2π); 即把 d 划分到最近的 [2kπ-π, 2kπ+π) window.
    return Math.round(d / (2 * Math.PI));
  }

  function setD(d: number, source: 'slider' | 'input' | 'init' = 'init') {
    currentD = d;
    if (source !== 'slider') {
      currentK = windowOf(d);
      const lo = (2 * currentK - 1) * Math.PI;
      const hi = (2 * currentK + 1) * Math.PI;
      slider.min = String(lo);
      slider.max = String(hi);
      slider.value = String(d);
      buildMarkerStrip(markStrip);
    }
    // input 框: 永远显示当前 d (in units of π)
    dInput.value = formatPi(d / Math.PI);
    canvas.setDirection(d);
    const newCh = chamberOfDirection(d, currentRays());
    state.selectedChamber = newCh;
    refreshAllPaths();
    canvas.setState(state);
    refreshStokesMatrix();
    updateDHeading();
    updateStokesPanel();
    updatePathInfo();
  }

  slider.addEventListener('input', () => setD(Number(slider.value), 'slider'));
  // slider 一次拖动手势抓一次 snapshot — 不要每个 step 抓 (噪).
  slider.addEventListener('mousedown', () => pushHistory());
  slider.addEventListener('touchstart', () => pushHistory(), { passive: true });

  dInput.addEventListener('change', () => commitInput());
  dInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitInput(); dInput.blur(); }
  });
  function commitInput() {
    const v = parsePiInput(dInput.value);
    if (v === null) {
      dInput.value = formatPi(currentD / Math.PI);   // 还原
      dInput.classList.add('invalid');
      setTimeout(() => dInput.classList.remove('invalid'), 600);
      return;
    }
    const newD = v * Math.PI;
    if (newD !== currentD) pushHistory();
    setD(newD, 'input');
  }

  function buildMarkerStrip(el: HTMLDivElement) {
    el.innerHTML = '';
    // 当前 window: [(2k-1)π, (2k+1)π). rays 数据是 mod 2π 在 [0, 2π) 内.
    // 把每个 ray lift 到 window: lifted = r + 2πm for some m, 使得 lifted ∈ window.
    const lo = (2 * currentK - 1) * Math.PI;
    const hi = (2 * currentK + 1) * Math.PI;
    const span = hi - lo;
    for (const r of currentRays()) {
      // 找 m 让 lifted ∈ [lo, hi)
      let lifted = r;
      while (lifted >= hi) lifted -= 2 * Math.PI;
      while (lifted < lo) lifted += 2 * Math.PI;
      const m = document.createElement('div');
      m.className = 'd-mark ray';
      const x = (lifted - lo) / span;
      m.style.left = `${x * 100}%`;
      m.title = `anti-Stokes ray  ${(lifted * 180 / Math.PI).toFixed(2)}°  =  ${(lifted / Math.PI).toFixed(4)} π`;
      el.appendChild(m);
    }
  }

  function piTexFromInt(n: number): string {
    if (n === 0) return '0';
    if (n === 1) return '\\pi';
    if (n === -1) return '-\\pi';
    return `${n}\\pi`;
  }

  function updateDHeading() {
    const lo = 2 * currentK - 1;
    const hi = 2 * currentK + 1;
    dHeading.innerHTML = `Direction ` + tex(`d \\in [${piTexFromInt(lo)},\\ ${piTexFromInt(hi)})`);
  }

  // ---------- n input ----------
  const nInput = document.getElementById('n-input') as HTMLInputElement;
  nInput.value = String(n);
  nInput.addEventListener('change', () => {
    const newN = Number(nInput.value);
    if (!Number.isInteger(newN) || newN < 1 || newN > 20) {
      nInput.value = String(n);
      return;
    }
    if (newN !== n) { pushHistory(); resizeN(newN); }
  });

  function resizeN(newN: number) {
    const oldN = n;
    const oldM = state.mOverrides!;
    const oldU = state.punctureOverrides!;

    // 新 U: 保留前 min, 多出来在半径 2 等距圆上
    const newU = Array.from({ length: newN }, (_, k) => {
      if (k < oldN) return { ...oldU[k] };
      const ang = 2 * Math.PI * k / newN;
      return { re: 2 * Math.cos(ang), im: 2 * Math.sin(ang) };
    });
    // 新 m: 保留前 min, 多出来 1
    const newM = Array.from({ length: newN }, (_, k) =>
      k < oldN ? oldM[k] : 1);

    applyBlockResize(newU, newM);
  }

  /**
   * 通用块结构重置: 把当前 (U, A, m) 重建到给定 (newU, newM).
   * - U 保持给的 newU (不再回填)
   * - A 按 block 索引拷贝可保留的 entries (oldM[I] / newM[I] 取 min × min)
   * - 新增 block 对角默认 0.1, 新增 sub-entry 默认 0
   * - 触发所有 UI 重建 + stale banner
   * 不变量: newU.length === newM.length
   */
  function applyBlockResize(newU: typeof state.punctureOverrides, newM: number[]) {
    const oldN = n;
    const oldM = state.mOverrides!;
    const oldA = state.AOverrides!;
    const newN = newM.length;
    if (!newU || newU.length !== newN) throw new Error('applyBlockResize: U/m length mismatch');

    const newN_total = totalMultiplicity(newM);
    const newA = Array.from({ length: newN_total }, () =>
      Array.from({ length: newN_total }, () => ({ re: 0, im: 0 })));
    // 拷贝旧 block 数据 (block index < min(oldN, newN), sub-index < min(oldM[I], newM[I]))
    const minN = Math.min(oldN, newN);
    const oldStarts: number[] = []; let so = 0;
    for (const m of oldM) { oldStarts.push(so); so += m; }
    const newStarts: number[] = []; let sn = 0;
    for (const m of newM) { newStarts.push(sn); sn += m; }
    for (let I = 0; I < minN; I++) {
      for (let J = 0; J < minN; J++) {
        const mi = Math.min(oldM[I], newM[I]);
        const mj = Math.min(oldM[J], newM[J]);
        for (let a = 0; a < mi; a++) {
          for (let b = 0; b < mj; b++) {
            newA[newStarts[I] + a][newStarts[J] + b] =
              { ...oldA[oldStarts[I] + a][oldStarts[J] + b] };
          }
        }
      }
    }
    // 新增 block 对角 entry 默认 0.1
    for (let I = oldN; I < newN; I++) {
      newA[newStarts[I]][newStarts[I]] = { re: 0.1, im: 0 };
    }
    // 已存在 block, m_I 变大时新加的行/列默认全 0 (用户预期: 扩张子矩阵补零).
    // newA 已默认初始化为 0, 不需要任何操作.

    state.punctureOverrides = newU;
    state.mOverrides = newM;
    state.AOverrides = newA;
    state.selectedEntry = null;
    state.paths.clear();
    state.stokesStale = true;
    state.exampleAwaitingCompute = false;

    n = newN;
    nInput.value = String(n);

    buildUTable();
    buildATable();
    buildStokesMatrix();
    buildOmegaMatrix();
    updateDimInfo();
    updateStaleBanner();
    canvas.setState(state);
    refreshStokesMatrix();
    updateStokesPanel();
    updatePathInfo();
  }

  // ---------- left panel: U / A 表格, reset ----------
  buildUTable();
  buildATable();
  buildStokesMatrix();
  buildSdViewSelector();
  buildOmegaMatrix();
  buildOmegaViewSelector();
  updateDimInfo();
  // ISC 状态. 必须在 setupIscLauncher() 调用前声明 — 否则 TDZ.
  //   iscCache: 按 (chamber, i, j) 索引的完整 RIES 候选列表 (供 ISC 结果面板展示).
  //   iscLibrary: 全局"已识别值 → 闭式"字典 — ISC 过的每个浮点值登记进来,
  //               之后任何 cell 的 re/im 数值匹配某登记值 (或其负数) → 自动闭式蓝字.
  //               跨 chamber/view 自然传播 RIES 识别成果.
  const iscCache = new Map<string, IscCandidate[]>();
  const iscLibrary: Array<{ value: number; form: string }> = [];
  // 精确传播结果: chamberIdx → 整数矩阵 (off-diag). 由 wall-crossing 从 ISC 后的
  // base chamber 推出. 跟 iscLibrary 并行 — cell 渲染优先查它 (代数精确), 没命中再查 library.
  const exactByChamber = new Map<number, IntMatrix>();
  let iscRunning = false;
  setupResizeHandles();
  setupInputModeToggles();
  setupIscLauncher();

  function setupInputModeToggles() {
    interface ToggleCfg {
      hostId: string;
      tableId: string;
      get: () => 'pair' | 'expr';
      set: (m: 'pair' | 'expr') => void;
      getHidden: () => boolean;
      setHidden: (v: boolean) => void;
      rebuild: () => void;
    }
    const cfg: ToggleCfg[] = [
      {
        hostId: 'u-mode-toggle', tableId: 'u-table',
        get: () => uInputMode, set: m => { uInputMode = m; },
        getHidden: () => uSourceHidden, setHidden: v => { uSourceHidden = v; },
        rebuild: () => buildUTable(),
      },
      {
        hostId: 'a-mode-toggle', tableId: 'a-table',
        get: () => aInputMode, set: m => { aInputMode = m; },
        getHidden: () => aSourceHidden, setHidden: v => { aSourceHidden = v; },
        rebuild: () => buildATable(),
      },
    ];
    for (const c of cfg) {
      const host = document.getElementById(c.hostId);
      if (!host) continue;
      host.innerHTML =
        `<span class="mode-group">` +
          `<button class="mode-btn" data-mode="pair">Re / Im</button>` +
          `<button class="mode-btn" data-mode="expr">Expression</button>` +
        `</span>` +
        `<button class="source-toggle" type="button" hidden></button>`;
      const srcBtn = host.querySelector<HTMLButtonElement>('.source-toggle')!;
      const render = () => {
        host.querySelectorAll<HTMLButtonElement>('.mode-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.mode === c.get());
        });
        srcBtn.hidden = c.get() !== 'expr';
        srcBtn.textContent = c.getHidden() ? 'Show source' : 'Hide source';
      };
      const applyHidden = () => {
        const t = document.getElementById(c.tableId);
        if (!t) return;
        const active = c.get() === 'expr' && c.getHidden();
        t.classList.toggle('source-hidden', active);
        if (!active) {
          // 离开 hide 状态: 把所有 .editing 临时编辑态清掉
          t.querySelectorAll('.cx-expr-cell.editing').forEach(e => e.classList.remove('editing'));
        }
      };
      render();
      applyHidden();
      host.querySelectorAll<HTMLButtonElement>('.mode-btn').forEach(b => {
        b.addEventListener('click', () => {
          const m = b.dataset.mode as 'pair' | 'expr';
          if (m === c.get()) return;
          c.set(m);
          c.rebuild();
          applyHidden();
          render();
        });
      });
      srcBtn.addEventListener('click', () => {
        c.setHidden(!c.getHidden());
        applyHidden();
        render();
      });
      // 点 preview → 临时显示 input 可编辑, blur 回隐藏. 事件委托, 不被 buildXTable 重置.
      const t = document.getElementById(c.tableId);
      if (t) {
        t.addEventListener('click', (e) => {
          if (!t.classList.contains('source-hidden')) return;
          const tgt = e.target as HTMLElement;
          const cell = tgt.closest('.cx-expr-cell') as HTMLElement | null;
          if (!cell || cell.classList.contains('editing')) return;
          cell.classList.add('editing');
          const inp = cell.querySelector<HTMLInputElement>('input.cx-expr');
          inp?.focus();
          inp?.select();
        });
        t.addEventListener('focusout', (e) => {
          const tgt = e.target as HTMLElement;
          if (!tgt.classList.contains('cx-expr')) return;
          const cell = tgt.closest('.cx-expr-cell') as HTMLElement | null;
          cell?.classList.remove('editing');
        });
      }
    }
  }
  const precisionSelect = document.getElementById('precision-select') as HTMLSelectElement;
  let _precisionLast = precisionSelect.value;
  precisionSelect.addEventListener('mousedown', () => { _precisionLast = precisionSelect.value; });
  precisionSelect.addEventListener('change', () => {
    if (precisionSelect.value !== _precisionLast) pushHistory();
    _precisionLast = precisionSelect.value;
    refreshStokesMatrix();
    updateStokesPanel();
  });
  // Compute 按钮: 始终可点 (用户反馈 "锁就是不对, 按一下就该算一遍").
  // stokesStale 仅用于驱动 stale-banner 文案; 不再控制按钮 disabled.
  // computing 期间按钮变成 Cancel (click handler 内分支), 仍然 enabled.
  const recomputeBtn = document.getElementById('state-recompute') as HTMLButtonElement;
  const recomputeOmegaBtn = document.getElementById('state-recompute-omega') as HTMLButtonElement | null;
  if (recomputeOmegaBtn) {
    recomputeOmegaBtn.addEventListener('click', () => {
      // 算法待用户给规格. 目前占位 alert.
      alert('Central connection matrix algorithm not implemented yet. Specification pending.');
    });
  }
  const recomputeStatus = document.getElementById('recompute-status')!;
  let backendAvailable = false;

  function renderBackendStatus() {
    const base = getBackendBase();
    const baseDisplay = base || '(local server)';
    const escapedBaseTitle = escapeHtml(`${baseDisplay} — click change… to switch`);
    const heading = backendAvailable
      ? `<span style="color:var(--good)" title="${escapedBaseTitle}">● compute server connected</span>`
      : `<span style="color:var(--warn,#d4a76a)" title="${escapedBaseTitle}">● compute server offline</span>`;
    const description = backendAvailable
      ? ''
      : '<div style="color:var(--fg-muted);font-size:11px;line-height:1.4;margin:2px 0">'
        + 'Recomputing the Stokes matrix after editing <span data-tex="(U, A, m)"></span> requires the compute server. '
        + 'You can still pan, change the direction <span data-tex="d"></span>, and read off pre-computed entries while it is offline.'
        + '</div>';
    recomputeStatus.innerHTML = `
      <div style="font-size:11px;line-height:1.5">
        ${heading}
        <button id="backend-edit" type="button" style="margin-left:6px;font-size:10px;padding:0 6px;cursor:pointer">change…</button>
        ${description}
      </div>
    `;
    renderAllTex(recomputeStatus);
    const editBtn = document.getElementById('backend-edit');
    if (editBtn) editBtn.addEventListener('click', () => {
      const cur = getBackendBase();
      const next = window.prompt(
        'Compute server URL (leave empty for a same-origin local server).\nExample: https://sd-viz.dtq1997.org',
        cur,
      );
      if (next === null) return; // cancelled
      setBackendBase(next);
      // recheck
      recomputeStatus.textContent = 'reconnecting…';
      backendOnline().then(ok => {
        backendAvailable = ok;
        renderBackendStatus();
        refreshRecomputeBtn();
      });
    });
    if (!backendAvailable) {
      recomputeBtn.title = 'Compute server offline. Click "change…" to point at another server, or wait for the host to come back.';
    } else {
      recomputeBtn.removeAttribute('title');
    }
  }
  function refreshRecomputeBtn() {
    // 永远 enabled. computing 期间已经被 setComputingLock + classList 'computing' 处理.
    if (recomputeBtn.classList.contains('computing')) return;
    recomputeBtn.disabled = false;
  }

  backendOnline().then(ok => {
    backendAvailable = ok;
    renderBackendStatus();
    refreshRecomputeBtn();
  });
  /**
   * 计算进行中锁定 / 解锁所有用户输入. 防止重算正跑时用户改了 (U, A, m, d)
   * 让 frontend state 跟 backend 收到的 snapshot 不一致.
   *
   * 锁住的 surface:
   *   - svg 上 puncture / path-vertex drag (canvas.setInteractionLocked)
   *   - n 输入, U/A 表所有 input
   *   - d 输入框 + slider
   *   - precision select
   */
  function setComputingLock(locked: boolean) {
    canvas.setInteractionLocked(locked);
    const inputs = document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
      '#n-input, #precision-select, #d-input, #d-slider-wrap input, '
      + '#u-table input, #a-table input'
    );
    inputs.forEach(el => { el.disabled = locked; });
    document.body.classList.toggle('computing-lock', locked);
  }

  let currentJobId: string | null = null;
  recomputeBtn.addEventListener('click', async () => {
    // Cancel 模式: 如果正在 computing, 点击发送 cancel
    if (recomputeBtn.classList.contains('computing')) {
      if (currentJobId) await cancelJob(currentJobId);
      return;
    }
    if (recomputeBtn.disabled) return;
    pushHistory();  // 一旦点 Compute, 保存当前 state, 用户可 undo 回到 pre-compute
    recomputeBtn.disabled = false;
    recomputeBtn.classList.add('computing');
    recomputeBtn.textContent = 'Cancel';
    recomputeStatus.style.color = '';
    setComputingLock(true);
    try {
      const precisionSel = document.getElementById('precision-select') as HTMLSelectElement;
      const precision = (precisionSel?.value ?? 'medium') as 'fast' | 'low' | 'medium' | 'high';
      const algParam = new URLSearchParams(window.location.search).get('algorithm');
      const algorithm = algParam === 'legacy_entry' ? 'legacy_entry' : 'v5_full';
      const { result: newDs } = await recomputeAsync(
        {
          punctures: state.punctureOverrides!,
          A: state.AOverrides!,
          m_sizes: state.mOverrides!,
          precision,
          algorithm,
        },
        (s: JobStatus) => {
          const phase = (s.phase ?? '').trim();
          const detail = (s.phase_detail ?? '').trim();

          // 解析 detail (形如 "pair=(2,3)|done=5/12" 或 "chamber=8->9|done=11/11")
          const detailMap: Record<string, string> = {};
          for (const p of detail.split('|').filter(Boolean)) {
            const eq = p.indexOf('=');
            if (eq > 0) detailMap[p.slice(0, eq)] = p.slice(eq + 1);
          }
          const pairStr = detailMap.pair ?? '';
          const chamberStr = detailMap.chamber ?? '';
          const doneStr = detailMap.done ?? '';

          // 重做 UI 进度: 合并 sage-start + base-case 成 "Initial entries", 合并
          // wall-crossing + chamber-pack 成 "Wall-crossing". 短 phase 不再占独立 step.
          // Sub-text 实时描述具体在算什么 (entry / chamber / 引擎启动等).
          type StageKey = 'init' | 'cross';
          const stageOf: Record<string, StageKey> = {
            'starting sage': 'init',
            'base-case': 'init',
            'wall-crossing': 'cross',
            'chamber-pack': 'cross',
          };
          const stageOrder: StageKey[] = ['init', 'cross'];
          const stageLabel: Record<StageKey, string> = {
            init: 'Initial entries at d_reg',
            cross: 'Wall-crossing across chambers',
          };
          const curStage: StageKey = stageOf[phase] ?? 'init';
          const curIdx = stageOrder.indexOf(curStage);

          // sub-text: 用户能看到当前在做哪件事 (entry 或 chamber)
          let subText = '';
          if (phase === 'starting sage') {
            subText = 'starting Sage engine (cold start ~3–5s, then computing entries)';
          } else if (phase === 'base-case') {
            subText = pairStr
              ? `entry (i, j) = ${pairStr}${doneStr ? ' · ' + doneStr : ''}`
              : (doneStr || 'preparing entry sweep');
          } else if (phase === 'wall-crossing') {
            subText = chamberStr
              ? `chamber ${chamberStr}${doneStr ? ' · ' + doneStr : ''}`
              : (doneStr || 'crossing walls');
          } else if (phase === 'chamber-pack') {
            subText = s.chambers_total > 0
              ? `assembling ${s.chambers_done}/${s.chambers_total} chambers`
              : 'assembling final output';
          }

          // ETA: 用 progress / elapsed 估
          const eta = (s.progress > 0.05 && s.elapsed_s > 1)
            ? Math.max(0, s.elapsed_s / s.progress - s.elapsed_s)
            : null;

          const pct = Math.max(2, Math.round(s.progress * 100));

          // 2 阶段勾标 (compact)
          const checks = stageOrder.map((k, idx) => {
            let icon = '○';
            let cls = 'fg-muted';
            if (idx < curIdx) { icon = '✓'; cls = 'good'; }
            else if (idx === curIdx) { icon = '●'; cls = 'fg'; }
            return `<span style="color:var(--${cls},#888);margin-right:12px">${icon} ${escapeHtml(stageLabel[k])}</span>`;
          }).join('');

          const etaHtml = eta !== null ? ` · ETA ~${eta.toFixed(0)}s` : '';
          recomputeStatus.innerHTML =
            `<div style="font-size:12px;margin-bottom:3px"><strong>${escapeHtml(stageLabel[curStage])}</strong> <span class="dim">${s.elapsed_s.toFixed(1)}s${etaHtml}</span></div>` +
            `<div class="dim" style="font-size:11px;margin-bottom:5px">${escapeHtml(subText)}</div>` +
            `<div class="progress-bar" style="margin-bottom:4px"><div style="width:${pct}%"></div></div>` +
            `<div style="font-size:10px;line-height:1.4">${checks}</div>`;
        },
        (jobId) => { currentJobId = jobId; },
      );
      // 替换 dataset 内容
      Object.keys(dataset).forEach(k => delete (dataset as any)[k]);
      Object.assign(dataset, newDs);
      buildMarkerStrip(markStrip);
      state.selectedChamber = chamberOfDirection(currentD, currentRays());
      state.stokesStale = false;
      state.exampleAwaitingCompute = false;
      refreshAllPaths();
      canvas.setState(state);
      refreshStokesMatrix();
      updateDHeading();
      updateStokesPanel();
      updatePathInfo();
      updateStaleBanner();
      refreshIscLauncher();
      const elapsed = (newDs as any)._compute_seconds?.toFixed(1) ?? '?';
      recomputeStatus.innerHTML = `<span style="color: var(--good)">✓ finished in ${elapsed}s</span>`;
    } catch (e) {
      recomputeStatus.innerHTML = `<span style="color: var(--bad)">${(e as Error).message}</span>`;
    } finally {
      currentJobId = null;
      recomputeBtn.classList.remove('computing');
      recomputeBtn.textContent = 'Compute Stokes Matrices';
      setComputingLock(false);
      refreshRecomputeBtn();
    }
  });

  // 初始化默认值
  setD(currentD, 'init');

  function fmtNum(x: number): string {
    if (x === 0) return '0';
    return x.toFixed(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }
  // 输入框 value: a+bi 自然写法 — 实部正数不带 +, 虚部正数显示 +.
  // 负数永远 '-' (ASCII U+002D, Number() 可直接 parse).
  // 0 / -0 统一: 实部 '0.0000', 虚部 '+0.0000'.
  function fmtInputNum(x: number, axis: 're' | 'im' = 're'): string {
    if (!Number.isFinite(x)) return String(x);
    const s = x.toFixed(4);
    if (axis === 'im') return s.startsWith('-') ? s : '+' + s;
    return s;
  }
  function complexInputHtml(attrs: string, rePlaceholder = 'Re', imPlaceholder = 'Im'): string {
    return `<div class="cx-pair">` +
      `<input class="cx" ${attrs} data-axis="re" placeholder="${rePlaceholder}" />` +
      `<input class="cx" ${attrs} data-axis="im" placeholder="${imPlaceholder}" />` +
      `<span class="im-unit-suffix">${IM_UNIT}</span>` +
      `</div>`;
  }

  function buildUTable() {
    const t = document.getElementById('u-table')!;
    t.classList.add('u-table');
    const cellHtml = (k: number) => uInputMode === 'expr'
      ? complexExprInputHtml(`data-k="${k}"`, 'e.g. 2 + 3i')
      : complexInputHtml(`data-k="${k}"`);
    let html = `<thead><tr><th>${tex('k')}</th><th>${tex('u_k')}</th>` +
      `<th>${tex('m_k')}</th></tr></thead><tbody>`;
    for (let k = 0; k < n; k++) {
      html += `<tr><td class="row-label">${tex(`${k+1}`)}</td>` +
        `<td>${cellHtml(k)}</td>` +
        `<td><input class="cx mk-input" data-k="${k}" /></td></tr>`;
    }
    html += '</tbody>';
    t.innerHTML = html;
    refreshUTable();
    t.oninput = onUInput;
    t.onchange = onUEdit;
  }
  function refreshUTable() {
    const ps = state.punctureOverrides!;
    const ms = state.mOverrides!;
    // mk inputs (两种模式都在)
    document.querySelectorAll<HTMLInputElement>('#u-table input.mk-input').forEach(input => {
      input.value = String(ms[Number(input.dataset.k!)]);
    });
    if (uInputMode === 'expr') {
      document.querySelectorAll<HTMLInputElement>('#u-table input.cx-expr').forEach(input => {
        const k = Number(input.dataset.k!);
        const p = ps[k];
        const txt = p.expr ?? complexToExpr(p.re, p.im);
        input.value = txt;
        renderExprPreview(input.parentElement?.querySelector('.cx-preview') ?? null, txt);
      });
    } else {
      document.querySelectorAll<HTMLInputElement>('#u-table input.cx:not(.mk-input):not(.cx-expr)').forEach(input => {
        const k = Number(input.dataset.k!);
        const axis = input.dataset.axis as 're' | 'im';
        input.value = fmtInputNum(ps[k][axis], axis);
      });
    }
  }
  function onUEdit(e: Event) {
    const t = e.target as HTMLInputElement;
    if (!t.classList.contains('cx')) return;
    const k = Number(t.dataset.k!);
    if (t.classList.contains('mk-input')) {
      const m = Number(t.value);
      if (!Number.isInteger(m) || m < 1) { t.classList.add('invalid'); return; }
      t.classList.remove('invalid');
      const oldMk = state.mOverrides![k];
      if (m === oldMk) return;
      pushHistory();
      // 触发 block 重建: m_k 变意味着 A 维度 N=sum(m) 变, 必须重建 A.
      const newM = [...state.mOverrides!];
      newM[k] = m;
      const newU = state.punctureOverrides!.map(p => ({ ...p }));
      applyBlockResize(newU, newM);
      return;
    }
    if (t.classList.contains('cx-expr')) {
      const parsed = parseComplexExpr(t.value);
      if (parsed === null) { t.classList.add('invalid'); return; }
      t.classList.remove('invalid');
      const cur = state.punctureOverrides![k];
      const newExpr = t.value.trim();
      if (cur.re === parsed.re && cur.im === parsed.im && (cur.expr ?? '') === newExpr) return;
      pushHistory();
      state.punctureOverrides![k].re = parsed.re;
      state.punctureOverrides![k].im = parsed.im;
      state.punctureOverrides![k].expr = newExpr;
      state.stokesStale = true;
      state.exampleAwaitingCompute = false;
      onStateChange(state);
      canvas.setState(state);
      return;
    }
    const parsed = parseRational(t.value);
    if (parsed === null) { t.classList.add('invalid'); return; }
    t.classList.remove('invalid');
    const axis = t.dataset.axis as 're' | 'im';
    if (state.punctureOverrides![k][axis] === parsed) return;
    pushHistory();
    state.punctureOverrides![k][axis] = parsed;
    // pair 模式编辑覆盖 expr (原文已失效)
    state.punctureOverrides![k].expr = undefined;
    state.stokesStale = true;
    state.exampleAwaitingCompute = false;
    // U 改 → 跟 puncture 拖动效果一样: live rays / γ / slider marker 实时跟手.
    onStateChange(state);
    canvas.setState(state);
  }
  function readMInputPreview(): number[] | null {
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('#u-table input.mk-input'));
    if (inputs.length !== n) return null;
    const ms = inputs.map(input => Number(input.value));
    return ms.every(m => Number.isInteger(m) && m >= 1) ? ms : null;
  }
  function onUInput(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.classList.contains('mk-input')) {
      updateDimInfo(readMInputPreview() ?? state.mOverrides!);
      return;
    }
    if (t.classList.contains('cx-expr')) {
      // 实时预览, 不 commit. invalid 仅在非空且无法解析时标红.
      const txt = t.value;
      const parsed = parseComplexExpr(txt);
      t.classList.toggle('invalid', txt.trim() !== '' && parsed === null);
      renderExprPreview(t.parentElement?.querySelector('.cx-preview') ?? null, txt);
    }
  }
  function updateDimInfo(ms = state.mOverrides!) {
    const m_total = totalMultiplicity(ms);
    const el = document.getElementById('dim-info')!;
    el.innerHTML = tex(`m = \\sum_k m_k = ${m_total}`);
  }
  /** SSOT-consumer 统一: Stokes 渲染分支全部读 stokesStale.
   * U/A/m/puncture 任意编辑都置 state.stokesStale=true (见 111/318/631/717 行),
   * 渲染端不再自己做维度比对 — 单一不变式驱动 (uniform invariant enforcement,
   * 避免 shotgun parsing). */
  function stokesValuesFresh() {
    return !state.stokesStale;
  }

  /** A 表: N×N 复矩阵 (N = sum m_k), 按块结构加视觉分隔.
   * 列/行 header 用 flatIndexLabel: "I,a" 表示 block I 的 sub-index a (m_I>1 时), 否则只 "I". */
  function buildATable() {
    const t = document.getElementById('a-table') as HTMLTableElement;
    t.classList.add('a-table');
    const ms = state.mOverrides!;
    const N = totalMultiplicity(ms);
    const starts = blockStarts(ms);
    const blockOf = (fi: number) => {
      for (let k = ms.length - 1; k >= 0; k--) if (fi >= starts[k]) return [k, fi - starts[k]];
      return [-1, -1];
    };
    let html = '<thead><tr><th></th>';
    for (let fj = 0; fj < N; fj++) {
      const [J, b] = blockOf(fj);
      const cls = (fj > 0 && b === 0) ? 'block-left' : '';
      const lbl = flatIndexLabel(ms, J, b);
      html += `<th class="${cls}">${tex(lbl)}</th>`;
    }
    html += '</tr></thead><tbody>';
    for (let fi = 0; fi < N; fi++) {
      const [I, a] = blockOf(fi);
      const trCls = (fi > 0 && a === 0) ? 'block-top' : '';
      html += `<tr class="${trCls}">`;
      const rLbl = flatIndexLabel(ms, I, a);
      html += `<td class="row-label">${tex(rLbl)}</td>`;
      for (let fj = 0; fj < N; fj++) {
        const [J, b] = blockOf(fj);
        const cls = (fj > 0 && b === 0) ? 'block-left' : '';
        const inner = aInputMode === 'expr'
          ? complexExprInputHtml(`data-i="${fi}" data-j="${fj}"`)
          : complexInputHtml(`data-i="${fi}" data-j="${fj}"`);
        html += `<td class="${cls}">${inner}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody>';
    t.innerHTML = html;
    refreshATable();
    t.oninput = onAInput;
    t.onchange = onAEdit;
  }
  function refreshATable() {
    const A = state.AOverrides!;
    if (aInputMode === 'expr') {
      document.querySelectorAll<HTMLInputElement>('#a-table input.cx-expr').forEach(input => {
        const i = Number(input.dataset.i!);
        const j = Number(input.dataset.j!);
        const c = A[i][j];
        const txt = c.expr ?? complexToExpr(c.re, c.im);
        input.value = txt;
        renderExprPreview(input.parentElement?.querySelector('.cx-preview') ?? null, txt);
      });
    } else {
      document.querySelectorAll<HTMLInputElement>('#a-table input.cx:not(.cx-expr)').forEach(input => {
        const i = Number(input.dataset.i!);
        const j = Number(input.dataset.j!);
        const axis = input.dataset.axis as 're' | 'im';
        input.value = fmtInputNum(A[i][j][axis], axis);
      });
    }
  }
  function onAInput(e: Event) {
    const t = e.target as HTMLInputElement;
    if (!t.classList.contains('cx-expr')) return;
    const txt = t.value;
    const parsed = parseComplexExpr(txt);
    t.classList.toggle('invalid', txt.trim() !== '' && parsed === null);
    renderExprPreview(t.parentElement?.querySelector('.cx-preview') ?? null, txt);
  }
  function onAEdit(e: Event) {
    const t = e.target as HTMLInputElement;
    if (!t.classList.contains('cx')) return;
    const i = Number(t.dataset.i!);
    const j = Number(t.dataset.j!);
    if (t.classList.contains('cx-expr')) {
      const parsed = parseComplexExpr(t.value);
      if (parsed === null) { t.classList.add('invalid'); return; }
      t.classList.remove('invalid');
      const cur = state.AOverrides![i][j];
      const newExpr = t.value.trim();
      if (cur.re === parsed.re && cur.im === parsed.im && (cur.expr ?? '') === newExpr) return;
      pushHistory();
      state.AOverrides![i][j].re = parsed.re;
      state.AOverrides![i][j].im = parsed.im;
      state.AOverrides![i][j].expr = newExpr;
      state.stokesStale = true;
      state.exampleAwaitingCompute = false;
      updateStaleBanner();
      return;
    }
    const parsed = parseRational(t.value);
    if (parsed === null) { t.classList.add('invalid'); return; }
    t.classList.remove('invalid');
    const axis = t.dataset.axis as 're' | 'im';
    if (state.AOverrides![i][j][axis] === parsed) return;
    pushHistory();
    state.AOverrides![i][j][axis] = parsed;
    state.AOverrides![i][j].expr = undefined;
    state.stokesStale = true;
    state.exampleAwaitingCompute = false;
    updateStaleBanner();
  }

  function updateStaleBanner() {
    const b = document.getElementById('state-stale-banner')!;
    b.hidden = !state.stokesStale;
    if (state.stokesStale) {
      if (state.exampleAwaitingCompute) {
        b.innerHTML = `Example dataset — click <strong>Compute Stokes Matrices</strong> to compute`;
      } else {
        b.innerHTML = `${tex('(U, A, m)')} changed — Stokes values shown are out of date`;
      }
    }
    refreshRecomputeBtn();
  }

  /** -d 方向 label 排序: label[k] = 1-based rank descending of Im(u_k · e^{i·d}).
   *  与 sage 端 compute_sd.sage σ_d 规则一致 (Re(i·u_k·e^{id}) min ⇔ Im max ⇔ rank 1).
   *  driven by currentD + punctureOverrides; d 变 label 即变, 据此重组 S_d^+/S_d^-. */
  function dLabels(): number[] {
    const ps = state.punctureOverrides ?? dataset.punctures;
    const sin_d = Math.sin(currentD), cos_d = Math.cos(currentD);
    const proj = ps.map((u, k) => ({ k, v: u.re * sin_d + u.im * cos_d }));
    proj.sort((a, b) => b.v - a.v);
    const lab = new Array<number>(ps.length);
    proj.forEach((p, idx) => { lab[p.k] = idx + 1; });
    return lab;
  }

  function buildSdViewSelector() {
    const opts: ViewSpec<import('./lib/types.js').SdView>[] = [
      { key: 'std',   tex: 'S_d',                  title: 'standard Stokes matrix' },
      { key: 'plus',  tex: 'S_d^{+}',              title: 'upper part w.r.t. -d labels (diag = I)' },
      { key: 'minus', tex: 'S_d^{-}',              title: 'lower part w.r.t. -d labels, negated (diag = I)' },
      { key: 'eg',    tex: 'S_d^{\\mathrm{eg}}',   title: 'per-pair branch S_[τ_ij^closest], θ_ij = -arg(u_j - u_i)' },
    ];
    buildViewSelector({
      selectorId: 'sd-view-selector',
      views: opts,
      getCurrentView: () => state.sdView,
      onChange: (v) => {
        if (v === state.sdView) return;
        pushHistory();
        state.sdView = v;
        refreshSdViewSelector();
        refreshAllPaths();
        canvas.setState(state);
        refreshStokesMatrix();
        updateStokesPanel();
        updatePathInfo();
      },
    });
  }
  function refreshSdViewSelector() {
    refreshViewSelector('sd-view-selector', state.sdView);
  }

  /** Stokes 矩阵网格. SSOT 用 buildMatrixGrid; cell 含义靠 refreshStokesMatrix 内的
   * sdViewCellContent 决定 (diag identity vs zero, off-diag std/plus/minus/eg). */
  function buildStokesMatrix() {
    const ms = state.mOverrides ?? dataset.m_sizes;
    buildMatrixGrid({
      containerId: 'stokes-matrix',
      ms,
      onCellClick: (I, J) => selectEntry(I, J),
      tex,
    });
    refreshStokesMatrix();
  }

  /** 取 A 的 (I, I) 块对角 sub-matrix (m_I × m_I 复矩阵) from AOverrides. */
  function getABlock(I: number): ComplexNum[][] {
    const ms = state.mOverrides ?? dataset.m_sizes;
    const starts = blockStarts(ms);
    const sI = starts[I], mI = ms[I];
    const A = state.AOverrides!;
    return Array.from({ length: mI }, (_, a) =>
      Array.from({ length: mI }, (_, b) => ({ ...A[sI + a][sI + b] })));
  }

  /** 算每 (I, J) block 的 modified block = expm(-2πik·A_II) · value_block · expm(2πik·A_JJ).
   *  cache by chamber + d_user, 一次 refresh 算 n(n-1) 块.
   *  Paper L1056 块版严格修正. m=0 (sample d 同周期) 时 left=right=identity 退化. */
  function modifiedBlock(e: SdEntryData, d_sample: number, I: number, J: number): ComplexNum[][] {
    const block = e.value_block;
    if (!block) {
      // 兼容老 simple-case dataset: value_re/im → 1×1 block
      return [[{ re: e.value_re ?? 0, im: e.value_im ?? 0 }]];
    }
    const A_II = getABlock(I);
    const A_JJ = getABlock(J);
    const { left, right, m } = monodromyTransforms(currentD, d_sample, A_II, A_JJ);
    if (m === 0) return block;  // 不修正
    // left · block · right
    return mmul(mmul(left, block), right);
  }

  /** S_d^eg 的 (I, J) 块: raw v5 straight-entry anchor at tau_lift,
   *  shifted to the closest 2π lift of -arg(u_J-u_I) near 给定方向 d (默认 currentD). */
  function egBlock(I: number, J: number, atD?: number): ComplexNum[][] | null {
    const rawEntry = dataset._v5_eg_entries?.[`${I},${J}`];
    if (!rawEntry?.value_block || typeof rawEntry.tau_lift !== 'number') return null;
    const raw = rawEntry.value_block;
    const d = atD ?? currentD;

    /* tau_closest = θ_IJ + 2π·round((d - θ_IJ)/2π).
     * The baseline tau_lift is exported by sage from the raw v5 anchor, not
     * inferred from any S_d chamber value. */
    const ps = state.punctureOverrides ?? dataset.punctures;
    const dx = ps[J].re - ps[I].re, dy = ps[J].im - ps[I].im;
    let theta = -Math.atan2(dy, dx);
    while (theta >= Math.PI) theta -= 2 * Math.PI;
    while (theta < -Math.PI) theta += 2 * Math.PI;
    const tp = 2 * Math.PI;
    const m_d = Math.round((d - theta) / tp);
    const tau_closest = theta + m_d * tp;

    const A_II = getABlock(I), A_JJ = getABlock(J);
    const { left, right, m } = monodromyTransforms(tau_closest, rawEntry.tau_lift, A_II, A_JJ);
    return (m === 0) ? raw : mmul(mmul(left, raw), right);
  }

  /** 复数 entry 渲染为 HTML grid (5 列: sign | gap | 整数 | 小数 | i).
   * 两行 (re / im·i) 用同一 grid 让符号竖直对齐 + 小数点对齐 (整数右对齐 + 小数左对齐).
   * KaTeX 不支持 `array{r@{}l}` 的 `@{}` 列间距控制, 用 LaTeX 渲染会失败回退到源码.
   * 改用 HTML 完全可控. 字体用 KaTeX_Main 保持数学风格.
   * 模长 ≈ 0 → 单行 '0'.
   */
  function renderComplex(v: { re: number; im: number }, digits = 7): string {
    const mag = Math.hypot(v.re, v.im);
    const tinyThreshold = 10 ** -(digits + 2);
    if (mag < tinyThreshold) return `<span class="cs-zero">${tex('0')}</span>`;
    // a+bi 自然写法: 实部正不带 +, 负数 '−'; 虚部正显示 +, 负 '−'. (U+2212 minus, 视觉比 '-' 宽)
    const reSign = v.re < 0 ? '−' : '';
    const imSign = v.im >= 0 ? '+' : '−';
    const [reInt, reFrac] = splitBySigDigits(v.re, digits);
    const [imInt, imFrac] = splitBySigDigits(v.im, digits);
    return `<div class="cs-grid">
      <span class="cs-int"><span class="cs-sign">${reSign}</span>${reInt}</span><span class="cs-frac">${reFrac}</span><span class="cs-i"></span>
      <span class="cs-int"><span class="cs-sign">${imSign}</span>${imInt}</span><span class="cs-frac">${imFrac}</span><span class="cs-i">${IM_UNIT}</span>
    </div>`;
  }

  function refreshStokesMatrix() {
    const ch = dataset.chambers[state.selectedChamber];
    const digits = selectedPrecisionDigits();
    const valuesFresh = stokesValuesFresh();
    const view = state.sdView;
    const ms = state.mOverrides ?? dataset.m_sizes;

    // 预算 (I,J) modified block 缓存 (sub-cell 共享, 块内 a/b 多次取同 block).
    const blockCache = new Map<string, ComplexNum[][]>();
    if (valuesFresh) {
      for (let I = 0; I < ms.length; I++) for (let J = 0; J < ms.length; J++) {
        if (I === J) continue;
        if (view === 'eg') {
          const eg = egBlock(I, J);
          if (eg) blockCache.set(`${I},${J}`, eg);
        } else {
          const e = ch.entries[`${I},${J}`];
          if (!e || e.error || !e.value_block) continue;
          blockCache.set(`${I},${J}`, modifiedBlock(e, ch.d, I, J));
        }
      }
    }

    const labels = (view === 'plus' || view === 'minus') ? dLabels() : null;

    refreshMatrixCells({
      containerId: 'stokes-matrix',
      ms,
      digits,
      isStale: !valuesFresh,
      staleMessage: 'stale: recompute Stokes matrices',
      selectedEntry: state.selectedEntry,
      tex,
      renderComplex,
      // 跨 view 同尺寸: 永远扫 std view 所有 off-diag block 当宽度上界,
      // plus/minus/eg 即使 sign-zero 也不让列宽缩.
      // 例外: m=1 cell 能 symbolic 化 (本地 simple-identify 或 cache 命中) 时, 它的
      // 闭式宽度跟浮点完全无关, 不参与浮点小数点对齐计算 — 否则即使所有 cell 都
      // symbolic, 列宽还是被原浮点宽度撑住, 看着拖泥带水.
      widthReferenceBlocks: function*() {
        if (!valuesFresh) return;
        for (let I = 0; I < ms.length; I++) for (let J = 0; J < ms.length; J++) {
          if (I === J) continue;
          // 同时考虑 std 跟 eg 的浮点宽度 — 哪边 symbolic 化都不参与对齐.
          const e = ch.entries[`${I},${J}`];
          if (e && !e.error && e.value_block) {
            const mod = modifiedBlock(e, ch.d, I, J);
            if (!(ms[I] === 1 && ms[J] === 1 && getSymbolicCellExpr(I, J, mod[0][0]))) {
              yield mod;
            }
          }
          // eg 也单独看一眼 (用户可能在 eg view 下查看)
          const eg = egBlock(I, J);
          if (eg && !(ms[I] === 1 && ms[J] === 1 && getSymbolicCellExpr(I, J, eg[0][0]))) {
            yield eg;
          }
        }
      },
      getCellContent: (I, J, _a, _b): CellContent => {
        if (I === J) {
          // displayed S_d diag = 0 (约定); S_d^± diag = I_block (sub-cell a==b → 1).
          if (view === 'plus' || view === 'minus') return { kind: 'identity' };
          return { kind: 'zero' };
        }
        // 错误 cell
        const eRaw = ch.entries[`${I},${J}`];
        if (eRaw && eRaw.error) {
          return { kind: 'unavailable', tooltip: eRaw.error };
        }
        // plus/minus 按 label 排序保/置 0
        let sign: 1 | -1 | 0 = 1;
        if (view === 'plus')  sign = labels![I] < labels![J] ? 1 : 0;
        if (view === 'minus') sign = labels![I] > labels![J] ? -1 : 0;
        if (sign === 0) return { kind: 'zero' };
        const mod = blockCache.get(`${I},${J}`);
        if (!mod) {
          return { kind: 'unavailable', tooltip: view === 'eg' ? 'straight-entry data unavailable' : 'entry data unavailable' };
        }
        // ISC symbolic 入口: 所有 view (std / plus / minus / eg) 共用同一查询.
        // 关键不变量: 不管 view, cell 渲染只 ask "这个浮点对应哪个闭式" — library 不感知 view.
        // minus 时把 value 取负再 lookup — 让 library + negateForm 给干净负形式 (避 -(-3)).
        // SSOT: 未来加新矩阵 (从 S_d 派生的 Ω 等) 一样走 getSymbolicCellExpr(I, J, displayedValue).
        if (ms[I] === 1 && ms[J] === 1) {
          const baseV = mod[0][0];
          const displayV = sign === -1 ? { re: -baseV.re, im: -baseV.im } : baseV;
          const sym = getSymbolicCellExpr(I, J, displayV);
          if (sym) return { kind: 'symbolic', latex: sym.latex, tooltip: sym.tooltip };
        }
        if (sign === -1) {
          // 整块取负
          return {
            kind: 'block',
            block: mod.map(row => row.map(v => ({ re: -v.re, im: -v.im }))),
          };
        }
        return { kind: 'block', block: mod };
      },
    });
  }

  // ---------- Ω_d 中心连接矩阵 ----------
  // SSOT: 复用 matrix-panel 的 buildMatrixGrid / refreshMatrixCells. 跟 Stokes 矩阵
  // 完全同一套渲染. 算法尚未实现, 所有 cell 显示 "—" + tooltip "algorithm not implemented yet".
  // 后续 (a) 算出 data 后 fill ch.omega_entries 或类似; (b) 加 omegaStale 标志位;
  // (c) getCellContent 接 omega data; refreshOmegaMatrix 调用方式不动.

  function buildOmegaViewSelector() {
    const opts: ViewSpec<import('./lib/types.js').OmegaView>[] = [
      { key: 'omega',     tex: '\\Omega_d',         title: 'central connection matrix (computed row-by-row → blocks on columns only)' },
      { key: 'omega-inv', tex: '\\Omega_d^{-1}',    title: 'inverse central connection matrix (computed column-by-column → blocks on rows only)' },
    ];
    buildViewSelector({
      selectorId: 'omega-view-selector',
      views: opts,
      getCurrentView: () => state.omegaView,
      onChange: (v) => {
        if (v === state.omegaView) return;
        pushHistory();
        state.omegaView = v;
        refreshOmegaViewSelector();
        // view 切换改了块结构 (omega 有列块, omega-inv 有行块) → 必须重 build grid.
        buildOmegaMatrix();
      },
    });
  }
  function refreshOmegaViewSelector() {
    refreshViewSelector('omega-view-selector', state.omegaView);
  }

  /** Ω/Ω^-1 矩阵. 块结构跟当前 view 绑定:
   *   - Ω: 算法一行一行算 → 列方向有块结构, 行方向无块 (每行独立).
   *   - Ω^-1: 算法一列一列算 → 行方向有块结构, 列方向无块.
   *  对角不特殊, 全部 cell 同等可点 (点击高亮所在块).
   */
  function buildOmegaMatrix() {
    const ms = state.mOverrides ?? dataset.m_sizes;
    const isOmega = state.omegaView === 'omega';
    buildMatrixGrid({
      containerId: 'omega-matrix',
      ms,
      // Ω/Ω^-1 选择跟 S_d 解耦. Ω 行块作整体被选, Ω^-1 列块作整体被选.
      onCellClick: (I, J) => selectOmegaBlock(I, J),
      rowBlocks: isOmega,    // omega 行块 (按行算 → 行作为整体单位)
      colBlocks: !isOmega,   // omega-inv 列块 (按列算 → 列作为整体单位)
      diagSelectable: true,  // 对角不特殊
      tex,
    });
    refreshOmegaMatrix();
  }

  function selectOmegaBlock(i: number, j: number) {
    state.selectedOmegaBlock = [i, j];
    // Ω 和 S_d 选中互斥
    if (state.selectedEntry !== null) {
      state.selectedEntry = null;
      refreshAllPaths();
      canvas.setState(state);
      refreshStokesMatrix();
      updateStokesPanel();
      updatePathInfo();
    }
    refreshOmegaMatrix();
  }

  function refreshOmegaMatrix() {
    const ms = state.mOverrides ?? dataset.m_sizes;
    const digits = selectedPrecisionDigits();
    const isOmega = state.omegaView === 'omega';
    // selectedOmegaBlock 存完整 (i, j); 按 view 决定高亮哪个轴.
    const sel: [number, number] | null = state.selectedOmegaBlock;
    // Ω data 待算; 目前永远 stale.
    refreshMatrixCells({
      containerId: 'omega-matrix',
      ms,
      digits,
      isStale: true,
      staleIncludesDiag: true,
      staleMessage: 'central connection matrix algorithm not implemented yet — click Compute Central Connection Matrix',
      selectedEntry: sel,
      selectionMode: isOmega ? 'row' : 'col',
      tex,
      renderComplex,
      getCellContent: (_I, _J, _a, _b): CellContent => {
        return { kind: 'unavailable' };
      },
    });
  }

  function selectEntry(i: number, j: number) {
    state.selectedEntry = [i, j];
    // S_d 和 Ω 选中互斥: 选 S_d entry 时清 Ω block, 反之亦然.
    state.selectedOmegaBlock = null;
    document.querySelectorAll('#entry-grid .cell').forEach((el, idx) => {
      const ii = Math.floor(idx / n), jj = idx % n;
      el.classList.toggle('selected', ii === i && jj === j);
    });
    refreshAllPaths();
    canvas.setState(state);
    refreshStokesMatrix();
    refreshOmegaMatrix();
    updateStokesPanel();
    updatePathInfo();
  }

  type CutCoord = { x: number; y: number };

  /** cut-coord: 旋转 plane 让所有 cut 沿 +y 方向 ("上"). cut 在 plane 里是
   *  { u_k + t·e^{-id}, t ≥ 0 } (canvas.renderCuts dirVec = expI(-d)).
   *  新坐标系 basis:
   *    new_y_hat = e^{-id} = (cos d, -sin d)   ← cut 方向
   *    new_x_hat = e^{-id}·(-i) = (-sin d, -cos d)   ← new_y_hat 顺时针 90°
   *  投影:
   *    new_x = -(re·sin d + im·cos d)
   *    new_y = re·cos d - im·sin d
   *  cut 在新坐标系下是 { (cut.x_new, cut.y_new + t), t ≥ 0 }, 即垂直射线向 +y. */
  function toCutCoord(p: ComplexNum, d: number): CutCoord {
    const c = Math.cos(d), s = Math.sin(d);
    return { x: -(p.re * s + p.im * c), y: p.re * c - p.im * s };
  }
  function fromCutCoord(p: CutCoord, d: number): ComplexNum {
    // inverse: re = -x·sin d + y·cos d, im = -x·cos d - y·sin d
    const c = Math.cos(d), s = Math.sin(d);
    return { re: -p.x * s + p.y * c, im: -p.x * c - p.y * s };
  }

  /** 判 ray { (cut.x, y) : y ≥ cut.y } 是否被线段 [a, b] 穿过.
   *  方法: 看线段在 x=cut.x 处的 y 值是否 ≥ cut.y. 线段 x 范围必须跨过 cut.x.
   *  padX: ray 视觉余量, cut.x ± padX 之内也算撞. */
  function segmentHitsCut(a: CutCoord, b: CutCoord, cut: CutCoord, padX = 0): boolean {
    const eps = 1e-9;
    const xmin = Math.min(a.x, b.x), xmax = Math.max(a.x, b.x);
    // 线段 x 区间不覆盖 cut.x (含 padX) → 不交
    if (xmax < cut.x - padX - eps || xmin > cut.x + padX + eps) return false;
    const dx = b.x - a.x;
    if (Math.abs(dx) < eps) {
      // 线段几乎竖直: x 跟 cut.x 相近 (前面没过滤掉), 看 y 范围跟 ray 是否重叠.
      return Math.max(a.y, b.y) >= cut.y - eps;
    }
    // 在线段上找 x = cut.x 那点; padX 区间内取最不利 (y 最大) 的撞测试
    // 简化: 检查 [cut.x - padX, cut.x + padX] 内线段上 y 的最大值 ≥ cut.y.
    const sample = [cut.x - padX, cut.x, cut.x + padX];
    let maxY = -Infinity;
    for (const sx of sample) {
      if (sx < xmin - eps || sx > xmax + eps) continue;
      const t = (sx - a.x) / dx;
      const y = a.y + t * (b.y - a.y);
      maxY = Math.max(maxY, y);
    }
    return maxY >= cut.y - eps;
  }

  /** 实系数三次方程 a3·t^3 + a2·t^2 + a1·t + a0 = 0 在开区间 (lo, hi) 内的所有实根.
   *  闭式 (depressed cubic + Cardano + 三角法), 退化到 quadratic / linear / 常数也处理.
   *  根做一次 Newton 抛光以消除浮点漂移.
   *  返回值未必排序; 调用方自行筛选. */
  function realCubicRootsIn(
    a3: number, a2: number, a1: number, a0: number,
    lo: number, hi: number,
  ): number[] {
    const eps = 1e-12;
    const out: number[] = [];
    const push = (t: number) => {
      // 一次 Newton 抛光 (在 t 处用三次导数)
      const f = ((a3 * t + a2) * t + a1) * t + a0;
      const fp = (3 * a3 * t + 2 * a2) * t + a1;
      if (Math.abs(fp) > 1e-14) t -= f / fp;
      if (t > lo - 1e-9 && t < hi + 1e-9) out.push(Math.min(hi, Math.max(lo, t)));
    };
    if (Math.abs(a3) < eps) {
      // 退化二次 a2·t^2 + a1·t + a0
      if (Math.abs(a2) < eps) {
        if (Math.abs(a1) < eps) return [];
        push(-a0 / a1);
        return out;
      }
      const disc = a1 * a1 - 4 * a2 * a0;
      if (disc < -eps) return [];
      const sd = Math.sqrt(Math.max(0, disc));
      push((-a1 - sd) / (2 * a2));
      push((-a1 + sd) / (2 * a2));
      return out;
    }
    // depressed: t = s - a2/(3 a3), 得 s^3 + p s + q = 0
    const A = a2 / a3, B = a1 / a3, C = a0 / a3;
    const shift = -A / 3;
    const p = B - A * A / 3;
    const q = (2 * A * A * A) / 27 - (A * B) / 3 + C;
    const disc = (q * q) / 4 + (p * p * p) / 27;
    if (disc > eps) {
      // 一个实根 (Cardano)
      const sq = Math.sqrt(disc);
      const u = Math.cbrt(-q / 2 + sq);
      const v = Math.cbrt(-q / 2 - sq);
      push(u + v + shift);
    } else if (disc < -eps) {
      // 三个实根 (三角法)
      const r = Math.sqrt(-(p * p * p) / 27);
      const phi = Math.acos(Math.min(1, Math.max(-1, -q / (2 * r))));
      const m = 2 * Math.cbrt(r);
      push(m * Math.cos(phi / 3) + shift);
      push(m * Math.cos((phi + 2 * Math.PI) / 3) + shift);
      push(m * Math.cos((phi + 4 * Math.PI) / 3) + shift);
    } else {
      // 重根 (disc ≈ 0)
      const u = Math.cbrt(-q / 2);
      push(2 * u + shift);
      push(-u + shift);
    }
    return out;
  }

  /** 判 Bezier B(t), t ∈ (0,1) 是否相交从 cut 出发 +y 方向的射线.
   *  方法: 解一元三次方程 B_x(t) = cut.x ± padX (padX>0 时取最不利侧).
   *  对每个实根 t* ∈ (eps, 1-eps), 看 B_y(t*) 是否 ≥ cut.y. 端点 (t=0, t=1) 即 u_i / u_j,
   *  不视为相交 (path 本来就从那里出发). 这是精确判定, 不靠 sampling. */
  function bezierHitsCut(
    a: CutCoord, c1: CutCoord, c2: CutCoord, b: CutCoord, cut: CutCoord, padX = 0,
  ): boolean {
    const epsT = 1e-6, epsY = 1e-9;
    // B(t) = (1-t)^3 P0 + 3(1-t)^2 t P1 + 3(1-t) t^2 P2 + t^3 P3
    //      = t^3 (-P0+3P1-3P2+P3) + t^2 (3P0-6P1+3P2) + t (-3P0+3P1) + P0
    const evalY = (t: number) => {
      const u = 1 - t, uu = u * u, tt = t * t;
      return uu * u * a.y + 3 * uu * t * c1.y + 3 * u * tt * c2.y + tt * t * b.y;
    };
    // padX>0 时考虑两侧 ray (cut.x - padX 和 cut.x + padX), 取任意命中即 hit.
    const targets = padX > 0 ? [cut.x - padX, cut.x, cut.x + padX] : [cut.x];
    for (const X of targets) {
      const p0 = a.x - X, p1 = c1.x - X, p2 = c2.x - X, p3 = b.x - X;
      const a3 = -p0 + 3 * p1 - 3 * p2 + p3;
      const a2 = 3 * p0 - 6 * p1 + 3 * p2;
      const a1 = -3 * p0 + 3 * p1;
      const a0 = p0;
      const roots = realCubicRootsIn(a3, a2, a1, a0, epsT, 1 - epsT);
      for (const t of roots) {
        if (evalY(t) >= cut.y - epsY) return true;
      }
    }
    return false;
  }

  function bezierHitsAnyCut(a: CutCoord, c1: CutCoord, c2: CutCoord, b: CutCoord, cuts: CutCoord[], padX = 0): boolean {
    for (const cut of cuts) {
      if (bezierHitsCut(a, c1, c2, b, cut, padX)) return true;
    }
    return false;
  }

  function cubicPoint(a: CutCoord, c1: CutCoord, c2: CutCoord, b: CutCoord, t: number): CutCoord {
    const u = 1 - t, uu = u * u, tt = t * t;
    return {
      x: uu * u * a.x + 3 * uu * t * c1.x + 3 * u * tt * c2.x + tt * t * b.x,
      y: uu * u * a.y + 3 * uu * t * c1.y + 3 * u * tt * c2.y + tt * t * b.y,
    };
  }

  function roundedDetourHasStableTurn(beziers: Array<[CutCoord, CutCoord, CutCoord, CutCoord]>): boolean {
    const samples: CutCoord[] = [];
    for (const [a, c1, c2, b] of beziers) {
      for (let k = samples.length === 0 ? 0 : 1; k <= 24; k++) {
        samples.push(cubicPoint(a, c1, c2, b, k / 24));
      }
    }
    let turnSign = 0;
    const eps = 1e-6;
    for (let k = 1; k < samples.length - 1; k++) {
      const u = { x: samples[k].x - samples[k - 1].x, y: samples[k].y - samples[k - 1].y };
      const v = { x: samples[k + 1].x - samples[k].x, y: samples[k + 1].y - samples[k].y };
      const cross = u.x * v.y - u.y * v.x;
      if (Math.abs(cross) < eps) continue;
      const s = Math.sign(cross);
      if (turnSign === 0) turnSign = s;
      else if (s !== turnSign) return false;
    }
    return true;
  }

  function cubicVerticesFromBeziers(beziers: Array<[CutCoord, CutCoord, CutCoord, CutCoord]>, d: number): ComplexNum[] {
    const vertices: ComplexNum[] = [];
    if (beziers.length === 0) return vertices;
    vertices.push(fromCutCoord(beziers[0][0], d));
    for (const [, c1, c2, b] of beziers) {
      vertices.push(fromCutCoord(c1, d), fromCutCoord(c2, d), fromCutCoord(b, d));
    }
    return vertices;
  }

  function buildRoundedSafetyLane(
    a: CutCoord,
    b: CutCoord,
    cuts: CutCoord[],
    chord: number,
    padY: number,
    side: -1 | 0 | 1,
    depthScale: number,
    handleScale: number,
  ): Array<[CutCoord, CutCoord, CutCoord, CutCoord]> {
    const dx = b.x - a.x;
    const absDx = Math.abs(dx);
    const xDir = absDx > 1e-9 ? Math.sign(dx) : (side || 1);
    const lateral = side === 0 ? 0 : side * Math.max(0.35, 0.35 * chord, 2.5 * padY);
    const p1Base = { x: a.x + lateral, y: 0 };
    const p2Base = { x: b.x + lateral, y: 0 };
    const xLo = Math.min(a.x, b.x, p1Base.x, p2Base.x);
    const xHi = Math.max(a.x, b.x, p1Base.x, p2Base.x);
    const betweenCuts = cuts.filter(c => c.x >= xLo - 1e-9 && c.x <= xHi + 1e-9);
    const yLow = Math.min(a.y, b.y, ...betweenCuts.map(c => c.y)) - padY * depthScale;
    const p1 = { x: p1Base.x, y: yLow };
    const p2 = { x: p2Base.x, y: yLow };
    const laneDir = Math.abs(p2.x - p1.x) > 1e-9 ? Math.sign(p2.x - p1.x) : xDir;

    const dist = (p: CutCoord, q: CutCoord) => Math.hypot(q.x - p.x, q.y - p.y);
    const h = (p: CutCoord, q: CutCoord, cap: number) =>
      Math.max(0, Math.min(dist(p, q) * handleScale / 3, cap));
    const laneWidth = Math.max(Math.abs(p2.x - p1.x), 0.30 * chord, 0.30);
    const h01 = h(a, p1, laneWidth * 0.55);
    const h12 = Math.abs(p2.x - p1.x) * handleScale / 3;
    const h23 = h(p2, b, laneWidth * 0.55);
    return [
      [
        a,
        { x: a.x, y: a.y - h01 },
        { x: p1.x - laneDir * h01, y: p1.y },
        p1,
      ],
      [
        p1,
        { x: p1.x + laneDir * h12, y: p1.y },
        { x: p2.x - laneDir * h12, y: p2.y },
        p2,
      ],
      [
        p2,
        { x: p2.x + laneDir * h23, y: p2.y },
        { x: b.x, y: b.y - h23 },
        b,
      ],
    ];
  }

  /** S_d view 自然路径 (3 段直线版):
   *
   *  cut-coord 下 cut 是 +y 半射线. 直线不撞 cut → 直接 a→b. 否则走 3 段:
   *    seg1: a → (a.x, safe_y)   (-y, 即 plane 中 +d 方向, "-d 反方向")
   *    seg2: (a.x, safe_y) → (b.x, safe_y)   (沿 x 轴, 与 cut 方向 90°)
   *    seg3: (b.x, safe_y) → b   (+y, 即 plane 中 -d 方向, 到达 u_j)
   *  safe_y = min(min_k(y_k) - ε, min(a.y, b.y) - ε), k 取 cut 起点 x ∈ (min(a.x,b.x), max) 的.
   *  中段在 safe_y < y_k ⇒ 不交任何 cut; seg1/seg3 是 x=a.x / x=b.x 上的竖线, 通常情况下
   *  不撞 (例外: 某 u_k 的 cut-coord x = a.x 或 b.x, 几何重合 case 不处理).
   */
  function computeNaturalPath(i: number, j: number, punctures: ComplexNum[], d: number): {
    vertices: ComplexNum[];
    kind: 'line' | 'cubic';
  } {
    const start = punctures[i], end = punctures[j];
    const a = toCutCoord(start, d), b = toCutCoord(end, d);
    const cuts = punctures.map((p, k) => ({ k, p: toCutCoord(p, d) }))
      .filter(x => x.k !== i && x.k !== j).map(x => x.p);
    const chord = Math.hypot(b.x - a.x, b.y - a.y);

    if (cuts.length === 0 || !cuts.some(cut => segmentHitsCut(a, b, cut, 0))) {
      return { vertices: [{ ...start }, { ...end }], kind: 'line' };
    }

    const eps = Math.max(0.06, 0.06 * chord);
    const xLo = Math.min(a.x, b.x), xHi = Math.max(a.x, b.x);
    const blockers = cuts.filter(c => c.x > xLo + 1e-9 && c.x < xHi - 1e-9);
    let safeY = Math.min(a.y, b.y) - eps;
    for (const c of blockers) safeY = Math.min(safeY, c.y - eps);
    const P1 = fromCutCoord({ x: a.x, y: safeY }, d);
    const P2 = fromCutCoord({ x: b.x, y: safeY }, d);
    // 加一个中段中点 (P1+P2)/2: 让 vertex 数 = 5, canvas renderPaths 才走 polyline 分支
    // (4 顶点会被 (len-1)%3===0 检测当成 Bezier 控制点序列, 渲染成 M..C..).
    const Pmid: ComplexNum = { re: (P1.re + P2.re) / 2, im: (P1.im + P2.im) / 2 };
    return { vertices: [{ ...start }, P1, Pmid, P2, { ...end }], kind: 'line' };
  }

  function refreshAllPaths() {
    state.paths.clear();
    if (!state.selectedEntry) return;
    const [i, j] = state.selectedEntry;
    if (i === j) return;
    if (state.sdView === 'plus' || state.sdView === 'minus') return;
    // γ_ij^(d) 是纯几何 (punctures + d), 不依赖 Stokes 数值. 即便 stale 也要 live 跟随
    // u_k 拖动. 拿不到 chamber entry 也无所谓 (path 视觉, 数值面板自己处理 stale).
    const ps = state.punctureOverrides ?? dataset.punctures;
    const path = state.sdView === 'eg'
      ? { vertices: [{ ...ps[i] }, { ...ps[j] }], kind: 'line' as const }
      : computeNaturalPath(i, j, ps, currentD);
    const id = `${i},${j}:${state.sdView === 'eg' ? 'eg-line' : `std-natural-${path.kind}`}`;
    state.paths.set(id, { i, j, vertices: path.vertices, homotopyId: id });
  }

  // ---------- ISC (Inverse Symbolic Computation) ----------
  // 缓存按 (chamber, i, j) 索引. 切 chamber/d 时如果命中 → 复用; 不命中 → 用户主动触发.
  // 注意: iscCache / iscRunning 实际声明在文件前面 (hoisted before setupIscLauncher()) 防 TDZ.
  function iscKey(chamber: number, i: number, j: number): string {
    return `${chamber}_${i}_${j}`;
  }
  /** ISC 全局值库登记: 把候选里的 value-form 加入 iscLibrary (按 (engine, kind) 优先级).
   *  同 value 只存一个 form (优先 kind 等级高的). 同 value 已存且新 form 等级更优 → 替换. */
  function registerIscLibrary(cands: IscCandidate[]) {
    const kindRank: Record<string, number> = {
      integer: 0, rational: 1, 'pi-rational': 2, sqrt: 3, 'ries-value': 4, wolfram: 5,
    };
    // 按 axis × value 分组取最优
    const byKey = new Map<string, IscCandidate>();
    for (const c of cands) {
      if (!iscIsValueForm(c)) continue;
      if (c.axis !== 'Re' && c.axis !== 'Im') continue;  // |z|/arg 不直接当 entry 的 re/im
      const key = `${c.value}`;
      const ex = byKey.get(key);
      if (!ex || (kindRank[c.kind ?? ''] ?? 9) < (kindRank[ex.kind ?? ''] ?? 9)) {
        byKey.set(key, c);
      }
    }
    for (const c of byKey.values()) {
      const v = c.value;
      // 已在库则按 kind rank 替换 (更精简的 form 胜)
      const idx = iscLibrary.findIndex(e => Math.abs(e.value - v) < 1e-12 * Math.max(1, Math.abs(v)));
      if (idx === -1) {
        iscLibrary.push({ value: v, form: c.form });
      } else {
        // 替换条件: 这里就不细比, 先到先得即可 (library 单调累积)
      }
    }
  }
  /** 把 form 取负, 智能避免 -(-N), -(N/M), -(-N/M) 等套娃. */
  function negateForm(f: string): string {
    if (f === '0') return '0';
    // 已是负号开头 → 去掉
    if (f.startsWith('-')) return f.slice(1);
    // 简单 token (整数 / 浮点 / 标识符 / 有理 p/q / sqrt(...) / pi*... 等): 直接前加 "-"
    // 复杂表达式 (含 + 或顶层 -) → 括号包
    const simple = /^[0-9]+(\.[0-9]+)?$/.test(f)              // 整数 / 小数
                || /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(f)          // identifier (pi, e, i)
                || /^[0-9]+\/[0-9]+$/.test(f)                  // p/q
                || /^sqrt\([^()]*\)$/.test(f)                  // sqrt(n)
                || /^[0-9]+\*sqrt\([^()]*\)$/.test(f)          // n*sqrt(m)
                || /^[0-9]+\*pi(\/[0-9]+)?$/.test(f)           // n*pi or n*pi/m
                || /^pi(\/[0-9]+)?$/.test(f)                   // pi or pi/n
                || /^1\/sqrt\([^()]*\)$/.test(f);              // 1/sqrt(n)
    return simple ? `-${f}` : `-(${f})`;
  }
  /** 全局库查询: 浮点 v 是否匹配某登记值 (或其负数). 返回 form 字符串或 null. */
  function lookupIscLibrary(v: number): string | null {
    if (Math.abs(v) < 1e-12) return null;
    // 容差 1e-6 — entry 在 chamber 间常带 ~5e-7 噪声, 同一闭式值的不同 cell 浮点不全等.
    for (const entry of iscLibrary) {
      const tol = 1e-6 * Math.max(1, Math.abs(v), Math.abs(entry.value));
      if (Math.abs(v - entry.value) < tol) return entry.form;
      if (Math.abs(v + entry.value) < tol) return negateForm(entry.form);
    }
    return null;
  }
  /** 浮点 → 值表达式. cell 渲染只读 iscLibrary; local-identify 仅由 ISC 按钮触发时
   *  写库 (用户原话: ISC 必须手动). null = 库未命中, 调用方回退浮点. */
  function identifyValue(v: number): string | null {
    return lookupIscLibrary(v);
  }
  /** 把单浮点 v 通过 local simple-identify 算出的 form 写入 iscLibrary.
   *  仅在 ISC 按钮触发的流程里调用. 返回是否登记了新条目. */
  function tryLocalRegister(v: number): boolean {
    if (Math.abs(v) < 1e-12) return false;
    if (lookupIscLibrary(v) !== null) return false;
    const f = simpleIdentifyValue(v);
    if (f === null) return false;
    iscLibrary.push({ value: v, form: f });
    return true;
  }
/** 给浮点复数 v 找闭式 LaTeX. 入口逻辑:
   *    每个 axis (re, im) 独立走 identifyValue (= 本地 simple → ISC 全局库),
   *    都成功才合并成单复数表达式; 一边失败但浮点 ≈ 0 也算通过 (避免半浮点半符号 ugly).
   *  null = 至少一边没识别, 调用方回退浮点显示.
   *  SSOT: Stokes / Omega / 未来其他矩阵 cell 渲染都用这个入口. */
  function getSymbolicCellExpr(I: number, J: number, v: ComplexNum): { latex: string; tooltip: string } | null {
    const tipSign = v.im >= 0 ? '+' : '−';
    const tooltip = `${v.re.toPrecision(8)} ${tipSign} ${Math.abs(v.im).toPrecision(8)}i`;
    // 1) 精确传播命中: 当前 chamber 有 wall-crossing 算出的整数 M[I][J] 且 v 匹配 (含负号)
    const M = exactByChamber.get(state.selectedChamber);
    if (M && I >= 0 && I < M.length && J >= 0 && J < M.length) {
      const n = M[I][J];
      const mag = Math.max(Math.abs(v.re), Math.abs(v.im), 1, Math.abs(n));
      const tol = mag * 1e-5;
      if (Math.abs(v.im) < tol) {
        if (Math.abs(v.re - n) < tol) return { latex: String(n), tooltip };
        if (Math.abs(v.re + n) < tol) return { latex: String(-n), tooltip };
      }
    }
    // 2) iscLibrary 查询 (数值字典, identifyValue 入口)
    const mag = Math.max(Math.abs(v.re), Math.abs(v.im), 1);
    const zeroTol = mag * 1e-7;
    const reTrivial = Math.abs(v.re) < zeroTol;
    const imTrivial = Math.abs(v.im) < zeroTol;
    const reForm = reTrivial ? '0' : identifyValue(v.re);
    const imForm = imTrivial ? '0' : identifyValue(v.im);
    if (reForm === null || imForm === null) return null;
    const expr = buildLocalComplexExpr(reForm, imForm);
    if (!expr) return null;
    const parsed = parseComplexExpr(expr);
    if (!parsed) return null;
    // 容差 1e-6 跟 simpleIdentifyValue 保持一致 — precomputed dataset entry 噪声 ~5e-7.
    const tolRe = Math.max(1, Math.abs(v.re)) * 1e-6;
    const tolIm = Math.max(1, Math.abs(v.im)) * 1e-6;
    if (Math.abs(parsed.re - v.re) > tolRe || Math.abs(parsed.im - v.im) > tolIm) return null;
    return { latex: exprToLatex(expr), tooltip };
  }
  /** 拿当前 chamber 的 (i, j) entry 的 std view 标量值 (m_i=m_j=1 假设, block 取 [0,0]). */
  function getStdEntryValue(i: number, j: number): ComplexNum | null {
    if (!stokesValuesFresh()) return null;
    const ch = dataset.chambers[state.selectedChamber];
    const e = ch?.entries?.[`${i},${j}`];
    if (!e || e.error) return null;
    const blk = modifiedBlock(e, ch.d, i, j);
    return blk[0]?.[0] ?? null;
  }
  function setupIscLauncher() {
    const host = document.getElementById('sd-isc-launcher');
    if (!host) return;
    host.innerHTML =
      `<select class="isc-scope" id="sd-isc-scope" title="ISC range">` +
        `<option value="matrix" selected>whole matrix</option>` +
        `<option value="entry">selected entry</option>` +
      `</select>` +
      `<button class="isc-btn" id="sd-isc-btn" type="button" title="Identify symbolic form">ISC</button>` +
      `<button class="isc-btn isc-clear" id="sd-isc-clear" type="button" title="Clear ISC cache" hidden>×</button>`;
    const btn = document.getElementById('sd-isc-btn') as HTMLButtonElement;
    const scope = document.getElementById('sd-isc-scope') as HTMLSelectElement;
    const clearBtn = document.getElementById('sd-isc-clear') as HTMLButtonElement;
    btn.addEventListener('click', () => {
      if (iscRunning) return;
      const s = scope.value as 'entry' | 'matrix';
      if (s === 'entry') runIscEntry();
      else runIscMatrix();
    });
    clearBtn.addEventListener('click', () => {
      iscCache.clear();
      iscLibrary.length = 0;
      exactByChamber.clear();
      refreshStokesMatrix();
      renderIscResults();
      refreshIscLauncher();
    });
    // 点 cache 摘要里的 (i,j) 跳到对应 entry
    document.getElementById('isc-results')?.addEventListener('click', (e) => {
      const tgt = (e.target as HTMLElement).closest('.isc-jump') as HTMLButtonElement | null;
      if (!tgt) return;
      const i = Number(tgt.dataset.i), j = Number(tgt.dataset.j);
      if (!Number.isInteger(i) || !Number.isInteger(j)) return;
      state.selectedEntry = [i, j];
      updateStokesPanel();
      updatePathInfo();
    });
    refreshIscLauncher();
  }
  function refreshIscLauncher() {
    const btn = document.getElementById('sd-isc-btn') as HTMLButtonElement | null;
    const clearBtn = document.getElementById('sd-isc-clear') as HTMLButtonElement | null;
    if (!btn) return;
    const fresh = stokesValuesFresh();
    btn.disabled = !fresh || iscRunning;
    btn.textContent = iscRunning ? 'ISC…' : 'ISC';
    if (clearBtn) clearBtn.hidden = iscCache.size === 0;
  }
  async function runIscEntry() {
    const panel = document.getElementById('isc-results')!;
    if (!state.selectedEntry) {
      panel.hidden = false;
      panel.innerHTML = `<div class="isc-hint">Select an entry first (click a Stokes matrix cell).</div>`;
      return;
    }
    const [i, j] = state.selectedEntry;
    if (i === j) {
      panel.hidden = false;
      panel.innerHTML = `<div class="isc-hint">Diagonal entries are trivial (1 or 0).</div>`;
      return;
    }
    const v = getStdEntryValue(i, j);
    if (!v) {
      panel.hidden = false;
      panel.innerHTML = `<div class="isc-hint">No numerical value for (${i+1}, ${j+1}) in current chamber.</div>`;
      return;
    }
    iscRunning = true; refreshIscLauncher();
    panel.hidden = false;
    panel.innerHTML = `<div class="isc-loading">Running ISC for (${i+1}, ${j+1})…</div>`;
    try {
      // Step 1: local simple-identify (整数/有理/√/π) — 秒级, 大多 cell 这一步就完事
      tryLocalRegister(v.re);
      tryLocalRegister(v.im);
      refreshStokesMatrix();
      // Step 2: 仍未命中的 axis 才落 RIES (耗时, 调后端)
      const needRies = (lookupIscLibrary(v.re) === null && Math.abs(v.re) > 1e-12)
                    || (lookupIscLibrary(v.im) === null && Math.abs(v.im) > 1e-12);
      if (needRies) {
        panel.innerHTML = `<div class="isc-loading">Local identify done; calling RIES backend for residual…</div>`;
        const resp = await iscQuery(v.re, v.im, undefined, ['ries']);
        iscCache.set(iscKey(state.selectedChamber, i, j), resp.candidates);
        registerIscLibrary(resp.candidates);
        refreshStokesMatrix();
      }
      renderIscResults();
    } catch (e) {
      panel.innerHTML = `<div class="isc-error">ISC failed: ${escapeHtml((e as Error).message)}</div>`;
    } finally {
      iscRunning = false; refreshIscLauncher();
    }
  }
  async function runIscMatrix() {
    const panel = document.getElementById('isc-results')!;
    if (!stokesValuesFresh()) { panel.hidden = false; panel.innerHTML = `<div class="isc-hint">Compute Stokes matrices first.</div>`; return; }

    // ★ 真传播路径 (CP^n 整数 case): ISC base chamber → 拿整数矩阵 → wall-crossing 推所有 chamber.
    //   不需要对每个 chamber 跑 RIES, 不需要数值字典命中. 精确代数.
    const ps = state.punctureOverrides ?? dataset.punctures;
    const sortedChambers = dataset.chambers
      .map((ch, idx) => ({ d: ch.d, originalIdx: idx, ch }))
      .sort((a, b) => a.d - b.d);
    const baseSorted = sortedChambers[0];
    // 尝试从 base chamber 抽整数矩阵: 每个 entry 必须 (re ≈ integer, im ≈ 0).
    const baseM: IntMatrix = Array.from({ length: n }, () => Array(n).fill(0));
    let baseAllInteger = true;
    const snapTol = 1e-3;  // 容差: medium 精度数据噪声远低于此
    for (let i = 0; i < n && baseAllInteger; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const e = baseSorted.ch.entries[`${i},${j}`];
        if (!e || !e.value_block) { baseAllInteger = false; break; }
        const v = e.value_block[0][0];
        const nRound = Math.round(v.re);
        if (Math.abs(v.re - nRound) > snapTol || Math.abs(v.im) > snapTol) {
          baseAllInteger = false; break;
        }
        baseM[i][j] = nRound;
      }
    }
    if (baseAllInteger) {
      iscRunning = true; refreshIscLauncher();
      panel.hidden = false;
      panel.innerHTML = `<div class="isc-loading">Propagating base chamber ${baseSorted.originalIdx} (d=${baseSorted.d.toFixed(3)}) integer matrix via wall-crossing…</div>`;
      // 短 await 让 DOM 喘一口气, 否则计算太快用户看不到 loading 状态
      await new Promise(r => setTimeout(r, 0));
      const propagated = propagateExactMatrices(baseSorted.originalIdx, baseM, sortedChambers, ps);
      exactByChamber.clear();
      for (const [chIdx, M] of propagated) exactByChamber.set(chIdx, M);
      // 同时把所有 chamber 的整数 entry 登记进 iscLibrary, 让 eg view (以及未来
      // 其他派生视图) 的 cell 也能通过 library 命中.
      // eg 值 = raw v5 anchor (CP^n A_diag=0 时 chamber-independent), 通常等于
      // 某个 chamber 的 std 整数, 所以把全 chamber 整数都入库就能覆盖.
      for (const M of propagated.values()) {
        for (let i = 0; i < M.length; i++) for (let j = 0; j < M.length; j++) {
          if (i === j) continue;
          tryLocalRegister(M[i][j]);
        }
      }
      // 防御性: 直接把 raw v5 eg 值也入库, 万一不在 chamber std 范围内
      if ((dataset as any)._v5_eg_entries) {
        for (const e of Object.values((dataset as any)._v5_eg_entries) as any[]) {
          const v = e?.value_block?.[0]?.[0];
          if (!v) continue;
          tryLocalRegister(v.re);
          tryLocalRegister(v.im);
        }
      }
      refreshStokesMatrix();
      panel.innerHTML = `<div class="isc-hint">Wall-crossing propagation: base chamber ${baseSorted.originalIdx} → ${propagated.size} chambers exact (integer matrix algebra, zero floating-point error). iscLibrary populated with ${iscLibrary.length} distinct values so S_d^eg and derived views also display symbolically.</div>`;
      iscRunning = false; refreshIscLauncher();
      return;
    }

    // 非整数 case: 落回老 path (扫所有 chamber 本地 simple-identify + RIES 兜底).
    // 这条 path 数值字典匹配, 不是真传播, 但对 CP^n 之外 (非整数 entry) 没 wall-crossing 闭式时也能挽救一些.
    panel.innerHTML = `<div class="isc-hint">Base chamber not integer — falling back to per-value local + RIES sweep.</div>`;
    // 扫所有 chamber 所有 off-diag entry; 按数值去重 (chamber 间常出现重复值,
    // 一次 RIES 入库后其他 cell 走 library 命中); 跳过 local-identify 已接住的.
    const todo: Array<{ chamberIdx: number; i: number; j: number; v: ComplexNum }> = [];
    const seen: Array<ComplexNum> = [];
    // 容差 1e-6 — precomputed dataset entry chamber 间常累积 ~5e-7 噪声.
    const numEq = (a: ComplexNum, b: ComplexNum) => {
      const tol = 1e-6 * Math.max(1, Math.abs(a.re), Math.abs(a.im), Math.abs(b.re), Math.abs(b.im));
      return Math.abs(a.re - b.re) < tol && Math.abs(a.im - b.im) < tol;
    };
    // Step 0: 收集所有矩阵的所有 (chamber, view, cell) 浮点 → local simple-identify 入库.
    //
    // SSOT 扩展点 (future-proof): 新加从 S_d 派生的矩阵 (Ω 等) 时,
    // 在 valueProducers 里加一项 () => Iterable<ComplexNum> 即可.
    // - cell 渲染端调 getSymbolicCellExpr 即可消费 library, 不用改 ISC 代码.
    // - identifyValue / library 完全 view/matrix 无关.
    const valueProducers: Array<() => Iterable<ComplexNum>> = [
      // S_d std + 各 chamber. plus/minus 通过 library negation 自动覆盖, 不需独立列.
      function*() {
        for (let chIdx = 0; chIdx < dataset.chambers.length; chIdx++) {
          const ch = dataset.chambers[chIdx];
          if (!ch || !ch.entries) continue;
          for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
            if (i === j) continue;
            const e = ch.entries[`${i},${j}`];
            if (!e || e.error || !e.value_block) continue;
            const v = modifiedBlock(e, ch.d, i, j)[0]?.[0];
            if (v) yield v;
          }
        }
      },
      // S_d^eg: raw v5 anchor + per-pair 2π lift. 每个 chamber 的 d 都要扫一遍 lift.
      function*() {
        if (!dataset._v5_eg_entries) return;
        for (let chIdx = 0; chIdx < dataset.chambers.length; chIdx++) {
          const ch = dataset.chambers[chIdx];
          for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
            if (i === j) continue;
            const eg = egBlock(i, j, ch.d);
            const v = eg?.[0]?.[0];
            if (v) yield v;
          }
        }
      },
      // 未来从 S_d 派生的新矩阵: 在此追加 generator (yield 该矩阵每个 cell 的 ComplexNum).
    ];
    let localHits = 0;
    for (const producer of valueProducers) {
      for (const v of producer()) {
        if (tryLocalRegister(v.re)) localHits++;
        if (tryLocalRegister(v.im)) localHits++;
      }
    }
    refreshStokesMatrix();
    // Step 1: 收集 local 没接住、需要 RIES 的 cell. 按数值去重.
    for (let chIdx = 0; chIdx < dataset.chambers.length; chIdx++) {
      const ch = dataset.chambers[chIdx];
      if (!ch || !ch.entries) continue;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const e = ch.entries[`${i},${j}`];
          if (!e || e.error || !e.value_block) continue;
          const v = modifiedBlock(e, ch.d, i, j)[0]?.[0];
          if (!v) continue;
          if (Math.abs(v.re) < 1e-12 && Math.abs(v.im) < 1e-12) continue;
          // 库命中 → 不需要 RIES
          const reOk = Math.abs(v.re) < 1e-12 || lookupIscLibrary(v.re) !== null;
          const imOk = Math.abs(v.im) < 1e-12 || lookupIscLibrary(v.im) !== null;
          if (reOk && imOk) continue;
          if (seen.some(s => numEq(s, v) || numEq(s, { re: -v.re, im: -v.im }))) continue;
          seen.push(v);
          todo.push({ chamberIdx: chIdx, i, j, v });
        }
      }
    }
    if (todo.length === 0) {
      panel.hidden = false;
      panel.innerHTML = `<div class="isc-hint">Local simple-identify registered ${localHits} value(s). No residual cells need RIES.</div>`;
      renderIscResults();
      return;
    }
    iscRunning = true; refreshIscLauncher();
    panel.hidden = false;
    let done = 0;
    const progress = () => `<div class="isc-loading">Running ISC over all chambers: <span class="dim">${done}/${todo.length} distinct values (dedup'd across ${dataset.chambers.length} chambers)</span></div>`;
    panel.innerHTML = progress();
    try {
      for (const t of todo) {
        const resp = await iscQuery(t.v.re, t.v.im, undefined, ['ries']);
        iscCache.set(iscKey(t.chamberIdx, t.i, t.j), resp.candidates);
        registerIscLibrary(resp.candidates);
        done++;
        panel.innerHTML = progress();
        refreshStokesMatrix();
      }
      renderIscResults();
    } catch (e) {
      panel.innerHTML = `<div class="isc-error">ISC failed at ${done}/${todo.length}: ${escapeHtml((e as Error).message)}</div>`;
    } finally {
      iscRunning = false; refreshIscLauncher();
    }
  }
  function renderIscResults() {
    const panel = document.getElementById('isc-results')!;
    refreshIscLauncher();
    if (!stokesValuesFresh()) { panel.hidden = true; return; }
    // 优先显示当前选中 entry 的候选; 否则列 cache 概要.
    if (state.selectedEntry) {
      const [i, j] = state.selectedEntry;
      const cands = iscCache.get(iscKey(state.selectedChamber, i, j));
      if (!cands || cands.length === 0) {
        if (iscCache.size === 0) { panel.hidden = true; return; }
        panel.hidden = false;
        panel.innerHTML = `<div class="isc-hint">No ISC candidates cached for (${i+1}, ${j+1}). Click <strong>ISC</strong> above.</div>` + renderIscCacheSummary();
        return;
      }
      panel.hidden = false;
      panel.innerHTML = `<div class="isc-entry-head">ISC candidates for ` +
        `<span class="isc-cell">(${i+1}, ${j+1})</span> <span class="dim">chamber ${state.selectedChamber+1}</span></div>` +
        renderIscCandidates(cands) +
        renderIscCacheSummary();
      return;
    }
    if (iscCache.size === 0) { panel.hidden = true; return; }
    panel.hidden = false;
    panel.innerHTML = `<div class="isc-hint">Select a Stokes matrix entry to see its ISC candidates.</div>` + renderIscCacheSummary();
  }
  function renderIscCandidates(cands: IscCandidate[]): string {
    // 按 axis 分组
    const groups = new Map<string, IscCandidate[]>();
    for (const c of cands) {
      const g = groups.get(c.axis) ?? [];
      g.push(c);
      groups.set(c.axis, g);
    }
    let html = '<div class="isc-groups">';
    for (const [axis, list] of groups) {
      const valStr = list[0]?.value.toPrecision(8);
      html += `<div class="isc-group">`;
      html += `<div class="isc-axis"><span class="isc-axis-name">${escapeHtml(axis)}</span> <span class="dim mono">= ${valStr}</span></div>`;
      html += '<ul class="isc-list">';
      for (const c of list) {
        const errStr = c.err_abs === null || c.err_abs === undefined
          ? ''
          : c.err_abs === 0 ? '<span class="isc-err exact">exact</span>'
          : `<span class="isc-err mono">±${c.err_abs.toExponential(1)}</span>`;
        html += `<li><span class="isc-engine isc-eng-${c.engine}">${c.engine}</span> ` +
                `<span class="isc-form mono">${escapeHtml(c.form)}</span> ${errStr}</li>`;
      }
      html += '</ul></div>';
    }
    html += '</div>';
    return html;
  }
  function renderIscCacheSummary(): string {
    if (iscCache.size === 0) return '';
    // 列出当前 chamber 已 cache 的 entries
    const here: Array<[number, number]> = [];
    for (const key of iscCache.keys()) {
      const parts = key.split('_').map(Number);
      if (parts[0] === state.selectedChamber) here.push([parts[1], parts[2]]);
    }
    if (here.length === 0) return '';
    const labels = here.sort(([a,b],[c,d]) => a-c || b-d)
      .map(([i,j]) => `<button class="isc-jump mono" data-i="${i}" data-j="${j}">(${i+1},${j+1})</button>`).join(' ');
    return `<div class="isc-cache-summary">cached this chamber: ${labels}</div>`;
  }

  function updateStokesPanel() {
    const el = document.getElementById('stokes-display')!;
    if (!state.selectedEntry) {
      el.innerHTML = '<span class="label">no entry selected</span>';
      return;
    }
    const [i, j] = state.selectedEntry;
    const ch = dataset.chambers[state.selectedChamber];
    const e = ch.entries[`${i},${j}`];
    if (!e) { el.innerHTML = '<span class="label">no data</span>'; return; }
    const symMap = { std: 'S_d', plus: 'S_d^{+}', minus: 'S_d^{-}', eg: 'S_d^{\\mathrm{eg}}' } as const;
    const labelTex = `(${symMap[state.sdView]})_{${i+1}${j+1}}`;
    if (!stokesValuesFresh()) {
      el.innerHTML = `<div class="label">${tex(labelTex)}</div>`
        + '<div class="value dim">stale: recompute Stokes matrices</div>';
      return;
    }
    if (e.error) {
      el.innerHTML = `<div class="label">${tex(labelTex)}</div>
        <div class="value" style="color: var(--bad)">FAIL: ${e.error}</div>`;
      return;
    }
    // 块版: 列出整个 m_i × m_j sub-block. std/plus/minus 用 modifiedBlock; eg 用 egBlock.
    let mod: ComplexNum[][];
    if (state.sdView === 'eg' && i !== j) {
      const eg = egBlock(i, j);
      if (!eg) {
        el.innerHTML = `<div class="label">${tex(labelTex)}</div>`
          + '<div class="value dim">straight-entry data unavailable</div>';
        return;
      }
      mod = eg;
    } else {
      mod = modifiedBlock(e, ch.d, i, j);
    }
    // plus/minus 模式按 -d label 决定是否保留. selected entry 永远 off-diag (UI 不让点对角),
    // 但保险起见 i===j 时空 block.
    if ((state.sdView === 'plus' || state.sdView === 'minus') && i !== j) {
      const lab = dLabels();
      const keep = state.sdView === 'plus' ? lab[i] < lab[j] : lab[i] > lab[j];
      const negate = state.sdView === 'minus';
      if (!keep) {
        mod = mod.map(row => row.map(() => ({ re: 0, im: 0 })));
      } else if (negate) {
        mod = mod.map(row => row.map(v => ({ re: -v.re, im: -v.im })));
      }
    }
    const m_i = mod.length, m_j = mod[0]?.length ?? 1;
    const digits = selectedPrecisionDigits();
    let inner = '';
    if (m_i === 1 && m_j === 1) {
      inner = renderComplex(mod[0][0], digits);
    } else {
      inner = '<div class="block-grid" style="display:grid;'
        + `grid-template-columns:repeat(${m_j}, 1fr);gap:6px">`;
      for (let a = 0; a < m_i; a++) {
        for (let b = 0; b < m_j; b++) {
          inner += `<div class="block-sub-cell">${renderComplex(mod[a][b], digits)}</div>`;
        }
      }
      inner += '</div>';
    }
    el.innerHTML = `<div class="label">${tex(labelTex)}</div>`
      + `<div class="value">${inner}</div>`;
    renderIscResults();
  }

  function updatePathInfo() {
    const el = document.getElementById('path-info')!;
    if (!state.selectedEntry) { el.textContent = '—'; return; }
    if (!stokesValuesFresh()) { el.textContent = '—'; return; }
    const [i, j] = state.selectedEntry;
    const ch = dataset.chambers[state.selectedChamber];
    const e = ch.entries[`${i},${j}`];
    if (!e) { el.textContent = '—'; return; }
    if (state.sdView === 'plus' || state.sdView === 'minus') {
      el.innerHTML = e.provenance
        ? `<span class="provenance-info" data-provenance="${escapeHtml(e.provenance)}" hidden>${escapeHtml(e.provenance)}</span>`
        : '—';
      return;
    }
    const shownPath = Array.from(state.paths.values())[0];
    if (shownPath) {
      el.innerHTML =
        `<div>vertices: ${shownPath.vertices.length}</div>` +
        (e.provenance ? `<span class="provenance-info" data-provenance="${escapeHtml(e.provenance)}" hidden>${escapeHtml(e.provenance)}</span>` : '');
      return;
    }
    if (!e.path) {
      // v5 entry: no explicit PL representative; show a friendly note + keep
      // raw provenance under .provenance-info for e2e / debugging.
      el.innerHTML =
        '<span class="label">computed via wall-crossing from the reference chamber</span>' +
        (e.provenance ? `<span class="provenance-info" data-provenance="${escapeHtml(e.provenance)}" hidden>${escapeHtml(e.provenance)}</span>` : '');
      return;
    }
    const tau = e.tau_code?.toFixed(4) ?? '—';
    const lift = e.theta_t_lift?.toFixed(4) ?? '—';
    el.innerHTML =
      `<div>vertices: ${e.path.length}</div>` +
      `<div>${tex(`\\tau_{\\mathrm{code}} = ${tau}`)}</div>` +
      `<div>${tex(`\\theta_t\\ \\mathrm{lift} = ${lift}`)}</div>`;
  }

  // 入口处渲染所有 data-tex 标签
  renderAllTex(document);

  /** 三栏 layout: 拖动 left/right handle 改 CSS 变量 --left-w / --right-w. */
  function setupResizeHandles() {
    const root = document.documentElement;
    const handles = document.querySelectorAll<HTMLDivElement>('.resize-handle');
    handles.forEach(h => {
      const side = h.dataset.side as 'left' | 'right';
      const varName = side === 'left' ? '--left-w' : '--right-w';
      let startX = 0, startW = 0, active = false;
      h.addEventListener('pointerdown', (e) => {
        active = true;
        h.classList.add('dragging');
        h.setPointerCapture(e.pointerId);
        startX = e.clientX;
        const cur = getComputedStyle(root).getPropertyValue(varName).trim();
        startW = parseFloat(cur) || (side === 'left' ? 380 : 420);
        e.preventDefault();
      });
      h.addEventListener('pointermove', (e) => {
        if (!active) return;
        const dx = e.clientX - startX;
        const delta = side === 'left' ? dx : -dx;
        const newW = Math.max(200, Math.min(900, startW + delta));
        root.style.setProperty(varName, `${newW}px`);
      });
      const finish = (e: PointerEvent) => {
        if (!active) return;
        active = false;
        h.classList.remove('dragging');
        try { h.releasePointerCapture(e.pointerId); } catch {}
      };
      h.addEventListener('pointerup', finish);
      h.addEventListener('pointercancel', finish);
    });
  }
}

main().catch(err => {
  console.error(err);
  document.getElementById('app')!.innerHTML =
    `<div style="padding: 40px; color: #ff5555">Failed to load: ${err.message}<br/><br/>
     <span style="color: #9099a6">先跑 <code>sage 60-outputs/sd-viz/data/export_n4_simple.sage</code> 生成 n4_simple.json</span></div>`;
});
