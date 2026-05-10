import type { SimpleDataset } from './types.js';

export async function loadDataset(): Promise<SimpleDataset> {
  // import.meta.env.BASE_URL 在 GH Pages 下 = "/path-algebroid/", 本地 = "/"
  // cache-bust query 强制浏览器拉最新 dataset, 否则 deploy 后旧 dataset 可能残留.
  const url = `${import.meta.env.BASE_URL}data/n4_simple.json?v=${Date.now()}`.replace(/([^:])\/+/g, '$1/');
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
  const r = await fetch('/api/recompute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!r.ok) throw new Error(`recompute start ${r.status}: ${await r.text()}`);
  const { job_id: jobId } = await r.json();
  if (onJobStart) onJobStart(jobId);

  while (true) {
    await new Promise(res => setTimeout(res, pollMs));
    const sr = await fetch(`/api/job/${jobId}`);
    if (!sr.ok) throw new Error(`job poll ${sr.status}: ${await sr.text()}`);
    const s: JobStatus = await sr.json();
    if (onProgress) onProgress(s);
    if (s.status === 'done') return { jobId, result: s.result! };
    if (s.status === 'error') throw new Error(s.error ?? 'unknown error');
    if (s.status === 'cancelled') throw new Error('cancelled');
  }
}

export async function cancelJob(jobId: string): Promise<void> {
  await fetch(`/api/job/${jobId}/cancel`, { method: 'POST' });
}

export function backendOnline(): Promise<boolean> {
  return fetch('/api/dataset', { method: 'GET' })
    .then(r => r.ok).catch(() => false);
}
