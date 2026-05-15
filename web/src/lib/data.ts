import type { SimpleDataset } from './types.js';
import { buildCpnDataset } from './cpn-formulas.js';
import { antiStokesRays } from './geometry.js';

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
// 单一 'cpn' 例子: 用户改左边 n= 输入框就切 CP^{n-1} (n=puncture count).
// 旧 cp2/cp3/cp4 链接通过 URL 兼容 (跳到 cpn 并设对应 n).
export const DATASET_REGISTRY: { key: string; file: string; label: string; hideOnLoad?: boolean }[] = [
  { key: 'cpn',    file: '__synth_cpn__', label: 'QH^*(\\mathbb{CP}^{n-1})', hideOnLoad: true },
  { key: 'simple', file: 'n4_simple',     label: 'n=4, m=(1,1,1,1) simple spectrum' },
  { key: 'block',  file: 'n4_block',      label: 'n=4, m=(2,2,2,2) blocks' },
];
const DEFAULT_DATASET_KEY = 'cpn';
const CPN_DEFAULT_N = 4;   // 默认 n=4 ⇒ CP^3 (n = puncture 数 K = CP 维数+1)
const CPN_MIN_N = 1;       // n=1 ⇒ CP^0 (1×1 退化, 没 off-diag, UI 也跑得通)
const CPN_MAX_N = 10;      // n=10 ⇒ CP^9

export function getDatasetKey(): string {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('dataset');
  if (raw === 'simple') return 'simple'; // legacy alias
  // 旧 ?dataset=cp2/cp3/cp4 → 'cpn' (n 通过 URL 'n=' 走 getCpnN, 见 loadDataset).
  if (raw && /^cp\d+$/.test(raw)) return 'cpn';
  if (raw && DATASET_REGISTRY.some(d => d.key === raw)) return raw;
  return DEFAULT_DATASET_KEY;
}

/** ?n=<int> for cpn dataset; legacy ?dataset=cpK 自动映射成 n = K+1. */
export function getCpnN(): number {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('dataset');
  const legacy = raw && /^cp(\d+)$/.exec(raw);
  if (legacy) {
    // cp2 → CP^2 = 3 punctures; cp4 → CP^4 = 5 punctures.
    const n = parseInt(legacy[1], 10) + 1;
    return Math.max(CPN_MIN_N, Math.min(CPN_MAX_N, n));
  }
  const nRaw = params.get('n');
  const n = nRaw ? parseInt(nRaw, 10) : CPN_DEFAULT_N;
  if (!Number.isInteger(n)) return CPN_DEFAULT_N;
  return Math.max(CPN_MIN_N, Math.min(CPN_MAX_N, n));
}

export const CPN_N_BOUNDS = { min: CPN_MIN_N, max: CPN_MAX_N, default: CPN_DEFAULT_N };

/** 客户端按公式构 cpn dataset, 不 fetch JSON. rays + 空 chambers 占位
 *  (hideOnLoad=true ⇒ stokesStale=true ⇒ entries 全显 "—", 用户点 Compute 后由后端填).
 *  chamber 个数 = rays 个数 (anti-Stokes 把 S^1 分成等数 chamber). 每个 chamber.d
 *  取相邻两 ray 的中点 (wrap 处加 2π 后再取中点) — d-slider 初值用. */
function synthCpnDataset(n: number): SimpleDataset {
  const K = Math.max(CPN_MIN_N, Math.min(CPN_MAX_N, n));
  const { punctures, A_diag, A_diag_block, A_off, m_sizes } = buildCpnDataset(K);
  // rescale punctures: buildCpnDataset 给的是单位圆 (e^(2πi n/K)), attachCpnExprs 的
  // 1/K rescale 这里跳过 (buildCpnDataset 不放大 K 倍, 直接落在单位圆).
  const rays = antiStokesRays(punctures);
  const TP = 2 * Math.PI;
  const chambers = rays.map((r, k) => {
    const next = k + 1 < rays.length ? rays[k + 1] : rays[0] + TP;
    return { d: (r + next) / 2, entries: {} };
  });
  // d_reg: 最大非正 chamber midpoint, normalize 到 [-π, π) (跟 v5 spec
  // project_word_path_v5_spec.md 一致). 用来填 _v5.d_reg, 让前端切 n 之后 d
  // 跟着新 dataset 的 d_reg 走, 不退回到 -π/2 fallback.
  const dRegs = chambers
    .map(c => {
      let x = c.d;
      while (x >= Math.PI) x -= TP;
      while (x < -Math.PI) x += TP;
      return x;
    })
    .filter(x => x <= 0);
  const dReg = dRegs.length > 0 ? Math.max(...dRegs) : -Math.PI / 2;
  return {
    punctures,
    A_diag,
    A_diag_block,
    A_off,
    m_sizes,
    rays,
    chambers,
    _algorithm: 'cpn-synth-client',
    _v5: { d_reg: dReg },
  } as SimpleDataset;
}

export async function loadDataset(): Promise<SimpleDataset> {
  // BASE_URL: GH Pages = "/Stokes-Matrix/", 本地 dev = "/". cache-bust v= 强制每次拉新.
  // Dataset 是 GH Pages 上的 static JSON, 不走 backend tunnel.
  const key = getDatasetKey();
  if (key === 'cpn') return synthCpnDataset(getCpnN());
  const entry = DATASET_REGISTRY.find(d => d.key === key) ?? DATASET_REGISTRY[0];
  const url = `${import.meta.env.BASE_URL}data/${entry.file}.json?v=${Date.now()}`.replace(/([^:])\/+/g, '$1/');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load dataset: ${r.status}`);
  return r.json();
}

/** 重新合成 cpn dataset (用于左侧 n 输入变化后客户端就地重建, 不重载页面). */
export function rebuildCpnDataset(n: number): SimpleDataset {
  return synthCpnDataset(n);
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

// ---------- ISC (inverse symbolic computation) ----------

export interface IscCandidate {
  axis: string;          // 'Re' | 'Im' | '|z|' | 'arg/π'
  value: number;         // 通道数值 (浮点)
  engine: 'simple' | 'ries' | 'wolfram';
  form: string;          // 候选表达式 (值或方程, 视 kind)
  raw_form?: string;     // RIES 原始方程 (kind=ries-value 时存); 调试用
  err_abs: number | null;
  // kind 决定 form 能否当值表达式塞回 cell:
  //   integer / rational / sqrt / pi-rational / ries-value / wolfram = 值
  //   ries-equation = 方程, cell 渲染时跳过
  kind?: 'integer' | 'rational' | 'sqrt' | 'pi-rational' | 'ries-value' | 'ries-equation' | 'wolfram';
}

/** ISC 候选的 form 是否可作为值表达式 (而非方程) 直接喂给 expr-parser. */
export function iscIsValueForm(c: IscCandidate): boolean {
  return c.kind !== 'ries-equation';
}

export interface IscResponse {
  candidates: IscCandidate[];
  engines_available: { ries: boolean; wolfram: boolean };
}

export async function iscQuery(re: number, im: number,
                                channels?: string[], engines?: string[]): Promise<IscResponse> {
  const body: any = { re, im };
  if (channels) body.channels = channels;
  if (engines) body.engines = engines;
  const r = await fetch(apiUrl('/api/isc'), {
    method: 'POST',
    headers: defaultHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`ISC ${r.status}: ${await r.text()}`);
  return r.json();
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
