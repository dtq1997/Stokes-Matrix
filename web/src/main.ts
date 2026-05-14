import katex from 'katex';
import { loadDataset, recomputeAsync, cancelJob, backendOnline, getBackendBase, setBackendBase, DATASET_REGISTRY, getDatasetKey } from './lib/data.js';
import type { JobStatus } from './lib/data.js';
import type { VizState, ComplexNum, PathRep, SdEntryData } from './lib/types.js';
import { Canvas } from './components/canvas.js';
import { chamberOfDirection, monodromyTransforms } from './lib/geometry.js';
import { mmul } from './lib/matexp.js';
import { parsePiInput, parseRational, formatPi } from './lib/pi-input.js';

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
      A[sI + a][sJ + b] = { re: e.re, im: e.im };
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
  };

  const onStateChange = (_s: VizState) => {
    // canvas 触发 (拖 puncture / path vertex) 后, 标 Stokes 数值 stale.
    // path-vertex drag 不改 punctureOverrides 但 path 几何变了 — 数值还是旧 dataset 的
    // 值 (因为算法走的 algo_wp 没变, 同伦类 cache 命中). 这里宁可标 stale 用户决定.
    state.stokesStale = !!state.punctureOverrides || !!state.AOverrides;
    if (state.stokesStale) state.exampleAwaitingCompute = false;
    refreshRecomputeBtn();
    updateStaleBanner();
    updateStokesPanel();
    updatePathInfo();
  };

  const svg = document.getElementById('canvas') as unknown as SVGSVGElement;
  const canvas = new Canvas(svg, state, onStateChange);

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
    const newCh = chamberOfDirection(d, dataset.rays);
    state.selectedChamber = newCh;
    refreshAllPaths();
    canvas.setState(state);
    refreshStokesMatrix();
    updateDHeading();
    updateStokesPanel();
    updatePathInfo();
  }

  slider.addEventListener('input', () => setD(Number(slider.value), 'slider'));

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
    setD(v * Math.PI, 'input');
  }

  function buildMarkerStrip(el: HTMLDivElement) {
    el.innerHTML = '';
    // 当前 window: [(2k-1)π, (2k+1)π). rays 数据是 mod 2π 在 [0, 2π) 内.
    // 把每个 ray lift 到 window: lifted = r + 2πm for some m, 使得 lifted ∈ window.
    const lo = (2 * currentK - 1) * Math.PI;
    const hi = (2 * currentK + 1) * Math.PI;
    const span = hi - lo;
    for (const r of dataset.rays) {
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
    if (newN !== n) resizeN(newN);
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
  updateDimInfo();
  setupResizeHandles();
  const precisionSelect = document.getElementById('precision-select') as HTMLSelectElement;
  precisionSelect.addEventListener('change', () => {
    refreshStokesMatrix();
    updateStokesPanel();
  });
  // Compute 按钮: 始终可点 (用户反馈 "锁就是不对, 按一下就该算一遍").
  // stokesStale 仅用于驱动 stale-banner 文案; 不再控制按钮 disabled.
  // computing 期间按钮变成 Cancel (click handler 内分支), 仍然 enabled.
  const recomputeBtn = document.getElementById('state-recompute') as HTMLButtonElement;
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

          // 四个 phase 的人类语言 + 完成态
          // phase 顺序: starting sage → base-case → wall-crossing → chamber-pack → done
          type StageKey = 'sage' | 'base' | 'wall' | 'pack';
          const stageOf: Record<string, StageKey> = {
            'starting sage': 'sage',
            'base-case': 'base',
            'wall-crossing': 'wall',
            'chamber-pack': 'pack',
          };
          const stageOrder: StageKey[] = ['sage', 'base', 'wall', 'pack'];
          // 用户是数学家但不一定熟悉这套实现细节. UI 字串只用数学概念,
          // 不出现 sage / PL push / tq Richardson / chamber-pack 等实现 jargon.
          const stageLabel: Record<StageKey, string> = {
            sage: 'Preparing',
            base: 'Computing reference chamber',
            wall: 'Propagating across walls',
            pack: 'Finalizing',
          };
          const stageHint: Record<StageKey, string> = {
            sage: 'loading the computation engine',
            base: 'computing the initial entries (i, j) at the reference direction d_reg',
            wall: 'transporting the Stokes matrix from one chamber to the next by algebraic wall-crossing',
            pack: 'assembling the Stokes data across all chambers',
          };
          const curStage: StageKey = stageOf[phase] ?? 'sage';
          const curIdx = stageOrder.indexOf(curStage);

          // 主行: 阶段名 + 当前焦点 (数学家友好, 不带技术 jargon)
          let focus = '';
          if (curStage === 'base' && doneStr) {
            focus = pairStr ? ` entry (i, j) = ${pairStr} · ${doneStr}` : ` · ${doneStr}`;
          } else if (curStage === 'wall' && doneStr) {
            focus = chamberStr ? ` chamber ${chamberStr} · ${doneStr}` : ` · ${doneStr}`;
          } else if (curStage === 'pack' && s.chambers_total > 0) {
            focus = ` · ${s.chambers_done} / ${s.chambers_total} chambers`;
          }

          // ETA: 用 progress / elapsed 估
          const eta = (s.progress > 0.05 && s.elapsed_s > 1)
            ? Math.max(0, s.elapsed_s / s.progress - s.elapsed_s)
            : null;

          const pct = Math.max(2, Math.round(s.progress * 100));

          // 4 阶段勾标
          const checks = stageOrder.map((k, idx) => {
            let icon = '○';
            let cls = 'dim';
            if (idx < curIdx) { icon = '✓'; cls = 'good'; }
            else if (idx === curIdx) { icon = '●'; cls = 'active'; }
            return `<span style="color:var(--${cls === 'good' ? 'good' : cls === 'active' ? 'fg' : 'fg-muted'},#888);margin-right:8px">${icon} ${escapeHtml(stageLabel[k])}</span>`;
          }).join('');

          const etaHtml = eta !== null ? `  · ETA ~${eta.toFixed(0)}s` : '';
          recomputeStatus.innerHTML =
            `<div style="font-size:12px;margin-bottom:4px"><strong>${escapeHtml(stageLabel[curStage])}</strong>${escapeHtml(focus)} <span class="dim">${s.elapsed_s.toFixed(1)}s${etaHtml}</span></div>` +
            `<div class="progress-bar" style="margin-bottom:4px"><div style="width:${pct}%"></div></div>` +
            `<div style="font-size:10px;line-height:1.4">${checks}</div>` +
            `<div class="dim" style="font-size:10px;margin-top:2px">${escapeHtml(stageHint[curStage])}</div>`;
        },
        (jobId) => { currentJobId = jobId; },
      );
      // 替换 dataset 内容
      Object.keys(dataset).forEach(k => delete (dataset as any)[k]);
      Object.assign(dataset, newDs);
      buildMarkerStrip(markStrip);
      state.selectedChamber = chamberOfDirection(currentD, dataset.rays);
      state.stokesStale = false;
      state.exampleAwaitingCompute = false;
      refreshAllPaths();
      canvas.setState(state);
      refreshStokesMatrix();
      updateDHeading();
      updateStokesPanel();
      updatePathInfo();
      updateStaleBanner();
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
    let html = `<thead><tr><th>${tex('k')}</th><th>${tex('u_k')}</th>` +
      `<th>${tex('m_k')}</th></tr></thead><tbody>`;
    for (let k = 0; k < n; k++) {
      html += `<tr><td class="row-label">${tex(`${k+1}`)}</td>` +
        `<td>${complexInputHtml(`data-k="${k}"`)}</td>` +
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
    document.querySelectorAll<HTMLInputElement>('#u-table input.cx').forEach(input => {
      const k = Number(input.dataset.k!);
      if (input.classList.contains('mk-input')) {
        input.value = String(ms[k]);
      } else {
        const axis = input.dataset.axis as 're' | 'im';
        input.value = fmtInputNum(ps[k][axis], axis);
      }
    });
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
      // 触发 block 重建: m_k 变意味着 A 维度 N=sum(m) 变, 必须重建 A.
      const newM = [...state.mOverrides!];
      newM[k] = m;
      const newU = state.punctureOverrides!.map(p => ({ ...p }));
      applyBlockResize(newU, newM);
      return;
    }
    const parsed = parseRational(t.value);
    if (parsed === null) { t.classList.add('invalid'); return; }
    t.classList.remove('invalid');
    const axis = t.dataset.axis as 're' | 'im';
    state.punctureOverrides![k][axis] = parsed;
    state.stokesStale = true;
    state.exampleAwaitingCompute = false;
    updateStaleBanner();
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
    if (!t.classList.contains('mk-input')) return;
    updateDimInfo(readMInputPreview() ?? state.mOverrides!);
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
        html += `<td class="${cls}">` +
          complexInputHtml(`data-i="${fi}" data-j="${fj}"`) +
          `</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody>';
    t.innerHTML = html;
    refreshATable();
    t.onchange = onAEdit;
  }
  function refreshATable() {
    const A = state.AOverrides!;
    document.querySelectorAll<HTMLInputElement>('#a-table input.cx').forEach(input => {
      const i = Number(input.dataset.i!);
      const j = Number(input.dataset.j!);
      const axis = input.dataset.axis as 're' | 'im';
      input.value = fmtInputNum(A[i][j][axis], axis);
    });
  }
  function onAEdit(e: Event) {
    const t = e.target as HTMLInputElement;
    if (!t.classList.contains('cx')) return;
    const parsed = parseRational(t.value);
    if (parsed === null) { t.classList.add('invalid'); return; }
    t.classList.remove('invalid');
    const i = Number(t.dataset.i!);
    const j = Number(t.dataset.j!);
    const axis = t.dataset.axis as 're' | 'im';
    state.AOverrides![i][j][axis] = parsed;
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
    const el = document.getElementById('sd-view-selector');
    if (!el) return;
    const opts: Array<{ key: import('./lib/types.js').SdView; tex: string; title: string }> = [
      { key: 'std',   tex: 'S_d',                  title: 'standard Stokes matrix' },
      { key: 'plus',  tex: 'S_d^{+}',              title: 'upper part w.r.t. -d labels (diag = I)' },
      { key: 'minus', tex: 'S_d^{-}',              title: 'lower part w.r.t. -d labels, negated (diag = I)' },
      { key: 'eg',    tex: 'S_d^{\\mathrm{eg}}',   title: 'per-pair branch S_[τ_ij^closest], θ_ij = -arg(u_j - u_i)' },
    ];
    el.innerHTML = opts.map(o =>
      `<button type="button" class="sd-view-btn" data-view="${o.key}" title="${o.title}">` +
        `<span data-tex="${o.tex}"></span></button>`
    ).join('');
    el.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLElement>('.sd-view-btn');
      if (!btn) return;
      const v = btn.dataset.view as import('./lib/types.js').SdView | undefined;
      if (!v || v === state.sdView) return;
      state.sdView = v;
      refreshSdViewSelector();
      refreshAllPaths();
      canvas.setState(state);
      refreshStokesMatrix();
      updateStokesPanel();
      updatePathInfo();
    });
    refreshSdViewSelector();
  }
  function refreshSdViewSelector() {
    document.querySelectorAll<HTMLElement>('#sd-view-selector .sd-view-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.view === state.sdView);
    });
  }

  /** Stokes 矩阵网格: N×N flat grid, 按块结构加视觉分隔.
   * std 模式: 对角块 (I, I) 显示 0 (S_d 默认 - I 视觉约定), 非对角显示 S_d entry.
   * plus 模式: 对角块 = I_block (a=b → 1, a≠b → 0); 非对角 (I, J) label[I]<label[J] → S_d, 否则 0.
   * minus 模式: 对角块 = 0; 非对角 (I, J) label[I]>label[J] → -S_d, 否则 0.
   * 点击任意 sub-cell 选 block (I, J).
   */
  function buildStokesMatrix() {
    const sm = document.getElementById('stokes-matrix')!;
    const ms = state.mOverrides ?? dataset.m_sizes;
    const N = totalMultiplicity(ms);
    const starts = blockStarts(ms);
    const blockOf = (fi: number) => {
      for (let k = ms.length - 1; k >= 0; k--) if (fi >= starts[k]) return [k, fi - starts[k]];
      return [-1, -1];
    };
    // grid 多 1 列 (左侧行 label) + 多 1 行 (顶部列 label). 第一列 sticky 让水平滚时冻结.
    sm.style.gridTemplateColumns = `auto repeat(${N}, 1fr)`;
    sm.innerHTML = '';
    // 第一行: corner + N 个列 label
    const corner = document.createElement('div');
    corner.className = 'sm-corner';
    sm.appendChild(corner);
    for (let fj = 0; fj < N; fj++) {
      const [J, b] = blockOf(fj);
      const th = document.createElement('div');
      th.className = 'sm-header sm-col-header';
      if (fj > 0 && b === 0) th.classList.add('block-left');
      th.innerHTML = tex(flatIndexLabel(ms, J, b));
      sm.appendChild(th);
    }
    // 数据 N 行: 行 label + N 个 data cell
    for (let fi = 0; fi < N; fi++) {
      const [I, a] = blockOf(fi);
      const rowH = document.createElement('div');
      rowH.className = 'sm-header sm-row-header';
      if (fi > 0 && a === 0) rowH.classList.add('block-top');
      rowH.innerHTML = tex(flatIndexLabel(ms, I, a));
      sm.appendChild(rowH);
      for (let fj = 0; fj < N; fj++) {
        const [J, b] = blockOf(fj);
        const cell = document.createElement('div');
        cell.className = 'sm-cell' + (I === J ? ' diag' : '');
        if (fi > 0 && a === 0) cell.classList.add('block-top');
        if (fj > 0 && b === 0) cell.classList.add('block-left');
        cell.dataset.i = String(I);
        cell.dataset.j = String(J);
        cell.dataset.a = String(a);
        cell.dataset.b = String(b);
        if (I !== J) cell.addEventListener('click', () => selectEntry(I, J));
        sm.appendChild(cell);
      }
    }
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
   *  shifted to the closest 2π lift of -arg(u_J-u_I) near currentD. */
  function egBlock(I: number, J: number): ComplexNum[][] | null {
    const rawEntry = dataset._v5_eg_entries?.[`${I},${J}`];
    if (!rawEntry?.value_block || typeof rawEntry.tau_lift !== 'number') return null;
    const raw = rawEntry.value_block;

    /* tau_closest = θ_IJ + 2π·round((currentD - θ_IJ)/2π).
     * The baseline tau_lift is exported by sage from the raw v5 anchor, not
     * inferred from any S_d chamber value. */
    const ps = state.punctureOverrides ?? dataset.punctures;
    const dx = ps[J].re - ps[I].re, dy = ps[J].im - ps[I].im;
    let theta = -Math.atan2(dy, dx);
    while (theta >= Math.PI) theta -= 2 * Math.PI;
    while (theta < -Math.PI) theta += 2 * Math.PI;
    const tp = 2 * Math.PI;
    const m_d = Math.round((currentD - theta) / tp);
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
    const sm = document.getElementById('stokes-matrix')!;
    const ch = dataset.chambers[state.selectedChamber];
    const digits = selectedPrecisionDigits();
    const valuesFresh = stokesValuesFresh();
    const view = state.sdView;
    // 预算所有 (I, J) modified block (paper monodromy 块版修正一次, sub-cell 共享).
    // eg 模式: raw straight-entry anchor + per-pair Δm sandwich (egBlock).
    const blockCache = new Map<string, ComplexNum[][]>();
    if (valuesFresh) {
      const n_ch = state.mOverrides ? state.mOverrides.length : dataset.m_sizes.length;
      for (let I = 0; I < n_ch; I++) for (let J = 0; J < n_ch; J++) {
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
    // 跨 cell 小数点对齐 + 跨 view 同尺寸: 列宽按 std S_d (当前 chamber) 算上界,
    // 再跟当前 view 的实际值取 max — 这样 std/plus/minus/eg 默认同宽,
    // 只在 eg 数值变大 (远 d 强制 lift) 时才扩, 不会缩.
    let maxInt = 1, maxFrac = 0;
    const accumulate = (mod: ComplexNum[][]) => {
      for (const row of mod) for (const v of row) {
        for (const x of [v.re, v.im]) {
          if (x === 0 || !Number.isFinite(x)) continue;
          const mag = Math.floor(Math.log10(Math.abs(x)));
          maxInt = Math.max(maxInt, Math.max(1, mag + 1));
          maxFrac = Math.max(maxFrac, Math.max(0, digits - mag - 1));
        }
      }
    };
    if (valuesFresh) {
      for (const key of Object.keys(ch.entries)) {
        const [I, J] = key.split(',').map(Number);
        if (I === J) continue;
        const e = ch.entries[key];
        if (!e || e.error || !e.value_block) continue;
        accumulate(modifiedBlock(e, ch.d, I, J));
      }
      // 再扫当前 view 的 blockCache (eg 模式下可能含更宽数值)
      for (const mod of blockCache.values()) accumulate(mod);
    }
    sm.style.setProperty('--cs-int-w', `${maxInt}ch`);
    sm.style.setProperty('--cs-frac-w', `${maxFrac > 0 ? maxFrac + 1 : 0}ch`);
    // 只迭代真正的 data cells (跳过 .sm-header / .sm-corner)
    const labels = (view === 'plus' || view === 'minus') ? dLabels() : null;
    const cells = sm.querySelectorAll<HTMLElement>('.sm-cell');
    for (const cell of Array.from(cells)) {
      const I = Number(cell.dataset.i!);
      const J = Number(cell.dataset.j!);
      const a = Number(cell.dataset.a!);
      const b = Number(cell.dataset.b!);
      if (I === J) {
        // 对角块: plus/minus = I_block (a==b → 1, 否则 0); std/eg = 0.
        // 约定: displayed S_d diag=0, displayed S_d^± diag=I 保 0 = 1−1 自洽.
        // S_d^eg diag = 0 (用户指定: per-pair 直线段公式仅对 i≠j 定义).
        if ((view === 'plus' || view === 'minus') && a === b) {
          cell.innerHTML = `<span class="cs-zero">${tex('1')}</span>`;
        } else {
          cell.innerHTML = `<span class="cs-zero">${tex('0')}</span>`;
        }
        continue;
      }
      if (!valuesFresh) {
        cell.innerHTML = '<span class="cs-zero" title="stale: recompute Stokes matrices">—</span>';
        continue;
      }
      const e = ch.entries[`${I},${J}`];
      const sel = !!(state.selectedEntry &&
        state.selectedEntry[0] === I && state.selectedEntry[1] === J);
      cell.classList.toggle('selected', sel);
      if (!e || e.error) {
        cell.innerHTML = `<span style="color: var(--bad)">!</span>`;
        continue;
      }
      // Entry 分类: std/eg 全展示, plus/minus 按 label 排序保/置 0.
      let sign: 1 | -1 | 0 = 1;
      if (view === 'plus')  sign = labels![I] < labels![J] ? 1 : 0;
      if (view === 'minus') sign = labels![I] > labels![J] ? -1 : 0;
      if (sign === 0) {
        cell.innerHTML = `<span class="cs-zero">${tex('0')}</span>`;
      } else {
        const mod = blockCache.get(`${I},${J}`);
        if (!mod && view === 'eg') {
          cell.innerHTML = '<span class="cs-zero" title="straight-entry data unavailable">—</span>';
          continue;
        }
        const v = mod?.[a]?.[b] ?? { re: 0, im: 0 };
        const w = sign === 1 ? v : { re: -v.re, im: -v.im };
        cell.innerHTML = renderComplex(w, digits);
      }
    }
  }

  function selectEntry(i: number, j: number) {
    state.selectedEntry = [i, j];
    document.querySelectorAll('#entry-grid .cell').forEach((el, idx) => {
      const ii = Math.floor(idx / n), jj = idx % n;
      el.classList.toggle('selected', ii === i && jj === j);
    });
    refreshAllPaths();
    canvas.setState(state);
    refreshStokesMatrix();
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

  /** Sample cubic Bezier 密集采样 + 测每段是否撞 cut. n=64 足够，d 变时重算便宜. */
  function bezierHitsAnyCut(a: CutCoord, c1: CutCoord, c2: CutCoord, b: CutCoord, cuts: CutCoord[], padX = 0): boolean {
    const n = 64;
    let prev = a;
    for (let k = 1; k <= n; k++) {
      const t = k / n, u = 1 - t, uu = u * u, tt = t * t;
      const cur = {
        x: uu * u * a.x + 3 * uu * t * c1.x + 3 * u * tt * c2.x + tt * t * b.x,
        y: uu * u * a.y + 3 * uu * t * c1.y + 3 * u * tt * c2.y + tt * t * b.y,
      };
      for (const cut of cuts) {
        if (segmentHitsCut(prev, cur, cut, padX)) return true;
      }
      prev = cur;
    }
    return false;
  }

  /** Upper-hull of 2D points. y 朝上时, upper hull 沿"右拐"走 (cross < 0).
   *  即 cross >= 0 时把中间点 pop 掉 (Andrew monotone chain 标准实现). */
  function upperHull(pts: CutCoord[]): CutCoord[] {
    const sorted = [...pts].sort((p, q) => p.x - q.x || p.y - q.y);
    const hull: CutCoord[] = [];
    const cross = (o: CutCoord, a: CutCoord, b: CutCoord) =>
      (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    for (const p of sorted) {
      while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) >= 0) {
        hull.pop();
      }
      hull.push(p);
    }
    return hull;
  }

  /** Catmull-Rom (alpha=0.5, centripetal) → cubic Bezier 段. 用于把多顶点折线
   *  转成平滑曲线. 端点重复一次 ("clamped" 边界). 返 SVG path "d" 字符串里
   *  M / C 命令的顶点数组 (a, c1, c2, b)*N-1. */
  function catmullRomToBeziers(pts: CutCoord[]): Array<[CutCoord, CutCoord, CutCoord, CutCoord]> {
    if (pts.length < 2) return [];
    const out: Array<[CutCoord, CutCoord, CutCoord, CutCoord]> = [];
    const get = (k: number) => pts[Math.max(0, Math.min(pts.length - 1, k))];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
      const tension = 1 / 6;  // 标准 Catmull-Rom uniform → Bezier 系数
      const c1 = {
        x: p1.x + (p2.x - p0.x) * tension,
        y: p1.y + (p2.y - p0.y) * tension,
      };
      const c2 = {
        x: p2.x - (p3.x - p1.x) * tension,
        y: p2.y - (p3.y - p1.y) * tension,
      };
      out.push([p1, c1, c2, p2]);
    }
    return out;
  }

  /** S_d view 自然路径 (凸包绕障版):
   *  1. 把 cuts 中 "挡道" 的 (cut.x 介于 a.x, b.x 之间) 提取出来.
   *  2. 用 a, b, 挡道 cut 起点 (略上抬 padY) 取上凸包.
   *  3. Catmull-Rom 平滑.
   *
   *  Rationale: 上凸包 = a → b 之间在 cuts (向上无穷射线) 的"屋顶上方"绕过去的最短折线.
   *  在 cut-coord 下 cuts 都竖直向 +y, 上凸包绕过它们的起点天然不撞 cut.
   *  小幅 padY 上抬让 Bezier 平滑曲线也安全地高于 cut 起点.
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
    const padY = Math.max(0.10, 0.10 * chord);

    if (cuts.length === 0) {
      return { vertices: [{ ...start }, { ...end }], kind: 'line' };
    }
    // 路径决策用严格 topology (padX=0): 只有真的跨过 cut 才 detour. padX 视觉余量
    // 不参与决策, 否则线段端点附近的 cut 会被误判为 blocker, 把端点挤出凸包,
    // 触发 line 1216 的 fallback 给出错误直线 (二 cut 挨得近时尤其常见).
    if (!cuts.some(cut => segmentHitsCut(a, b, cut, 0))) {
      return { vertices: [{ ...start }, { ...end }], kind: 'line' };
    }

    // 挡道 cuts: cut.x 严格在 (min(a.x,b.x), max(a.x,b.x)) 之内, 且
    // cut.y ≤ max(a.y, b.y) + padY (cut 起点没远在 a/b 上方, 否则不影响 a→b 通道).
    const xLo = Math.min(a.x, b.x);
    const xHi = Math.max(a.x, b.x);
    const yCap = Math.max(a.y, b.y) + padY;
    const blockers = cuts.filter(c => c.x > xLo && c.x < xHi && c.y < yCap);

    if (blockers.length === 0) {
      return { vertices: [{ ...start }, { ...end }], kind: 'line' };
    }

    // 凸包顶点: a, b, blockers 起点上抬 padY (让 Bezier 不贴 cut 起点).
    const hullInput: CutCoord[] = [
      a, b,
      ...blockers.map(c => ({ x: c.x, y: c.y - padY })),  // 注: cut 朝 +y, blocker 上方是 y < cut.y
    ];
    // 注释订正: cuts 沿 +y 向上, 我们要绕 "底" (y 小那一侧), 取 *下* 凸包 (y 小那条外壳).
    // 但实现里 upperHull 取的是 y 大的外壳, 所以 a, b 和 blockers 都先 y 取反, hull 后再取回.
    const flipped = hullInput.map(p => ({ x: p.x, y: -p.y }));
    const hullFlipped = upperHull(flipped);
    const hull = hullFlipped.map(p => ({ x: p.x, y: -p.y }));
    // hull 是按 x 升序的折线. 取 a, b 之间的那段; 若 a.x > b.x 反向取.
    const ai = hull.findIndex(p => Math.hypot(p.x - a.x, p.y - a.y) < 1e-9);
    const bi = hull.findIndex(p => Math.hypot(p.x - b.x, p.y - b.y) < 1e-9);
    let polyline: CutCoord[];
    if (ai < 0 || bi < 0) {
      // a 或 b 没在 hull 上 (理论上不该, 但保险): 用 a-b 直线
      polyline = [a, b];
    } else if (ai <= bi) {
      polyline = hull.slice(ai, bi + 1);
    } else {
      polyline = hull.slice(bi, ai + 1).reverse();
    }

    // 退化 (a-b 直接相邻 in hull = 没绕)
    if (polyline.length === 2) {
      return { vertices: [{ ...start }, { ...end }], kind: 'line' };
    }

    // Catmull-Rom 平滑. 输出: 多段 cubic Bezier 拼起来.
    const beziers = catmullRomToBeziers(polyline);
    // path 序列: M a, C c1 c2 p2, C c1 c2 p3, ... — vertices 顺序: [a, c1_1, c2_1, p2, c1_2, c2_2, p3, ...]
    // canvas 端用 homotopyId 含 'std-natural-spline' 来识别多段 Bezier 路径.
    const vertices: ComplexNum[] = [];
    vertices.push(fromCutCoord(polyline[0], d));
    for (const [, c1, c2, b2] of beziers) {
      vertices.push(fromCutCoord(c1, d), fromCutCoord(c2, d), fromCutCoord(b2, d));
    }
    return { vertices, kind: 'cubic' };
  }

  function refreshAllPaths() {
    state.paths.clear();
    if (!state.selectedEntry) return;
    if (!stokesValuesFresh()) return;
    const [i, j] = state.selectedEntry;
    if (i === j) return;
    const ch = dataset.chambers[state.selectedChamber];
    const e = ch.entries[`${i},${j}`];
    if (!e || e.error) return;
    if (state.sdView === 'plus' || state.sdView === 'minus') return;
    const ps = state.punctureOverrides ?? dataset.punctures;
    const path = state.sdView === 'eg'
      ? { vertices: [{ ...ps[i] }, { ...ps[j] }], kind: 'line' as const }
      : computeNaturalPath(i, j, ps, currentD);
    const id = `${i},${j}:${state.sdView === 'eg' ? 'eg-line' : `std-natural-${path.kind}`}`;
    state.paths.set(id, { i, j, vertices: path.vertices, homotopyId: id });
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
