import { loadDataset } from './lib/data.js';
import type { VizState, ComplexNum, PathRep } from './lib/types.js';
import { Canvas } from './components/canvas.js';
import { chamberOfDirection } from './lib/geometry.js';

const fmtComplex = (re: number, im: number, digits = 4) => {
  const r = re.toFixed(digits);
  const i = im.toFixed(digits);
  const sign = im >= 0 ? '+' : '-';
  return `<span class="complex-re">${r}</span> ${sign} <span class="complex-im">${Math.abs(im).toFixed(digits)}</span>i`;
};

async function main() {
  const dataset = await loadDataset();

  const state: VizState = {
    dataset,
    selectedChamber: 0,
    selectedEntry: null,
    paths: new Map(),
    punctureOverrides: null,
  };

  const onStateChange = (_s: VizState) => {
    updateStokesPanel();
    updatePathInfo();
  };

  const svg = document.getElementById('canvas') as unknown as SVGSVGElement;
  const canvas = new Canvas(svg, state, onStateChange);

  // ---------- left panel: entry grid ----------
  const grid = document.getElementById('entry-grid')!;
  const n = dataset.punctures.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const cell = document.createElement('div');
      cell.className = 'cell' + (i === j ? ' diag' : '');
      cell.textContent = i === j ? '·' : `${i + 1}${j + 1}`;
      if (i !== j) {
        cell.addEventListener('click', () => selectEntry(i, j));
      }
      grid.appendChild(cell);
    }
  }

  // ---------- d slider (连续 0..2π) ----------
  const sliderWrap = document.getElementById('d-slider-wrap')!;
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(2 * Math.PI);
  slider.step = '0.001';
  slider.value = String(dataset.chambers[0].d);
  sliderWrap.appendChild(slider);
  const dReadout = document.getElementById('d-readout')!;

  const chamberDs = dataset.chambers.map(c => c.d);

  // 在 slider 下方画 chamber/anti-Stokes ray 标记条
  const markStrip = document.createElement('div');
  markStrip.id = 'd-marker-strip';
  sliderWrap.appendChild(markStrip);
  buildMarkerStrip(markStrip);

  slider.addEventListener('input', () => {
    const d = Number(slider.value);
    canvas.setDirection(d);
    const newCh = chamberOfDirection(d, chamberDs);
    if (newCh !== state.selectedChamber) {
      state.selectedChamber = newCh;
      refreshAllPaths();
      canvas.setState(state);
    }
    updateDReadout();
    updateStokesPanel();
    updatePathInfo();
  });

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
    const d = Number(slider.value);
    const dPi = (d / Math.PI).toFixed(4);
    const deg = (d * 180 / Math.PI).toFixed(1);
    const chDPi = (dataset.chambers[state.selectedChamber].d / Math.PI).toFixed(4);
    dReadout.innerHTML = `d = ${dPi} π <span class="dim">(${deg}°)</span><br/>` +
      `chamber ${state.selectedChamber + 1}/${dataset.chambers.length} ` +
      `<span class="dim">@ d̂ = ${chDPi} π</span>`;
  }

  function selectEntry(i: number, j: number) {
    state.selectedEntry = [i, j];
    document.querySelectorAll('#entry-grid .cell').forEach((el, idx) => {
      const ii = Math.floor(idx / n), jj = idx % n;
      el.classList.toggle('selected', ii === i && jj === j);
    });
    refreshAllPaths();
    canvas.setState(state);
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
    if (e.error) {
      el.innerHTML = `<span class="label">(S<sub>d</sub>)<sub>${i+1},${j+1}</sub></span>
        <div class="value" style="color: var(--bad)">FAIL: ${e.error}</div>`;
      return;
    }
    el.innerHTML = `<span class="label">(S<sub>d</sub>)<sub>${i+1},${j+1}</sub></span>
      <div class="value">${fmtComplex(e.value_re ?? 0, e.value_im ?? 0)}</div>
      <div class="label" style="margin-top: 12px">|·| = ${Math.hypot(e.value_re ?? 0, e.value_im ?? 0).toFixed(5)}</div>`;
  }

  function updatePathInfo() {
    const el = document.getElementById('path-info')!;
    if (!state.selectedEntry) { el.textContent = '—'; return; }
    const [i, j] = state.selectedEntry;
    const ch = dataset.chambers[state.selectedChamber];
    const e = ch.entries[`${i},${j}`];
    if (!e || !e.path) { el.textContent = '—'; return; }
    const lines = [
      `vertices: ${e.path.length}`,
      `τ_code = ${e.tau_code?.toFixed(4) ?? '—'}`,
      `θ_t lift = ${e.theta_t_lift?.toFixed(4) ?? '—'}`,
    ];
    el.textContent = lines.join('\n');
  }

  updateDReadout();
  updateStokesPanel();
  updatePathInfo();
}

main().catch(err => {
  console.error(err);
  document.getElementById('app')!.innerHTML =
    `<div style="padding: 40px; color: #ff5555">Failed to load: ${err.message}<br/><br/>
     <span style="color: #9099a6">先跑 <code>sage 60-outputs/sd-viz/data/export_n4_simple.sage</code> 生成 n4_simple.json</span></div>`;
});
