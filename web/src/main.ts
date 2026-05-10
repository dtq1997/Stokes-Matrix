import katex from 'katex';
import { loadDataset, recomputeAsync, cancelJob, backendOnline } from './lib/data.js';
import type { JobStatus } from './lib/data.js';
import type { VizState, ComplexNum, PathRep, SdEntryData } from './lib/types.js';
import { Canvas } from './components/canvas.js';
import { chamberOfDirection, monodromyPhase } from './lib/geometry.js';
import { parsePiInput, formatPi } from './lib/pi-input.js';

function tex(s: string, displayMode = false): string {
  return katex.renderToString(s, { displayMode, throwOnError: false, strict: false });
}
function renderAllTex(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-tex]').forEach(el => {
    const src = el.dataset.tex!;
    if (el.dataset.texRendered === src) return;
    el.innerHTML = tex(src);
    el.dataset.texRendered = src;
  });
}

const fmtComplex = (re: number, im: number, digits = 4) => {
  const r = re.toFixed(digits);
  const i = im.toFixed(digits);
  const sign = im >= 0 ? '+' : '-';
  return `<span class="complex-re">${r}</span> ${sign} <span class="complex-im">${Math.abs(im).toFixed(digits)}</span>i`;
};

async function main() {
  const dataset = await loadDataset();

  let n = dataset.punctures.length;
  // 块结构: n 个块, 每块 m_k 大小, 总维度 N = sum m_k.
  // SSOT: A 内部存 N×N 复矩阵, 块结构由 m_sizes 描述.
  const N0 = dataset.m_sizes.reduce((a, b) => a + b, 0);
  const blockStarts = (ms: number[]) => {
    const s = [0]; for (let k = 0; k < ms.length - 1; k++) s.push(s[k] + ms[k]); return s;
  };
  function rebuildInitialA(): ComplexNum[][] {
    const ms = dataset.m_sizes;
    const N = ms.reduce((a, b) => a + b, 0);
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
    stokesStale: false,
  };

  const onStateChange = (_s: VizState) => {
    // canvas 触发 (拖 puncture / path vertex) 后, 标 Stokes 数值 stale.
    // path-vertex drag 不改 punctureOverrides 但 path 几何变了 — 数值还是旧 dataset 的
    // 值 (因为算法走的 algo_wp 没变, 同伦类 cache 命中). 这里宁可标 stale 用户决定.
    state.stokesStale = !!state.punctureOverrides || !!state.AOverrides;
    refreshRecomputeBtn();
    updateStaleBanner();
    updateStokesPanel();
    updatePathInfo();
  };

  const svg = document.getElementById('canvas') as unknown as SVGSVGElement;
  const canvas = new Canvas(svg, state, onStateChange);

  // ---------- left panel: entry grid ----------
  buildEntryGrid();
  function buildEntryGrid() {
    const grid = document.getElementById('entry-grid')!;
    grid.innerHTML = '';
    grid.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const cell = document.createElement('div');
        cell.className = 'cell' + (i === j ? ' diag' : '');
        cell.innerHTML = i === j ? '·' : tex(`{}_{${i+1}${j+1}}`);
        if (i !== j) cell.addEventListener('click', () => selectEntry(i, j));
        grid.appendChild(cell);
      }
    }
  }

  // ---------- d slider (连续, 区间 [2kπ, (2k+2)π], 输入框 π 单位) ----------
  const sliderWrap = document.getElementById('d-slider-wrap')!;
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.step = '0.0001';
  sliderWrap.appendChild(slider);
  const dReadout = document.getElementById('d-readout')!;
  const dInput = document.getElementById('d-input') as HTMLInputElement;


  const markStrip = document.createElement('div');
  markStrip.id = 'd-marker-strip';
  sliderWrap.appendChild(markStrip);
  buildMarkerStrip(markStrip);

  let currentD = -Math.PI / 2;  // 默认 d = -π/2 (k = -1)

  function setD(d: number, source: 'slider' | 'input' | 'init' = 'init') {
    currentD = d;
    // slider 源拖动时不重算 k 区间, 避免边界浮点把 k 跳到 -4 之类
    // 只有 input 框 / init 才切区间
    if (source !== 'slider') {
      const k = Math.floor(d / (2 * Math.PI));
      slider.min = String(2 * k * Math.PI);
      slider.max = String((2 * k + 2) * Math.PI);
      slider.value = String(d);
    }
    if (source !== 'input') dInput.value = formatPi(d / Math.PI);
    canvas.setDirection(d);
    const newCh = chamberOfDirection(d, dataset.rays);
    state.selectedChamber = newCh;
    // d 每变, path PL 代表元跟着重 build (cut 转, path 也跟着转)
    refreshAllPaths();
    canvas.setState(state);
    // 每次 d 变都刷 entry 显示: phase 修正 = exp(2πi·m·(A_ii-A_jj)) 跟 d 数值挂钩,
    // 同 chamber 内跨周期也得重算 (m 不同 phase 不同).
    refreshStokesMatrix();
    updateDReadout();
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
    const tp = 2 * Math.PI;
    // 只画 anti-Stokes rays (chamber 边界), chamber center 多余去掉
    for (const r of dataset.rays) {
      const m = document.createElement('div');
      m.className = 'd-mark ray';
      m.style.left = `${(r / tp) * 100}%`;
      m.title = `anti-Stokes ray  ${(r * 180 / Math.PI).toFixed(2)}°  =  ${(r / Math.PI).toFixed(4)} π`;
      el.appendChild(m);
    }
  }

  function updateDReadout() {
    const k = Math.floor(currentD / (2 * Math.PI));
    const loTex = 2 * k === 0 ? '0' : (2*k === 1 ? '\\pi' : `${2*k}\\pi`);
    const hiTex = 2 * k + 2 === 0 ? '0' : (2*k+2 === 1 ? '\\pi' : `${2*k+2}\\pi`);
    dReadout.innerHTML = tex(`d \\in [${loTex},\\ ${hiTex}]`);
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
    const oldA = state.AOverrides!;
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
    // 新 A: N_new × N_new, 按 block 索引保留 oldA, 新位置默认 0 (对角 0.1)
    const newN_total = newM.reduce((a, b) => a + b, 0);
    const newA = Array.from({ length: newN_total }, () =>
      Array.from({ length: newN_total }, () => ({ re: 0, im: 0 })));
    // 拷贝旧 block 数据 (block index < min(oldN, newN))
    const minN = Math.min(oldN, newN);
    const oldStarts: number[] = []; let s = 0;
    for (const m of oldM) { oldStarts.push(s); s += m; }
    const newStarts: number[] = []; s = 0;
    for (const m of newM) { newStarts.push(s); s += m; }
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
    // 新 block 对角 entry 默认非零防 trivial
    for (let I = oldN; I < newN; I++) {
      newA[newStarts[I]][newStarts[I]] = { re: 0.1, im: 0 };
    }

    state.punctureOverrides = newU;
    state.mOverrides = newM;
    state.AOverrides = newA;
    state.selectedEntry = null;
    state.paths.clear();
    state.stokesStale = true;

    n = newN;
    nInput.value = String(n);

    buildEntryGrid();
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
  updateDimInfo();
  // Recompute 按钮 (后端可用 + state stale 时启用)
  const recomputeBtn = document.getElementById('state-recompute') as HTMLButtonElement;
  const recomputeStatus = document.getElementById('recompute-status')!;
  let backendAvailable = false;
  backendOnline().then(ok => {
    backendAvailable = ok;
    if (ok) {
      recomputeStatus.textContent = 'backend online :8000';
    } else {
      recomputeStatus.textContent = '';   // 不挤占空间, button disabled 已表达
      recomputeBtn.title = 'Recompute 需本地后端: sage -python server/push_server.py';
    }
    refreshRecomputeBtn();
  });
  function refreshRecomputeBtn() {
    if (recomputeBtn.classList.contains('computing')) return;
    recomputeBtn.disabled = !(backendAvailable && state.stokesStale);
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
    try {
      const precisionSel = document.getElementById('precision-select') as HTMLSelectElement;
      const precision = (precisionSel?.value ?? 'medium') as 'low' | 'medium' | 'high';
      const { result: newDs } = await recomputeAsync(
        {
          punctures: state.punctureOverrides!,
          A: state.AOverrides!,
          m_sizes: state.mOverrides!,
          precision,
        },
        (s: JobStatus) => {
          if (s.chambers_total > 0) {
            const pct = Math.round(s.progress * 100);
            recomputeStatus.innerHTML =
              `<div class="progress-bar"><div style="width:${pct}%"></div></div>` +
              `chamber ${s.chambers_done} / ${s.chambers_total} ` +
              `<span class="dim">(${s.elapsed_s.toFixed(1)}s)</span>`;
          } else {
            recomputeStatus.innerHTML =
              `starting sage... <span class="dim">(${s.elapsed_s.toFixed(1)}s)</span>`;
          }
        },
        (jobId) => { currentJobId = jobId; },
      );
      // 替换 dataset 内容
      Object.keys(dataset).forEach(k => delete (dataset as any)[k]);
      Object.assign(dataset, newDs);
      buildMarkerStrip(markStrip);
      state.selectedChamber = chamberOfDirection(currentD, dataset.rays);
      state.stokesStale = false;
      refreshAllPaths();
      canvas.setState(state);
      refreshStokesMatrix();
      updateDReadout();
      updateStokesPanel();
      updatePathInfo();
      updateStaleBanner();
      const elapsed = (newDs as any)._compute_seconds?.toFixed(1) ?? '?';
      recomputeStatus.innerHTML = `<span style="color: var(--good)">done in ${elapsed}s</span>`;
    } catch (e) {
      recomputeStatus.innerHTML = `<span style="color: var(--bad)">${(e as Error).message}</span>`;
    } finally {
      currentJobId = null;
      recomputeBtn.classList.remove('computing');
      recomputeBtn.textContent = 'Recompute Stokes';
      refreshRecomputeBtn();
    }
  });

  document.getElementById('state-reset')!.addEventListener('click', () => {
    state.punctureOverrides = dataset.punctures.map(p => ({ ...p }));
    state.AOverrides = initialA.map(row => row.map(c => ({ ...c })));
    state.mOverrides = [...dataset.m_sizes];
    state.selectedEntry = null;
    state.paths.clear();
    state.stokesStale = false;
    n = dataset.punctures.length;
    nInput.value = String(n);
    buildEntryGrid();
    buildUTable();
    buildATable();
    buildStokesMatrix();
    updateDimInfo();
    updateStaleBanner();
    canvas.setState(state);
    updateStokesPanel();
    updatePathInfo();
  });

  // 初始化默认值
  setD(currentD, 'init');

  function fmtNum(x: number): string {
    if (x === 0) return '0';
    return x.toFixed(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }

  function buildUTable() {
    const t = document.getElementById('u-table')!;
    let html = `<thead><tr><th>${tex('k')}</th><th>${tex('\\mathrm{Re}\\,u_k')}</th>` +
      `<th>${tex('\\mathrm{Im}\\,u_k')}</th><th>${tex('m_k')}</th></tr></thead><tbody>`;
    for (let k = 0; k < n; k++) {
      html += `<tr><td class="row-label">${tex(`${k+1}`)}</td>` +
        `<td><input class="cx" data-k="${k}" data-axis="re" /></td>` +
        `<td><input class="cx" data-k="${k}" data-axis="im" /></td>` +
        `<td><input class="cx mk-input" data-k="${k}" /></td></tr>`;
    }
    html += '</tbody>';
    t.innerHTML = html;
    refreshUTable();
    t.addEventListener('change', onUEdit);
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
        input.value = fmtNum(ps[k][axis]);
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
      state.mOverrides![k] = m;
      state.stokesStale = true;
      updateStaleBanner();
      updateDimInfo();
      return;
    }
    const v = Number(t.value);
    if (!Number.isFinite(v)) { t.classList.add('invalid'); return; }
    t.classList.remove('invalid');
    const axis = t.dataset.axis as 're' | 'im';
    state.punctureOverrides![k][axis] = v;
    state.stokesStale = true;
    updateStaleBanner();
    canvas.setState(state);
  }
  function updateDimInfo() {
    const ms = state.mOverrides!;
    const m_total = ms.reduce((a, b) => a + b, 0);
    const el = document.getElementById('dim-info')!;
    el.innerHTML = tex(`m = \\sum_k m_k = ${m_total}`);
  }

  /** A 表: N×N 复矩阵 (N = sum m_k), 按块结构加视觉分隔.
   * 列/行 header 显示 "u_I (a)" 表示 block I 的 sub-index a (m_I>1 时), 否则只 "u_I". */
  function buildATable() {
    const t = document.getElementById('a-table') as HTMLTableElement;
    t.classList.add('a-table');
    const ms = state.mOverrides!;
    const N = ms.reduce((a, b) => a + b, 0);
    const starts = blockStarts(ms);
    const blockOf = (fi: number) => {
      for (let k = ms.length - 1; k >= 0; k--) if (fi >= starts[k]) return [k, fi - starts[k]];
      return [-1, -1];
    };
    let html = '<thead><tr><th></th>';
    for (let fj = 0; fj < N; fj++) {
      const [J, b] = blockOf(fj);
      const cls = (fj > 0 && b === 0) ? 'block-left' : '';
      const lbl = ms[J] > 1 ? `{}_{${J+1},${b+1}}` : `{}_{${J+1}}`;
      html += `<th class="${cls}">${tex(lbl)}</th>`;
    }
    html += '</tr></thead><tbody>';
    for (let fi = 0; fi < N; fi++) {
      const [I, a] = blockOf(fi);
      const trCls = (fi > 0 && a === 0) ? 'block-top' : '';
      html += `<tr class="${trCls}">`;
      const rLbl = ms[I] > 1 ? `{}_{${I+1},${a+1}}` : `{}_{${I+1}}`;
      html += `<td class="row-label">${tex(rLbl)}</td>`;
      for (let fj = 0; fj < N; fj++) {
        const [J, b] = blockOf(fj);
        const cls = (fj > 0 && b === 0) ? 'block-left' : '';
        html += `<td class="${cls}"><div class="cx-pair">` +
          `<input class="cx" data-i="${fi}" data-j="${fj}" data-axis="re" placeholder="Re" />` +
          `<input class="cx" data-i="${fi}" data-j="${fj}" data-axis="im" placeholder="Im" />` +
          `</div></td>`;
      }
      html += '</tr>';
    }
    html += '</tbody>';
    t.innerHTML = html;
    refreshATable();
    t.addEventListener('change', onAEdit);
  }
  function refreshATable() {
    const A = state.AOverrides!;
    document.querySelectorAll<HTMLInputElement>('#a-table input.cx').forEach(input => {
      const i = Number(input.dataset.i!);
      const j = Number(input.dataset.j!);
      const axis = input.dataset.axis as 're' | 'im';
      input.value = fmtNum(A[i][j][axis]);
    });
  }
  function onAEdit(e: Event) {
    const t = e.target as HTMLInputElement;
    if (!t.classList.contains('cx')) return;
    const v = Number(t.value);
    if (!Number.isFinite(v)) { t.classList.add('invalid'); return; }
    t.classList.remove('invalid');
    const i = Number(t.dataset.i!);
    const j = Number(t.dataset.j!);
    const axis = t.dataset.axis as 're' | 'im';
    state.AOverrides![i][j][axis] = v;
    state.stokesStale = true;
    updateStaleBanner();
  }

  function updateStaleBanner() {
    const b = document.getElementById('state-stale-banner')!;
    b.hidden = !state.stokesStale;
    refreshRecomputeBtn();
  }

  /** Stokes 矩阵网格: N×N flat grid, 按块结构加视觉分隔.
   * 对角块 (I, I) 显示单位 m_I × m_I (1/0).
   * 非对角块 (I, J) 显示 m_I × m_J entry 矩阵 (从 entry.value_block 取 (a, b)).
   * 点击任意 sub-cell 选 block (I, J).
   */
  function buildStokesMatrix() {
    const sm = document.getElementById('stokes-matrix')!;
    const ms = state.mOverrides ?? dataset.m_sizes;
    const N = ms.reduce((a, b) => a + b, 0);
    const starts = blockStarts(ms);
    const blockOf = (fi: number) => {
      for (let k = ms.length - 1; k >= 0; k--) if (fi >= starts[k]) return [k, fi - starts[k]];
      return [-1, -1];
    };
    sm.style.gridTemplateColumns = `repeat(${N}, 1fr)`;
    sm.innerHTML = '';
    for (let fi = 0; fi < N; fi++) {
      const [I, a] = blockOf(fi);
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

  /** 取 entry value_block 的 (a, b) sub-entry, 乘 paper monodromy phase.
   *
   * paper L1056: S_{d+2kπ} = e^{-2kπi δ_u A} S_d e^{2kπi δ_u A}
   * 取 (I, a; J, b) entry: (S_{d+2kπ})_{Ia, Jb} = e^{-2kπi A_{Ia,Ia}} · (S_d)_{Ia,Jb} · e^{2kπi A_{Jb,Jb}}
   * Simple-spectrum 退化为 monodromyPhase scalar 公式.
   *
   * 当前简化: 块版只支持 m=0 (sample d 同周期) phase=1. m≠0 时 console.warn 不修正
   * (块版 left-right 矩阵 exp 修正后续做). */
  function entryDisplayValue(
    e: SdEntryData, d_sample: number, i: number, j: number, a = 0, b = 0,
  ): ComplexNum {
    // 优先从 value_block 取 (a, b) entry (块版); 否则用 value_re/value_im (老 simple schema).
    let re0: number, im0: number;
    if (e.value_block && e.value_block[a] && e.value_block[a][b]) {
      re0 = e.value_block[a][b].re;
      im0 = e.value_block[a][b].im;
    } else {
      re0 = e.value_re ?? 0;
      im0 = e.value_im ?? 0;
    }
    // 块版 phase 修正 (block-diagonal A): 用每 sub-index 对应的对角谱值.
    const A_ii = blockDiagValue(i, a);
    const A_jj = blockDiagValue(j, b);
    const ph = monodromyPhase(currentD, d_sample, A_ii, A_jj);
    return {
      re: re0 * ph.re - im0 * ph.im,
      im: re0 * ph.im + im0 * ph.re,
    };
  }

  /** 取 block I 的 sub-index a 对应的 A 对角值 (块对角谱). 块版从 A_diag_block, 否则 A_diag. */
  function blockDiagValue(I: number, a: number): number {
    if (dataset.A_diag_block && dataset.A_diag_block[I]) return dataset.A_diag_block[I][a];
    return dataset.A_diag[I];  // simple case 退化
  }

  /** 复数 entry 渲染为 HTML grid (4 列: sign | 整数 | 小数 | i).
   * 两行 (re / im·i) 用同一 grid 让符号竖直对齐 + 小数点对齐 (整数右对齐 + 小数左对齐).
   * KaTeX 不支持 `array{r@{}l}` 的 `@{}` 列间距控制, 用 LaTeX 渲染会失败回退到源码.
   * 改用 HTML 完全可控. 字体用 KaTeX_Main 保持数学风格.
   * 模长 ≈ 0 → 单行 '0'.
   */
  function renderComplex(v: { re: number; im: number }, precision = 2): string {
    const mag = Math.hypot(v.re, v.im);
    if (mag < 5 * 10 ** -(precision + 1)) return '<span class="cs-zero">0</span>';
    const split = (x: number) => {
      const s = Math.abs(x).toFixed(precision);
      const dot = s.indexOf('.');
      return dot < 0 ? [s, ''] : [s.slice(0, dot), s.slice(dot)];
    };
    const reSign = v.re >= 0 ? '+' : '−';  // U+2212 minus sign, 比 '-' 视觉宽
    const imSign = v.im >= 0 ? '+' : '−';
    const [reInt, reFrac] = split(v.re);
    const [imInt, imFrac] = split(v.im);
    return `<div class="cs-grid">
      <span class="cs-sign">${reSign}</span><span class="cs-int">${reInt}</span><span class="cs-frac">${reFrac}</span><span class="cs-i"></span>
      <span class="cs-sign">${imSign}</span><span class="cs-int">${imInt}</span><span class="cs-frac">${imFrac}</span><span class="cs-i">i</span>
    </div>`;
  }

  function refreshStokesMatrix() {
    const sm = document.getElementById('stokes-matrix')!;
    const ch = dataset.chambers[state.selectedChamber];
    const cells = sm.children;
    for (let k = 0; k < cells.length; k++) {
      const cell = cells[k] as HTMLElement;
      const I = Number(cell.dataset.i!);
      const J = Number(cell.dataset.j!);
      const a = Number(cell.dataset.a!);
      const b = Number(cell.dataset.b!);
      if (I === J) {
        // 对角块 = identity sub-cell (a==b ? 1 : 0)
        cell.innerHTML = a === b
          ? '<span class="cs-int">1</span>'
          : '<span class="cs-zero">0</span>';
        continue;
      }
      const e = ch.entries[`${I},${J}`];
      const sel = !!(state.selectedEntry &&
        state.selectedEntry[0] === I && state.selectedEntry[1] === J);
      cell.classList.toggle('selected', sel);
      if (!e || e.error) {
        cell.innerHTML = `<span style="color: var(--bad)">!</span>`;
      } else {
        const v = entryDisplayValue(e, ch.d, I, J, a, b);
        cell.innerHTML = renderComplex(v);
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

  function refreshAllPaths() {
    state.paths.clear();
    if (!state.selectedEntry) return;
    const [i, j] = state.selectedEntry;
    // SSOT: 直接读 dataset.path (sage compute_Sd_entry 算出的 algo_wp). 同 chamber
    // 内 d 变 path 几何不变 (chamber-local 同伦不变性).
    const ch = dataset.chambers[state.selectedChamber];
    const e = ch.entries[`${i},${j}`];
    if (!e || !e.path) return;
    const verts: ComplexNum[] = e.path.map(p => ({ re: p.re, im: p.im }));
    const id = `${i},${j}`;
    state.paths.set(id, { i, j, vertices: verts, homotopyId: id });
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
    const labelTex = `(S_d)_{${i+1}${j+1}}`;
    if (e.error) {
      el.innerHTML = `<div class="label">${tex(labelTex)}</div>
        <div class="value" style="color: var(--bad)">FAIL: ${e.error}</div>`;
      return;
    }
    // 块版: 列出整个 m_i × m_j sub-block (每行 m_j 个 entry).
    const m_i = e.m_i ?? 1, m_j = e.m_j ?? 1;
    let blockHtml = '';
    if (m_i === 1 && m_j === 1) {
      const v = entryDisplayValue(e, ch.d, i, j, 0, 0);
      blockHtml = `<div class="value">${renderComplex(v, 5)}</div>`;
    } else {
      blockHtml = '<div class="block-grid" style="display:grid;'
        + `grid-template-columns:repeat(${m_j}, 1fr);gap:6px;margin-top:4px">`;
      for (let a = 0; a < m_i; a++) {
        for (let b = 0; b < m_j; b++) {
          const v = entryDisplayValue(e, ch.d, i, j, a, b);
          blockHtml += `<div class="block-sub-cell">${renderComplex(v, 4)}</div>`;
        }
      }
      blockHtml += '</div>';
    }
    el.innerHTML = `<div class="label">${tex(labelTex)}</div>` + blockHtml;
  }

  function updatePathInfo() {
    const el = document.getElementById('path-info')!;
    if (!state.selectedEntry) { el.textContent = '—'; return; }
    const [i, j] = state.selectedEntry;
    const ch = dataset.chambers[state.selectedChamber];
    const e = ch.entries[`${i},${j}`];
    if (!e || !e.path) { el.textContent = '—'; return; }
    const tau = e.tau_code?.toFixed(4) ?? '—';
    const lift = e.theta_t_lift?.toFixed(4) ?? '—';
    el.innerHTML =
      `<div>vertices: ${e.path.length}</div>` +
      `<div>${tex(`\\tau_{\\mathrm{code}} = ${tau}`)}</div>` +
      `<div>${tex(`\\theta_t\\ \\mathrm{lift} = ${lift}`)}</div>`;
  }

  // 入口处渲染所有 data-tex 标签
  renderAllTex(document);
}

main().catch(err => {
  console.error(err);
  document.getElementById('app')!.innerHTML =
    `<div style="padding: 40px; color: #ff5555">Failed to load: ${err.message}<br/><br/>
     <span style="color: #9099a6">先跑 <code>sage 60-outputs/sd-viz/data/export_n4_simple.sage</code> 生成 n4_simple.json</span></div>`;
});
