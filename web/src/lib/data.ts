import type { SimpleDataset } from './types.js';
import { attachCpnExprs } from './cpn-formulas.js';

// =====================================================================
// Backend URL resolution (Phase: tunnel-via-cloudflared 2026-05-12).
//
// Priority:
//   1. URL param ?backend=https://... (one-time override; persisted to localStorage)
//   2. localStorage 'sd-viz-backend' (last explicit choice)
//   3. import.meta.env.VITE_BACKEND_URL (build-time default, set in CI for GH Pages)
//   4. Empty string -> relative '/api/...' (local dev with vite proxy)
// =====================================================================

const LS_KEY = 'sd-viz-backend';

function resolveBackendUrl(): string {
  if (typeof window === 'undefined') return '';
  try {
    const param = new URLSearchParams(window.location.search).get('backend');
    if (param !== null) {
      const trimmed = param.trim().replace(/\/+$/, '');
      try { localStorage.setItem(LS_KEY, trimmed); } catch { /* ignore */ }
      return trimmed;
    }
    const stored = (() => {
      try { return localStorage.getItem(LS_KEY); } catch { return null; }
    })();
    if (stored !== null) return stored.replace(/\/+$/, '');
  } catch { /* ignore */ }
  // Build-time default; set via Vite env (VITE_BACKEND_URL) in GH Pages CI.
  const buildDefault = (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? '';
  return buildDefault.replace(/\/+$/, '');
}

let _backendBase: string = resolveBackendUrl();

export function getBackendBase(): string { return _backendBase; }
export function setBackendBase(url: string): void {
  const trimmed = url.trim().replace(/\/+$/, '');
  _backendBase = trimmed;
  try {
    if (trimmed === '') localStorage.removeItem(LS_KEY);
    else localStorage.setItem(LS_KEY, trimmed);
  } catch { /* ignore */ }
}
export function clearBackendBase(): void { setBackendBase(''); }

function apiUrl(path: string): string {
  const base = _backendBase;
  if (!base) return path;
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

// Loca.lt + Cloudflare tunnel both ignore unknown headers harmlessly.
// `bypass-tunnel-reminder` skips loca.lt splash if user ever switches back.
function defaultHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'bypass-tunnel-reminder': 'sd-viz',
    ...(extra ?? {}),
  };
}


// 静态 dataset 注册表. 新增 preset 改这里 + 把 data/<file>.json copy 到
// web/public/data/. URL ?dataset=<key> 选哪个; 缺省 'n4_block'.
// label 用 KaTeX, 会在 dropdown 里实时渲染.
// hideOnLoad: dataset 作为 "example" 加载, 初始 stokesStale = true,
// Stokes 矩阵 cell 显示 "—", banner 提示点 Compute. 预计算值还在 JSON 里,
// 但用户必须走后端重跑才能看到 (完整演示流程).
export const DATASET_REGISTRY: { key: string; file: string; label: string; hideOnLoad?: boolean }[] = [
  { key: 'cp2',    file: 'cp2',       label: 'QH^*(\\mathbb{CP}^2)', hideOnLoad: true },
  { key: 'cp3',    file: 'cp3',       label: 'QH^*(\\mathbb{CP}^3)', hideOnLoad: true },
  { key: 'cp4',    file: 'cp4',       label: 'QH^*(\\mathbb{CP}^4)', hideOnLoad: true },
  { key: 'simple', file: 'n4_simple', label: 'n=4, m=(1,1,1,1) simple spectrum' },
  { key: 'block',  file: 'n4_block',  label: 'n=4, m=(2,2,2,2) blocks' },
];
const DEFAULT_DATASET_KEY = 'cp2';

export function getDatasetKey(): string {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('dataset');
  if (raw === 'simple') return 'simple'; // legacy alias
  if (raw && DATASET_REGISTRY.some(d => d.key === raw)) return raw;
  return DEFAULT_DATASET_KEY;
}

