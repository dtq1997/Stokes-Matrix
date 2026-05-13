"""Sd-viz CP^d 经典例子 static data exporter.

输出: cp{d}.json — Guzzetti X gauge 下 QH*(CP^d) 的 U/A/Stokes 数据.
- U = k·ζ_k^n  (n=0..d, k=d+1)
- V = X^{-1} μ̂ X, X[j,n] = ζ_{2k}^{(2j+1)n}/√k, μ̂ = diag((k-1-2i)/2)
- m_sizes = [1]*k, simple spectrum.

调用:
    SD_CP_D=2 sage 60-outputs/sd-viz/data/export_cpn.sage
    SD_CP_D=3 sage 60-outputs/sd-viz/data/export_cpn.sage
    SD_CP_D=4 SD_PRECISION=high sage 60-outputs/sd-viz/data/export_cpn.sage
"""
import os, sys, math, json, time

_WS = "/Users/dtq1997/ai/workspace/academic-formula-workbench"
sys.path.insert(0, os.path.join(_WS, "50-computation"))
sys.path.insert(0, os.path.join(_WS, "60-outputs/sd-viz/server"))

from sage.all import matrix, ComplexField, QQbar, QQ
from sd_chamber_geom import anti_stokes_rays, chamber_midpoints

load(os.path.join(_WS, "50-computation/compute_Sd_entry.sage"))
load(os.path.join(_WS, "60-outputs/sd-viz/server/dataset_builder.sage"))


D_CP = int(os.environ.get('SD_CP_D', '2'))
K = D_CP + 1
PRECISION = os.environ.get('SD_PRECISION', 'medium')
ALGORITHM = os.environ.get('SD_ALGORITHM', 'v5_full')

# ---------- CP^d Guzzetti X gauge ----------
zeta_k = QQbar.zeta(K)
zeta_2k = QQbar.zeta(2 * K)
U_qq = [QQbar(K) * zeta_k**n for n in range(K)]
Xmat = matrix(QQbar, K, K)
for j in range(K):
    for n in range(K):
        Xmat[j, n] = zeta_2k**((2*j + 1) * n) / QQbar(K).sqrt()
mu_diag = [QQ((K - 1 - 2*i, 2)) for i in range(K)]
mu_hat = matrix(QQbar, K, K, lambda i, j: QQbar(mu_diag[i]) if i == j else QQbar(0))
V_qq = Xmat.inverse() * mu_hat * Xmat

# 数值化为 ComplexField 给 build_chambers
CC = ComplexField(80)
U_list = [complex(u) for u in U_qq]
A_global = matrix(CC, K, K)
for i in range(K):
    for j in range(K):
        A_global[i, j] = CC(V_qq[i, j])

m_sizes = [1] * K
rays = anti_stokes_rays(U_list)
chambers = chamber_midpoints(rays)
print(f"CP^{D_CP}: k={K}, rays={len(rays)}, chambers={len(chambers)}")
print(f"precision={PRECISION}, algorithm={ALGORITHM}")

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
    os.path.join(_WS, f"60-outputs/sd-viz/data/cp{D_CP}.json"),
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

with open(OUT, 'w') as f:
    json.dump(results, f, indent=2)
print(f"CP^{D_CP} 总耗时 {time.time()-t0:.1f}s, 输出: {OUT}")
