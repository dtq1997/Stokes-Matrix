import type { SimpleDataset } from './types.js';

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


export async function loadDataset(): Promise<SimpleDataset> {
  // BASE_URL: GH Pages = "/Stokes-Matrix/", 本地 dev = "/". cache-bust v= 强制每次拉新.
  // 默认: (2,2,2,2) 块版. URL ?dataset=simple 切回 (1,1,1,1) simple-spectrum.
  // Dataset 是 GH Pages 上的 static JSON, 不走 backend tunnel.
  const params = new URLSearchParams(window.location.search);
  const which = params.get('dataset') === 'simple' ? 'n4_simple' : 'n4_block';
  const url = `${import.meta.env.BASE_URL}data/${which}.json?v=${Date.now()}`.replace(/([^:])\/+/g, '$1/');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load dataset: ${r.status}`);
  return r.json();
}

/**
 * 调后端 push: u_k 拖到 u_k_new, 沿 isoeq 流演化 A, 返回新 (U', A', S_d_all).
 * 占位: 第一阶段先用静态 dataset, 不调.
 */
export interface RecomputeRequest {
  punctures: { re: number; im: number }[];
  A: { re: number; im: number }[][];
  m_sizes: number[];
  precision?: 'low' | 'medium' | 'high';
  algorithm?: 'legacy_entry' | 'v5_full';
}

export interface JobStatus {
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  chambers_done: number;
  chambers_total: number;
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
