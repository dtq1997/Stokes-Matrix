// 数据契约: 跟 60-outputs/sd-viz/data/n4_simple.json schema 对齐.

export interface ComplexNum { re: number; im: number; }

export interface Puncture { re: number; im: number; }

// A_off entry: (i, j) 是块下标; (a, b) sub-index 在 block case 时存在,
// simple case (m_k=1) 时省略 → 默认 (0, 0).
export interface AOff {
  i: number; j: number;
  a?: number; b?: number;
  re: number; im: number;
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
  sdView: SdView;                        // S_d 矩阵右栏当前显示模式
}

/** 右栏 stokes-matrix 显示模式. -d 方向 label 排序定义 S_d^± entrywise:
 *  label[k] = rank descending of Im(u_k · e^{i·d}) (1-based). label 最小 = -d 方向最"左".
 *  对 i≠j: S_d^+_{ij} = S_d_{ij} 若 label[i]<label[j], 否则 0.
 *          S_d^-_{ij} = -S_d_{ij} 若 label[i]>label[j], 否则 0.
 *  对角块: S_d^+ = I_block, S_d^- = 0; 故 S_d = S_d^+ - S_d^- (formal grading 下 S_d 对角 = I). */
export type SdView = 'std' | 'plus' | 'minus';
