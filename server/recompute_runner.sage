"""Recompute runner: 命令行参数 input.json + output.json.

Input schema:
  {"punctures": [{"re": float, "im": float}, ...],
   "A":         [[{"re": float, "im": float}, ...], ...],   # N×N
   "m_sizes":   [int, ...]}

Output schema: SimpleDataset (跟 web/src/lib/types.ts 对齐).
调用: sage server/recompute_runner.sage input.json output.json
块版 (m_k>1): A_diag_block + A_off (带 a/b 字段) 通过 dataset_builder.pack_A_metadata
打包, 跟 export_n4_block.sage 走同一 SSOT.
"""
import os, sys, json, time, builtins
py_int = builtins.int     # sage preparser 把 int() 替换成 Integer

_WS = "/Users/dtq1997/ai/workspace/academic-formula-workbench"
sys.path.insert(0, os.path.join(_WS, "50-computation"))
sys.path.insert(0, os.path.join(_WS, "60-outputs/sd-viz/server"))

from sage.all import matrix, ComplexField
from sd_chamber_geom import anti_stokes_rays, chamber_midpoints  # SSOT

load(os.path.join(_WS, "50-computation/compute_Sd_entry.sage"))
load(os.path.join(_WS, "60-outputs/sd-viz/server/dataset_builder.sage"))


def recompute(inp):
    punctures = inp['punctures']
    A_in = inp['A']
    m_sizes = list(inp['m_sizes'])
    precision = inp.get('precision', 'medium')  # 'low' | 'medium' | 'high'
    algorithm = inp.get('algorithm', os.environ.get('SD_ALGORITHM', 'v5_full'))
    n = len(punctures)
    N = sum(m_sizes)
    if N != len(A_in):
        raise ValueError(f"A 维度 {len(A_in)} != N={N}")

    U_list = [complex(p['re'], p['im']) for p in punctures]

    CC = ComplexField(200)
    A_global = matrix(CC, N, N)
    for i_ in range(N):
        for j_ in range(N):
            v = A_in[i_][j_]
            A_global[i_, j_] = CC(float(v['re']), float(v['im']))

    # SSOT: A_diag / A_diag_block / A_off (含块内 off-diag + a/b 字段) 全部走
    # dataset_builder.pack_A_metadata, 跟 export_n4_block 同一逻辑. 不要在这重复.
    A_meta = pack_A_metadata(A_global, m_sizes)

    rays = anti_stokes_rays(U_list)
    chambers = chamber_midpoints(rays)

    def _progress(ch_idx, n_ch, d, _so_far):
        # push_server 监 stdout 转 SSE
        print(f"PROGRESS chamber {ch_idx+1}/{n_ch} d={d:.4f}", flush=True)

    t0 = time.time()
    chambers_out, stats = build_chambers(
        U_list, A_global, m_sizes, chambers,
        precision=precision, verbose=False, use_cache=True,
        algorithm=algorithm,
        progress=_progress,
    )
    total = stats['hits'] + stats['miss']
    rate = (100.0 * stats['hits'] / total) if total else 0
    print(f"DONE elapsed={time.time()-t0:.1f}s cache_hit={stats['hits']}/{total} ({rate:.0f}%)", flush=True)

    out = {
        'punctures': [{'re': float(u.real), 'im': float(u.imag)} for u in U_list],
        'A_diag': A_meta['A_diag'],
        'A_diag_block': A_meta['A_diag_block'],
        'A_off': A_meta['A_off'],
        'm_sizes': m_sizes,
        'rays': [float(x) for x in rays],
        'chambers': chambers_out,
        '_algorithm': stats.get('algorithm', algorithm),
        '_cache_stats': stats,
    }
    if 'v5' in stats:
        out['_v5'] = stats['v5']
    return out


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print("usage: sage recompute_runner.sage input.json output.json", file=sys.stderr)
        sys.exit(2)
    with open(sys.argv[1]) as f:
        inp = json.load(f)
    out = recompute(inp)
    with open(sys.argv[2], 'w') as f:
        json.dump(out, f)
