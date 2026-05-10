"""Recompute runner: 命令行参数 input.json + output.json.

Input schema:
  {"punctures": [{"re": float, "im": float}, ...],
   "A":         [[{"re": float, "im": float}, ...], ...],   # N×N
   "m_sizes":   [int, ...]}

Output schema: SimpleDataset (跟 web/src/lib/types.ts 对齐).
调用: sage server/recompute_runner.sage input.json output.json
注意: 当前 simple-spectrum (m_k=1) 才稳; 块版 TODO.
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
    n = len(punctures)
    N = sum(m_sizes)
    if N != len(A_in):
        raise ValueError(f"A 维度 {len(A_in)} != N={N}")

    U_list = [complex(p['re'], p['im']) for p in punctures]

    # A_diag / A_off (跟 dataset schema 兼容): A_diag 取每块 (k,k) entry,
    # A_off 列出非对角块的非零 entry. 简单谱 m_k=1 时一对一; 块版当前 schema 不支持.
    starts = []
    s = 0
    for m in m_sizes:
        starts.append(s)
        s += m
    A_diag = [float(A_in[starts[I]][starts[I]]['re']) for I in range(n)]
    A_off = []
    for I in range(n):
        for J in range(n):
            if I == J: continue
            si, sj = starts[I], starts[J]
            mi, mj = m_sizes[I], m_sizes[J]
            for a in range(mi):
                for b in range(mj):
                    v = A_in[si+a][sj+b]
                    if v['re'] != 0 or v['im'] != 0:
                        A_off.append({'i': int(I), 'j': int(J),
                                      're': float(v['re']), 'im': float(v['im'])})

    CC = ComplexField(200)
    A_global = matrix(CC, N, N)
    for i_ in range(N):
        for j_ in range(N):
            v = A_in[i_][j_]
            A_global[i_, j_] = CC(float(v['re']), float(v['im']))

    rays = anti_stokes_rays(U_list)
    chambers = chamber_midpoints(rays)

    def _progress(ch_idx, n_ch, d, _so_far):
        # push_server 监 stdout 转 SSE
        print(f"PROGRESS chamber {ch_idx+1}/{n_ch} d={d:.4f}", flush=True)

    t0 = time.time()
    chambers_out, stats = build_chambers(
        U_list, A_global, m_sizes, chambers,
        precision=precision, verbose=False, use_cache=True,
        progress=_progress,
    )
    total = stats['hits'] + stats['miss']
    rate = (100.0 * stats['hits'] / total) if total else 0
    print(f"DONE elapsed={time.time()-t0:.1f}s cache_hit={stats['hits']}/{total} ({rate:.0f}%)", flush=True)

    return {
        'punctures': [{'re': float(u.real), 'im': float(u.imag)} for u in U_list],
        'A_diag': A_diag,
        'A_off': A_off,
        'm_sizes': m_sizes,
        'rays': [float(x) for x in rays],
        'chambers': chambers_out,
        '_cache_stats': stats,
    }


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print("usage: sage recompute_runner.sage input.json output.json", file=sys.stderr)
        sys.exit(2)
    with open(sys.argv[1]) as f:
        inp = json.load(f)
    out = recompute(inp)
    with open(sys.argv[2], 'w') as f:
        json.dump(out, f)
