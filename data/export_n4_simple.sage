"""Sd-viz n=4 simple case static data exporter.

输出: n4_simple.json — punctures, A, anti-Stokes rays, all chambers entries.

调用: sage 60-outputs/sd-viz/data/export_n4_simple.sage
"""
import os, sys, math, json, time

_WS = "/Users/dtq1997/ai/workspace/academic-formula-workbench"
sys.path.insert(0, os.path.join(_WS, "50-computation"))
sys.path.insert(0, os.path.join(_WS, "60-outputs/sd-viz/server"))

from sage.all import matrix, ComplexField
from sd_chamber_geom import anti_stokes_rays, chamber_midpoints  # SSOT

load(os.path.join(_WS, "50-computation/compute_Sd_entry.sage"))
load(os.path.join(_WS, "60-outputs/sd-viz/server/dataset_builder.sage"))


# ---------- n=4 simple case 固定数据 ----------
U_list = [complex(0.0, 0.0),
          complex(2.5, 0.4),
          complex(1.6, 1.8),
          complex(-0.6, 1.3)]

A_diag = [0.10, 0.17, 0.22, 0.31]
A_off = [
    (0, 1, 0.5, 0.1), (0, 2, 0.4, -0.2), (0, 3, 0.6, 0.3),
    (1, 0, 0.3, -0.1), (1, 2, 0.5, 0.4), (1, 3, 0.4, -0.2),
    (2, 0, 0.6, 0.2), (2, 1, 0.3, -0.3), (2, 3, 0.5, 0.1),
    (3, 0, 0.4, -0.4), (3, 1, 0.5, 0.2), (3, 2, 0.3, -0.1),
]

n = 4
m_sizes = [1, 1, 1, 1]
N = sum(m_sizes)
CC = ComplexField(80)
A_global = matrix(CC, N, N)
for i in range(n):
    A_global[i, i] = CC(A_diag[i])
for (i, j, re, im) in A_off:
    A_global[i, j] = CC(re, im)

rays = anti_stokes_rays(U_list)
chambers = chamber_midpoints(rays)
print(f"rays: {len(rays)}, chambers: {len(chambers)}")

# A 元数据走 SSOT pack_A_metadata, 跟 recompute_runner / export_n4_block 同一打包逻辑.
# simple case m_k=1, A_off entry 也带 a=0/b=0 字段 (viz e.a??0 兼容).
A_meta = pack_A_metadata(A_global, m_sizes)
results = {
    'punctures': [{'re': float(u.real), 'im': float(u.imag)} for u in U_list],
    'A_diag': A_meta['A_diag'],
    'A_diag_block': A_meta['A_diag_block'],
    'A_off': A_meta['A_off'],
    'm_sizes': [int(x) for x in m_sizes],
    'rays': [float(x) for x in rays],
    'chambers': [],
}

OUT = os.environ.get(
    'SD_OUT',
    os.path.join(_WS, "60-outputs/sd-viz/data/n4_simple.json"),
)


def _progress(ch_idx, n_ch, d, chambers_so_far):
    results['chambers'] = chambers_so_far
    try:
        with open(OUT, 'w') as f:
            json.dump(results, f, indent=2)
        print(f"  saved {ch_idx+1}/{n_ch}  d={d:+.4f}")
    except Exception as e:
        print(f"  [save FAILED: {e}]")


def _on_entry(ch_idx, i, j, entry):
    if 'error' in entry:
        print(f"  ch{ch_idx+1} ({i},{j}): FAIL — {entry['error']}")


t0 = time.time()
PRECISION = os.environ.get('SD_PRECISION', 'medium')  # low / medium / high
ALGORITHM = os.environ.get('SD_ALGORITHM', 'v5_full')
print(f"precision = {PRECISION}")
print(f"algorithm = {ALGORITHM}")

chambers_out, _stats = build_chambers(
    U_list, A_global, m_sizes, chambers,
    precision=PRECISION, verbose=False, use_cache=False,
    algorithm=ALGORITHM,
    progress=_progress, on_entry=_on_entry,
)
results['chambers'] = chambers_out
results['_algorithm'] = _stats.get('algorithm', ALGORITHM)
results['_cache_stats'] = {k: v for k, v in _stats.items() if k != 'v5_eg_entries'}
if 'v5' in _stats:
    results['_v5'] = _stats['v5']
if 'v5_eg_entries' in _stats:
    results['_v5_eg_entries'] = _stats['v5_eg_entries']
# 最终保存
with open(OUT, 'w') as f:
    json.dump(results, f, indent=2)
print(f"总耗时 {time.time()-t0:.1f}s, 输出: {OUT}")
