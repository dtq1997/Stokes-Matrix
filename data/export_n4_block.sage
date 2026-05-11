"""Sd-viz n=4 block case (m=(2,2,2,2)) static data exporter.

输出: n4_block.json — punctures, A (8×8), anti-Stokes rays, all chambers entries,
每 entry 含 value_block (m_i × m_j 复数矩阵).

调用: sage 60-outputs/sd-viz/data/export_n4_block.sage
精度: SD_PRECISION=medium (默认), 12 chambers × 12 entries ≈ 60s.
"""
import os, sys, math, json, time, builtins
_py_int = builtins.int  # sage preparser 把 int() 替换成 Integer, JSON 不能 serialize

_WS = "/Users/dtq1997/ai/workspace/academic-formula-workbench"
sys.path.insert(0, os.path.join(_WS, "50-computation"))
sys.path.insert(0, os.path.join(_WS, "60-outputs/sd-viz/server"))

from sage.all import matrix, ComplexField
from sd_chamber_geom import anti_stokes_rays, chamber_midpoints

load(os.path.join(_WS, "50-computation/compute_Sd_entry.sage"))
load(os.path.join(_WS, "60-outputs/sd-viz/server/dataset_builder.sage"))


# ---------- n=4 block case (m_k=2 全部) ----------
# 块结构: 每块 m_k=2, 共 4 块, N=8. U_k 在该块对角重复 2 次.
U_list = [complex(0.0, 0.0),
          complex(2.5, 0.4),
          complex(1.6, 1.8),
          complex(-0.6, 1.3)]

m_sizes = [2, 2, 2, 2]
N = sum(m_sizes)  # 8

# A 块对角: 每块 m_k×m_k = 2×2, 取 diag(a_k1, a_k2), 谱小幅分离避退化.
A_diag_block = [
    [0.10, 0.11],
    [0.17, 0.19],
    [0.22, 0.23],
    [0.31, 0.33],
]

# 块对角内 off-diag (块 (k,k) 的 (0,1) 跟 (1,0) entry, 让 A_kk 不是对角).
# 控制 |.| 在 ~0.1 内避谱 degenerate.
A_kk_off = [
    (0.05, 0.02),    # 块 0 的 (0,1) 跟 (1,0) entry, 复值
    (0.04, -0.03),
    (0.06, 0.01),
    (0.05, -0.04),
]

# 跨块 off-diag: 块 (I, J) I≠J 的 m_I × m_J 矩阵, 量级 0.3 内防 ODE stiff.
# 用 fixed seed 让 dataset 可复现.
import numpy as np
np.random.seed(42)
A_offblock = {}
for I in range(4):
    for J in range(4):
        if I == J: continue
        # 2×2 复矩阵, real + imag iid normal × 0.2
        blk = 0.2 * (np.random.randn(2, 2) + 1j * np.random.randn(2, 2))
        A_offblock[(I, J)] = blk

CC = ComplexField(80)
A_global = matrix(CC, N, N)
starts = [0, 2, 4, 6]
# 装对角块
for k in range(4):
    s = starts[k]
    A_global[s, s] = CC(A_diag_block[k][0])
    A_global[s+1, s+1] = CC(A_diag_block[k][1])
    A_global[s, s+1] = CC(A_kk_off[k][0], A_kk_off[k][1])
    A_global[s+1, s] = CC(A_kk_off[k][0], -A_kk_off[k][1])  # 共轭 (Hermitian-like 但不强求)
# 装非对角块
for (I, J), blk in A_offblock.items():
    sI, sJ = starts[I], starts[J]
    for a in range(2):
        for b in range(2):
            A_global[sI+a, sJ+b] = CC(blk[a, b].real, blk[a, b].imag)

rays = anti_stokes_rays(U_list)
chambers = chamber_midpoints(rays)
print(f"n=4 m=(2,2,2,2) → N={N}, rays={len(rays)}, chambers={len(chambers)}")

# A 元数据 (A_diag / A_diag_block / A_off 含 a/b) 走 SSOT pack_A_metadata,
# 跟 recompute_runner.sage 同一逻辑. 不要在这里手写打包.
A_meta = pack_A_metadata(A_global, m_sizes)
results = {
    'punctures': [{'re': float(u.real), 'im': float(u.imag)} for u in U_list],
    'm_sizes': [_py_int(m) for m in m_sizes],
    'A_diag': A_meta['A_diag'],
    'A_diag_block': A_meta['A_diag_block'],
    'A_off': A_meta['A_off'],
    'rays': [float(x) for x in rays],
    'chambers': [],
}

OUT = os.environ.get(
    'SD_OUT',
    os.path.join(_WS, "60-outputs/sd-viz/data/n4_block.json"),
)
PRECISION = os.environ.get('SD_PRECISION', 'medium')
ALGORITHM = os.environ.get('SD_ALGORITHM', 'v5_full')
print(f"precision = {PRECISION}")
print(f"algorithm = {ALGORITHM}")


def _progress(ch_idx, n_ch, d, chambers_so_far):
    results['chambers'] = chambers_so_far
    try:
        with open(OUT, 'w') as f:
            json.dump(results, f, indent=2)
        print(f"  saved {ch_idx+1}/{n_ch} d={d:+.4f}")
    except Exception as e:
        print(f"  [save FAILED: {e}]")


def _on_entry(ch_idx, i, j, entry):
    if 'error' in entry:
        print(f"  ch{ch_idx+1} ({i},{j}): FAIL — {entry['error']}")


t0 = time.time()
chambers_out, _stats = build_chambers(
    U_list, A_global, m_sizes, chambers,
    precision=PRECISION, verbose=False, use_cache=False,
    algorithm=ALGORITHM,
    progress=_progress, on_entry=_on_entry,
)
results['chambers'] = chambers_out
results['_algorithm'] = _stats.get('algorithm', ALGORITHM)
results['_cache_stats'] = _stats
if 'v5' in _stats:
    results['_v5'] = _stats['v5']
with open(OUT, 'w') as f:
    json.dump(results, f, indent=2)
print(f"总耗时 {time.time()-t0:.1f}s, 输出: {OUT}")
