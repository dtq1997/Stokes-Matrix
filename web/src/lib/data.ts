import type { SimpleDataset } from './types.js';

export async function loadDataset(): Promise<SimpleDataset> {
  // import.meta.env.BASE_URL 在 GH Pages 下 = "/path-algebroid/", 本地 = "/"
  const url = `${import.meta.env.BASE_URL}data/n4_simple.json`.replace(/\/+/g, '/');
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

/**
 * 全量重算: 给定 (U, A, m), 后端跑 sage 算所有 chamber × entry, 返回新 SimpleDataset.
 * 当前同步阻塞 (5 分钟 simple n=4); 调用方必须 spinner UI.
 */
export async function recompute(req: RecomputeRequest): Promise<SimpleDataset> {
  const r = await fetch('/api/recompute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!r.ok) throw new Error(`recompute ${r.status}: ${await r.text()}`);
  return r.json();
}

export function backendOnline(): Promise<boolean> {
  return fetch('/api/dataset', { method: 'GET' })
    .then(r => r.ok).catch(() => false);
}
