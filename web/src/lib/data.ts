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
export async function pushPuncture(
  k: number, newPos: { re: number; im: number },
): Promise<SimpleDataset> {
  const r = await fetch('/api/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ k, re: newPos.re, im: newPos.im }),
  });
  if (!r.ok) throw new Error(`Push failed: ${r.status}`);
  return r.json();
}
