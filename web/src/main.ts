import katex from 'katex';
import { loadDataset, recomputeAsync, cancelJob, backendOnline } from './lib/data.js';
import type { JobStatus } from './lib/data.js';
import type { VizState, ComplexNum, PathRep } from './lib/types.js';
import { Canvas } from './components/canvas.js';
import { chamberOfDirection } from './lib/geometry.js';
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
  // 初始 A 从 dataset.A_diag + A_off 装回 n×n 复矩阵
  const initialA: ComplexNum[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      i === j
        ? { re: dataset.A_diag[i], im: 0 }
        : { re: 0, im: 0 }
    ));
  for (const e of dataset.A_off) initialA[e.i][e.j] = { re: e.re, im: e.im };

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

  const chamberDs = dataset.chambers.map(c => c.d);

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
    const newCh = chamberOfDirection(d, chamberDs);
    if (newCh !== state.selectedChamber) {
      state.selectedChamber = newCh;
      refreshAllPaths();
      canvas.setState(state);
      refreshStokesMatrix();
    }
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
    // anti-Stokes rays (dataset.rays 已含 0/π)
    for (const r of dataset.rays) {
      const m = document.createElement('div');
      m.className = 'd-mark ray';
      m.style.left = `${(r / tp) * 100}%`;
      m.title = `anti-Stokes ray ${(r * 180 / Math.PI).toFixed(2)}°`;
      el.appendChild(m);
    }
    // chamber center 标
    for (const cd of chamberDs) {
      const m = document.createElement('div');
      m.className = 'd-mark chamber';
      m.style.left = `${(cd / tp) * 100}%`;
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
      recomputeStatus.innerHTML =
        'backend offline (启动: <span class="mono">sage -python server/push_server.py</span>)';
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
      const { result: newDs } = await recomputeAsync(
        {
          punctures: state.punctureOverrides!,
          A: state.AOverrides!,
          m_sizes: state.mOverrides!,
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
      chamberDs.length = 0;
      chamberDs.push(...newDs.chambers.map(c => c.d));
      buildMarkerStrip(markStrip);
      state.selectedChamber = chamberOfDirection(currentD, chamberDs);
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
    const N = ms.reduce((a, b) => a + b, 0);
    const el = document.getElementById('dim-info')!;
    el.innerHTML = tex(`n = ${n},\\quad N = \\sum_k m_k = ${N}`);
  }

  function buildATable() {
    const t = document.getElementById('a-table') as HTMLTableElement;
    t.classList.add('a-table');
    let html = '<thead><tr><th></th>';
    for (let j = 0; j < n; j++) html += `<th>${tex(`{}_{${j+1}}`)}</th>`;
    html += '</tr></thead><tbody>';
    for (let i = 0; i < n; i++) {
      html += `<tr><td class="row-label">${tex(`{}_{${i+1}}`)}</td>`;
      for (let j = 0; j < n; j++) {
        html += `<td><div class="cx-pair">` +
          `<input class="cx" data-i="${i}" data-j="${j}" data-axis="re" placeholder="Re" />` +
          `<input class="cx" data-i="${i}" data-j="${j}" data-axis="im" placeholder="Im" />` +
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

  function buildStokesMatrix() {
    const sm = document.getElementById('stokes-matrix')!;
    sm.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
    sm.innerHTML = '';
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const cell = document.createElement('div');
        cell.className = 'sm-cell' + (i === j ? ' diag' : '');
        cell.dataset.i = String(i);
        cell.dataset.j = String(j);
        if (i !== j) cell.addEventListener('click', () => selectEntry(i, j));
        sm.appendChild(cell);
      }
    }
    refreshStokesMatrix();
  }
  function refreshStokesMatrix() {
    const sm = document.getElementById('stokes-matrix')!;
    const ch = dataset.chambers[state.selectedChamber];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const cell = sm.children[i * n + j] as HTMLElement;
        if (i === j) {
          cell.innerHTML = tex('1');
          continue;
        }
        const e = ch.entries[`${i},${j}`];
        const sel = !!(state.selectedEntry &&
          state.selectedEntry[0] === i && state.selectedEntry[1] === j);
        cell.classList.toggle('selected', sel);
        if (!e || e.error) {
          cell.innerHTML = `<span style="color: var(--bad)">!</span>`;
        } else {
          const re = e.value_re ?? 0, im = e.value_im ?? 0;
          const mag = Math.hypot(re, im);
          const argDeg = Math.atan2(im, re) * 180 / Math.PI;
          cell.innerHTML =
            `<div><div class="sm-mag">${tex(mag.toFixed(2))}</div>` +
            `<div class="sm-arg">${tex(`${argDeg >= 0 ? '+' : ''}${argDeg.toFixed(0)}^\\circ`)}</div></div>`;
        }
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
    const ch = dataset.chambers[state.selectedChamber];
    const e = ch.entries[`${i},${j}`];
    if (!e || !e.path) return;
    const verts: ComplexNum[] = e.path.map(p => ({ re: p.re, im: p.im }));
    const id = `${i},${j}`;
    state.paths.set(id, {
      i, j,
      vertices: verts,
      homotopyId: id,
      liftIndex: 0,
    });
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
    const re = e.value_re ?? 0, im = e.value_im ?? 0;
    const reS = re.toFixed(5);
    const imS = (im >= 0 ? '+' : '') + im.toFixed(5);
    const mag = Math.hypot(re, im).toFixed(5);
    el.innerHTML =
      `<div class="label">${tex(labelTex)}</div>` +
      `<div class="value">${tex(`${reS} ${imS} \\mathrm{i}`)}</div>` +
      `<div class="label" style="margin-top: 12px">${tex(`|\\,\\cdot\\,| = ${mag}`)}</div>`;
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
