// 数据契约: 跟 60-outputs/sd-viz/data/n4_simple.json schema 对齐.

// expr: 用户在 expression 模式下输入的原文 (如 "e^(i*pi/3) + 1/sqrt(5)"),
// 切回 pair 模式或编辑 re/im 后清空. re/im 始终是 expr 求值后的浮点缓存.
export interface ComplexNum { re: number; im: number; expr?: string; }

export interface Puncture { re: number; im: number; expr?: string; }

// A_off entry: (i, j) 是块下标; (a, b) sub-index 在 block case 时存在,
// simple case (m_k=1) 时省略 → 默认 (0, 0).
export interface AOff {
  i: number; j: number;
  a?: number; b?: number;
  re: number; im: number;
  expr?: string;
}

export interface SdEntryData {
  value_re?: number;            // block[0,0] 显示用 scalar (向后兼容 simple-case 老 schema).
  value_im?: number;
  value_block?: ComplexNum[][]; // 完整 m_i × m_j block (block case 必有, simple 也存 1×1).
  m_i?: number;
  m_j?: number;
  path?: ComplexNum[] | null;
  tau_code?: number;
  theta_t_lift?: number;
  provenance?: string;
  v5_chamber_index?: number;
  v5_lift_m?: number;
  error?: string;
}

export interface V5EgEntryData extends SdEntryData {
  value_block: ComplexNum[][];
  tau_lift: number;
  v5_labels?: number[];
  sigma_geom?: string;
  word_string?: string | null;
  confidence?: number | null;
  romberg_increment_rel?: number | null;
}

export interface ChamberData {
  d: number;                     // chamber sample d (rad). SSOT: 在 ℝ 上单调递增, 落在
                                 // (rays[0], rays[0]+2π) 内. 不 mod 2π. viz 显示用
                                 // m=round((d_user-d_sample)/2π) 乘 monodromy phase 修正.
  entries: { [key: string]: SdEntryData };  // key = "i,j"
}

export interface SimpleDataset {
  punctures: Puncture[];
  A_diag: number[];              // n 个标量 (每块 [0,0] 谱). 兼容老 schema.
  A_diag_block?: number[][];     // 块版: n × m_k 谱矩阵 (块 k 对角的 m_k 个值).
  A_off: AOff[];
  m_sizes: number[];
  rays: number[];
  chambers: ChamberData[];
  _algorithm?: string;
  _v5?: unknown;
  _v5_eg_entries?: { [key: string]: V5EgEntryData };
  _cache_stats?: unknown;
}

// ---------- 前端运行时状态 ----------

export interface PathRep {
  // 显示出来的几何代表元 — vertices (含起点 u_i, 终点 u_j)
  i: number;                     // block 起点
  j: number;                     // block 终点
  vertices: ComplexNum[];        // dataset.path 原样: [u_i, ...waypoints, u_target, u_j]
  homotopyId: string;
}

export interface VizState {
  dataset: SimpleDataset;
  selectedChamber: number;       // chambers[].索引
  selectedEntry: [number, number] | null; // (i, j)
  paths: Map<string, PathRep>;   // 当前 displayed paths, key = "i,j"
  punctureOverrides: Puncture[] | null; // 用户拖动 / U 表后的值 (null = 默认)
  AOverrides: ComplexNum[][] | null;     // 用户编辑后的 A (N×N 复矩阵, N = sum m_k)
  mOverrides: number[] | null;           // 用户编辑后的 m_k 重数
  stokesStale: boolean;                  // A/U/m 改了 Stokes 数值还没重算
  exampleAwaitingCompute: boolean;       // example dataset 加载后未点 Compute / 未编辑前 true; banner 文案分支用
  sdView: SdView;                        // S_d 矩阵右栏当前显示模式
  omegaView: OmegaView;                  // Ω_d 矩阵右栏当前显示模式
  /** Ω/Ω^-1 选中的 cell (I, J). 跟 selectedEntry 完全独立 (SSOT 解耦).
   *  一次点击代表一条 path; 视图决定高亮哪个轴:
   *    Ω 视图: 按行算 ⇒ 高亮第 I 行块.
   *    Ω^-1 视图: 按列算 ⇒ 高亮第 J 列块.
   *  切视图时不清除, 同一 path 在两个视图分别看见对应行 / 列高亮. */
  selectedOmegaBlock: [number, number] | null;
}

/** 右栏 stokes-matrix 显示模式. -d 方向 label 排序定义 S_d^± entrywise:
 *  label[k] = rank descending of Im(u_k · e^{i·d}) (1-based). label 最小 = -d 方向最"左".
 *  对 i≠j: S_d^+_{ij} = S_d_{ij} 若 label[i]<label[j], 否则 0.
 *          S_d^-_{ij} = -S_d_{ij} 若 label[i]>label[j], 否则 0.
 *  对角块: S_d^+ = S_d^- = I_block (displayed S_d 对角约定为 0, 故 0 = 1 - 1 自洽,
 *  off-diag 逐 entry 也满足 S_d = S_d^+ - S_d^-). */
export type SdView = 'std' | 'plus' | 'minus' | 'eg';

/** Ω_d 中心连接矩阵显示模式. 算法待实现, 目前只占位 UI. */
export type OmegaView = 'omega' | 'omega-inv';
