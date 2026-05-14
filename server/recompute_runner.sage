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
import os, sys, json, time, builtins, resource
py_int = builtins.int     # sage preparser 把 int() 替换成 Integer

# Phase 0 profiling: 模块加载耗时 (sage core import + load() 调用), Phase 1 持久
# worker 之后这段每次只付一次, 现在每次 recompute 都付. baseline 实测用.
_t_module_load_start = time.time()

_WS = "/Users/dtq1997/ai/workspace/academic-formula-workbench"
sys.path.insert(0, os.path.join(_WS, "50-computation"))
sys.path.insert(0, os.path.join(_WS, "60-outputs/sd-viz/server"))

from sage.all import matrix, ComplexField
from sd_chamber_geom import anti_stokes_rays, chamber_midpoints  # SSOT

load(os.path.join(_WS, "50-computation/compute_Sd_entry.sage"))
load(os.path.join(_WS, "60-outputs/sd-viz/server/dataset_builder.sage"))

_t_module_load_done = time.time()


def _prime_mpmath_caches():
    """Phase 2: 预热 mpmath bernoulli_cache + gamma_stirling_cache.

    多线程并发调 mpmath.gamma 时, 这两个 module-level dict 未填充会触发
    bernfrac() → sage.primes() → PARI nextprime, PARI 单线程不可重入会段错.
    在 module load 后串行 prime 一次, 之后并行只读 cache 命中.

    严格只在第一次 import 后跑; recompute() 多次调用不重复.
    """
    try:
        import mpmath
        old_prec = mpmath.mp.prec
        for prec in (1600, 800, 300):
            mpmath.mp.prec = prec
            _ = mpmath.gamma(mpmath.mpc(1.5, 0.5))
            _ = mpmath.gamma(mpmath.mpf(2.5))
        mpmath.mp.prec = old_prec
        return True
    except Exception as e:
        print(f"WARN: mpmath cache prime failed: {e}", flush=True)
        return False


_prime_mpmath_caches()


def _get_rss_mb():
    """峰值 RSS in MB. macOS ru_maxrss=bytes, linux=KB.
    sage preparser 会把 1024 当 Integer, 用 float() 兜底确保返回 python float."""
    r = float(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    return (r / 1048576.0) if r > 1e8 else (r / 1024.0)


def recompute(inp):
    _t_recompute_start = time.time()
    # Phase 0: cold-start 拆解. module_load_s = sage core import + load();
    # cold_total_s = sage 进程启动到 recompute() 入口 (含 module_load).
    print(f"STAGE profile-cold|module_load_s={_t_module_load_done - _t_module_load_start:.2f}|cold_total_s={_t_recompute_start - _t_module_load_start:.2f}", flush=True)
    punctures = inp['punctures']
    A_in = inp['A']
    m_sizes = list(inp['m_sizes'])
    precision = inp.get('precision', 'medium')  # 'fast' | 'low' | 'medium' | 'high'
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
    _t_build_done = time.time()
    total = stats['hits'] + stats['miss']
    rate = (100.0 * stats['hits'] / total) if total else 0
    print(f"DONE elapsed={_t_build_done-t0:.1f}s cache_hit={stats['hits']}/{total} ({rate:.0f}%)", flush=True)
    # Phase 0: 总览
    print(f"STAGE profile-summary|recompute_s={time.time()-_t_recompute_start:.2f}|build_chambers_s={_t_build_done-t0:.2f}|peak_rss_mb={_get_rss_mb():.0f}|algorithm={algorithm}|precision={precision}|n_punctures={n}|N={N}", flush=True)

    out = {
        'punctures': [{'re': float(u.real), 'im': float(u.imag)} for u in U_list],
        'A_diag': A_meta['A_diag'],
        'A_diag_block': A_meta['A_diag_block'],
        'A_off': A_meta['A_off'],
        'm_sizes': m_sizes,
        'rays': [float(x) for x in rays],
        'chambers': chambers_out,
        '_algorithm': stats.get('algorithm', algorithm),
        '_cache_stats': {k: v for k, v in stats.items() if k != 'v5_eg_entries'},
    }
    if 'v5' in stats:
        out['_v5'] = stats['v5']
    if 'v5_eg_entries' in stats:
        out['_v5_eg_entries'] = stats['v5_eg_entries']
    return out


# CLI 模式: argv = [script, input.json, output.json]. 当 worker_loop.sage 通过
# load() 引入本模块时, __name__ 也是 '__main__' 但 argv 不是这个形状, 必须 gate
# on argv len 否则会误触发 CLI 路径报 usage exit.
if __name__ == '__main__' and len(sys.argv) == 3:
    with open(sys.argv[1]) as f:
        inp = json.load(f)
    out = recompute(inp)
    with open(sys.argv[2], 'w') as f:
        json.dump(out, f)