export async function loadDataset(): Promise<SimpleDataset> {
  // BASE_URL: GH Pages = "/Stokes-Matrix/", 本地 dev = "/". cache-bust v= 强制每次拉新.
  // Dataset 是 GH Pages 上的 static JSON, 不走 backend tunnel.
  const key = getDatasetKey();
  const entry = DATASET_REGISTRY.find(d => d.key === key) ?? DATASET_REGISTRY[0];
  const url = `${import.meta.env.BASE_URL}data/${entry.file}.json?v=${Date.now()}`.replace(/([^:])\/+/g, '$1/');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load dataset: ${r.status}`);
  const ds: SimpleDataset = await r.json();
  // CP^{K-1} 例子: 把 puncture / A_off 浮点 entry 套上精确表达式 (e^(i*pi/...) 等).
  // m_sizes 全 1, 长度 K. 数据格式跟其他 simple dataset 一致, 只是多了 expr 字段.
  const cpMatch = key.match(/^cp(\d+)$/);
  if (cpMatch) {
    const K = parseInt(cpMatch[1], 10) + 1;
    if (ds.m_sizes.every(m => m === 1) && ds.m_sizes.length === K && ds.punctures.length === K) {
      attachCpnExprs(K, ds.punctures, ds.A_off);
      // sage export 出来的 A_diag 是 -3.7e-39 量级浮点 dust, 数学上恒为 0
      // (μ_diag 求和为 0). UI 里直接零化, 避免 cell 显示 "-3.67342e-39" 这种值.
      ds.A_diag = ds.A_diag.map(() => 0);
      if (ds.A_diag_block) ds.A_diag_block = ds.A_diag_block.map(row => row.map(() => 0));
    }
  }
  return ds;
}

/**
 * 调后端 push: u_k 拖到 u_k_new, 沿 isoeq 流演化 A, 返回新 (U', A', S_d_all).
 * 占位: 第一阶段先用静态 dataset, 不调.
 */
export interface RecomputeRequest {
  punctures: { re: number; im: number }[];
  A: { re: number; im: number }[][];
  m_sizes: number[];
  precision?: 'fast' | 'low' | 'medium' | 'high';
  algorithm?: 'legacy_entry' | 'v5_full';
}

export interface JobStatus {
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  chambers_done: number;
  chambers_total: number;
  phase?: string;          // 'starting sage' | 'base-case' | 'wall-crossing' | 'chamber-pack' | ...
  phase_detail?: string;   // 'pair=(2,3)|done=5/12' 等具体细节
  elapsed_s: number;
  result: SimpleDataset | null;
  error: string | null;
}

/**
 * 异步全量重算: 启动 job 立即返 jobId, 调用方 poll status 直到 done.
 * onProgress(done, total, elapsed) 每 ~1s 调一次; resolve 时 status.result 是新数据集.
 */
export async function recomputeAsync(
  req: RecomputeRequest,
  onProgress?: (s: JobStatus) => void,
  onJobStart?: (jobId: string) => void,
  pollMs = 800,
): Promise<{ jobId: string; result: SimpleDataset }> {
  const r = await fetch(apiUrl('/api/recompute'), {
    method: 'POST',
    headers: defaultHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(req),
  });
  if (!r.ok) throw new Error(`recompute start ${r.status}: ${await r.text()}`);
  const { job_id: jobId } = await r.json();
  if (onJobStart) onJobStart(jobId);

  while (true) {
    await new Promise(res => setTimeout(res, pollMs));
    const sr = await fetch(apiUrl(`/api/job/${jobId}`), { headers: defaultHeaders() });
    if (!sr.ok) throw new Error(`job poll ${sr.status}: ${await sr.text()}`);
    const s: JobStatus = await sr.json();
    if (onProgress) onProgress(s);
    if (s.status === 'done') return { jobId, result: s.result! };
    if (s.status === 'error') throw new Error(s.error ?? 'unknown error');
    if (s.status === 'cancelled') throw new Error('cancelled');
  }
}

export async function cancelJob(jobId: string): Promise<void> {
  await fetch(apiUrl(`/api/job/${jobId}/cancel`), {
    method: 'POST',
    headers: defaultHeaders(),
  });
}

export function backendOnline(): Promise<boolean> {
  return fetch(apiUrl('/api/dataset'), { method: 'GET', headers: defaultHeaders() })
    .then(r => r.ok).catch(() => false);
}
