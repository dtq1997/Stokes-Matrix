// 数据契约: 跟 60-outputs/sd-viz/data/n4_simple.json schema 对齐.

export interface ComplexNum { re: number; im: number; }

export interface Puncture { re: number; im: number; }

export interface AOff { i: number; j: number; re: number; im: number; }

export interface SdEntryData {
  value_re?: number;
  value_im?: number;
  path?: ComplexNum[];          // waypoints, 含起点 u_i, 终点 u_target ≈ u_j
  tau_code?: number;
  theta_t_lift?: number;
  error?: string;
}

export interface ChamberData {
  d: number;                     // 代表方向 (rad, [0, 2π))
  entries: { [key: string]: SdEntryData };  // key = "i,j"
}

export interface SimpleDataset {
  punctures: Puncture[];
  A_diag: number[];
  A_off: AOff[];
  m_sizes: number[];
  rays: number[];                // anti-Stokes rays + πℤ, sorted [0, 2π)
  chambers: ChamberData[];
}

// ---------- 前端运行时状态 ----------

export interface PathRep {
  // 显示出来的几何代表元 — vertices (含起点终点)
  i: number;                     // block 起点
  j: number;                     // block 终点
  vertices: ComplexNum[];        // [u_i, ...waypoints, u_target]
  // 同伦类不变量 (此期 = i, j, chamber_idx, lift)
  homotopyId: string;
  liftIndex: number;             // 端点 lift 整数 (跨 cut 时 ±1)
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
}
