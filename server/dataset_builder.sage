"""SSOT: 单 chamber × 所有 entry 的 dataset 装载逻辑共享.

Used by:
- 60-outputs/sd-viz/data/export_n4_simple.sage
- 60-outputs/sd-viz/data/export_n4_block.sage
- 60-outputs/sd-viz/server/recompute_runner.sage

调用方负责: U_list, A_global (sage matrix), m_sizes, chambers (sample d list).
可选 cache_homotopy: 同 homotopy signature 跨 chamber 复用 entry value 省重算.

display_path = algo_full + [u_j]: algo_full = [u_i] + algo_wp (含 u_target ≈ u_j),
末段补 u_j 表 ε→0 极限. viz 显示用. 数值不依赖这个末段 (算法 push 走 u_target).
"""
import os
import sys
import time
import math
import builtins
_py_int = builtins.int  # sage preparser 把 int() 换 Integer, 用 builtins 绕开

_WS = "/Users/dtq1997/ai/workspace/academic-formula-workbench"
sys.path.insert(0, os.path.join(_WS, "50-computation"))

load(os.path.join(_WS, "50-computation/compute_sd_v5_full.sage"))


def pack_path(waypoints):
    return [{'re': float(p.real), 'im': float(p.imag)} for p in waypoints]


def pack_A_metadata(A_global, m_sizes):
    """SSOT: 把 N×N A_global (sage matrix 或 nested complex list) 打包成
    viz dataset schema 的 {A_diag, A_diag_block, A_off}.

    - A_diag_block: list of n lists, 块 k 给 m_k 个对角谱 (块 (k,k) sub 对角 Re).
    - A_diag: list of n scalars, 兼容老 simple-case schema, 取每块 [0,0] re.
    - A_off: list of {i, j, a, b, re, im} entries (含 i==j 但 a!=b 的块内 off-diag).
      A_off 永远带 a/b 字段, viz rebuildInitialA 要 (e.a ?? 0).

    避免 SSOT 漂移: 任何重新生成 dataset 的脚本 (export/recompute_runner) 都该
    调这一个函数, 不要自己手写打包.
    """
    n = len(m_sizes)
    starts = []
    s = 0
    for m in m_sizes:
        starts.append(s)
        s += m

    def _get(i, j):
        """统一取 (i,j) entry 的 (re, im), 兼容 sage matrix / nested list."""
        v = A_global[i, j] if hasattr(A_global, 'nrows') else A_global[i][j]
        if isinstance(v, dict):
            return float(v['re']), float(v['im'])
        c = complex(v)
        return float(c.real), float(c.imag)

    A_diag_block = []
    for k in range(n):
        sk = starts[k]; mk = m_sizes[k]
        A_diag_block.append([_get(sk + a, sk + a)[0] for a in range(mk)])
    A_diag = [A_diag_block[k][0] for k in range(n)]

    A_off = []
    for I in range(n):
        for J in range(n):
            sI = starts[I]; sJ = starts[J]
            mi = m_sizes[I]; mj = m_sizes[J]
            for a in range(mi):
                for b in range(mj):
                    # 跳过块对角 (I=J, a=b) — 谱已在 A_diag_block.
                    if I == J and a == b: continue
                    re, im = _get(sI + a, sJ + b)
                    if abs(re) < 1e-12 and abs(im) < 1e-12: continue
                    A_off.append({
                        'i': _py_int(I), 'j': _py_int(J),
                        'a': _py_int(a), 'b': _py_int(b),
                        're': re, 'im': im,
                    })
    return {
        'A_diag': A_diag,
        'A_diag_block': A_diag_block,
        'A_off': A_off,
    }


def _winding_around(path_pts, u_k, eps=1e-9):
    total = 0.0
    twopi = 2 * math.pi
    for q in range(len(path_pts) - 1):
        a = path_pts[q] - u_k
        b = path_pts[q + 1] - u_k
        if abs(a) < eps or abs(b) < eps:
            continue
        diff = math.atan2(b.imag, b.real) - math.atan2(a.imag, a.real)
        if diff > math.pi: diff -= twopi
        elif diff < -math.pi: diff += twopi
        total += diff
    return _py_int(round(total / twopi))


def _homotopy_signature(path_pts, U_all, i, j, lift_s, lift_t):
    """两条 path 同 sig ⇒ 同伦 + 同 lift ⇒ S entry 相同."""
    windings = []
    for k in range(len(U_all)):
        if k == i or k == j: continue
        windings.append(_winding_around(path_pts, U_all[k]))
    return (_py_int(i), _py_int(j), tuple(windings),
            _py_int(round(lift_s / math.pi * 2)),
            _py_int(round(lift_t / math.pi * 2)))


def build_chamber_entry(U_list, A_global, m_sizes, i, j, d,
                         precision='medium', verbose=False, cache=None):
    """算一个 (i, j) entry, 返回 entry dict + cache 状态. caller 负责 try/except.

    precision: 'low' | 'medium' | 'high'. 见 compute_Sd_entry PRECISION_PRESETS.
    cache: 可选 dict {sig → entry_template}, 命中跳过重算只重画 path. None = 不 cache.
    """
    u_i_f = complex(U_list[i])
    u_j_f = complex(U_list[j])
    # legacy_entry path: 强制走 compute_Sd_entry 的 PL push + tq Richardson 实现
    # (compute_Sd_entry 主入口现在默认 use_v5_pipeline=True, 但这里 legacy_entry
    # 需要真正的单 entry isoeq path + algo_wp / theta_t_lift / push_info 字段).
    block, info = compute_Sd_entry(
        U_list, A_global, m_sizes,
        i, j, d, waypoints=None,
        precision=precision, verbose=verbose,
        use_v5_pipeline=False,
    )
    # block: numpy m_i × m_j complex matrix (simple-spectrum 退化 1×1).
    m_i, m_j = info['m_i'], info['m_j']
    value_block = [
        [{'re': float(block[a, b].real), 'im': float(block[a, b].imag)}
         for b in range(m_j)]
        for a in range(m_i)
    ]
    # value_re/value_im 默认显示 [0,0] entry (simple-spectrum 即 scalar 值, 兼容老 schema).
    v00 = block[0, 0]
    algo_full = [u_i_f] + list(info['algo_wp'])
    display_path = list(algo_full) + [u_j_f]
    theta_t = info['theta_t_lift']
    theta_s = -d
    entry = {
        'value_re': float(v00.real),
        'value_im': float(v00.imag),
        'value_block': value_block,
        'm_i': _py_int(m_i),
        'm_j': _py_int(m_j),
        'path': pack_path(display_path),
        'tau_code': float(info['tau_code']),
        'theta_t_lift': float(theta_t),
    }
    cache_status = 'miss'
    if cache is not None:
        sig = _homotopy_signature(algo_full, U_list, i, j, theta_s, theta_t)
        if sig in cache:
            cached = cache[sig]
            entry['value_re'] = cached['value_re']
            entry['value_im'] = cached['value_im']
            entry['value_block'] = cached['value_block']
            entry['_cache'] = 'hit'
            cache_status = 'hit'
        else:
            cache[sig] = {
                'value_re': entry['value_re'],
                'value_im': entry['value_im'],
                'value_block': entry['value_block'],
            }
    return entry, cache_status


def _pack_value_block(block, m_i, m_j):
    return [
        [{'re': float(block[a, b].real), 'im': float(block[a, b].imag)}
         for b in range(m_j)]
        for a in range(m_i)
    ]


def _entry_from_block(block, m_i, m_j, provenance, extra=None):
    value_block = _pack_value_block(block, m_i, m_j)
    v00 = block[0, 0]
    entry = {
        'value_re': float(v00.real),
        'value_im': float(v00.imag),
        'value_block': value_block,
        'm_i': _py_int(m_i),
        'm_j': _py_int(m_j),
        'path': None,
        'provenance': provenance,
    }
    if extra:
        entry.update(extra)
    return entry


def _v5_metadata_for_dataset(info_v5, kwargs, precompute_seconds):
    return {
        'd_reg': float(info_v5['d_reg_info']['d_reg']),
        'base_chamber_index': _py_int(info_v5['base_chamber_index']),
        'p1': _py_int(kwargs.get('p1')),
        'p2': _py_int(kwargs.get('p2')) if kwargs.get('p2') is not None else None,
        'backend': kwargs.get('backend'),
        'safety_factor': float(info_v5['d_reg_info'].get('safety_factor')),
        'detour_factor': float(info_v5['d_reg_info'].get('detour_factor')),
        'residual_max': float(info_v5['d_reg_info']['residual_max']),
        'precompute_seconds': float(precompute_seconds),
        'rays_mod': [float(x) for x in info_v5['rays_mod']],
        'wall_steps': [
            {
                'from_index': _py_int(s['from_index']),
                'to_index': _py_int(s['to_index']),
                'wall_lift': float(s['wall_lift']),
                'n_swaps': _py_int(s.get('n_swaps', 1)),
                'degenerate_wall': bool(s.get('degenerate_wall', False)),
                'wall_group_size': _py_int(s.get('wall_group_size', 1)),
            }
            for s in info_v5.get('wall_steps', [])
        ],
    }


def _build_chambers_v5_full(U_list, A_global, m_sizes, chamber_ds,
                            precision='medium', verbose=False,
                            progress=None, on_entry=None, v5_kwargs=None):
    if precision not in V5_PRECISION_PRESETS:
        raise ValueError("precision=%r not in %r" %
                         (precision, sorted(V5_PRECISION_PRESETS)))
    kwargs = dict(V5_PRECISION_PRESETS[precision])
    if v5_kwargs:
        kwargs.update(v5_kwargs)

    t0 = time.time()
    chambers_v5, info_v5 = compute_Sd_chambers_v5(
        U_list, A_global, m_sizes, **kwargs
    )
    precompute_seconds = time.time() - t0

    n = len(U_list)
    out_chambers = []
    for ch_idx, d in enumerate(chamber_ds):
        d = float(d)
        Sd, sel = select_Sd_from_chambers(chambers_v5, info_v5, d)
        chamber_data = {'d': d, 'entries': {}}
        for i in range(n):
            for j in range(n):
                if i == j:
                    continue
                entry = _entry_from_block(
                    Sd[(i, j)], int(m_sizes[i]), int(m_sizes[j]),
                    'v5_full_wall_crossing',
                    {
                        'v5_chamber_index': _py_int(sel['chamber_index']),
                        'v5_lift_m': _py_int(sel['lift_m']),
                    },
                )
                chamber_data['entries'][f'{i},{j}'] = entry
                if on_entry is not None:
                    on_entry(ch_idx, i, j, entry)
        out_chambers.append(chamber_data)
        if progress is not None:
            progress(ch_idx, len(chamber_ds), d, out_chambers)

    return out_chambers, {
        'hits': _py_int(0),
        'miss': _py_int(n * (n - 1) * len(chamber_ds)),
        'algorithm': 'v5_full',
        'v5': _v5_metadata_for_dataset(info_v5, kwargs, precompute_seconds),
    }


def build_chambers(U_list, A_global, m_sizes, chamber_ds,
                    precision='medium', verbose=False, use_cache=False,
                    progress=None, on_entry=None,
                    algorithm='v5_full', v5_fallback=True,
                    v5_kwargs=None):
    """遍历所有 chamber × (i,j) 算 entry, 返回 chambers list.

    precision: 'low' | 'medium' | 'high'. legacy_entry 透传给 compute_Sd_entry;
      v5_full 用 V5_PRECISION_PRESETS 映射到 (p1, p2).
    algorithm: 'legacy_entry' | 'v5_full'. v5_full 不伪造 PL path:
      entry.path = null, entry.provenance='v5_full_wall_crossing'.
    progress(ch_idx, n_chambers, d, chambers_so_far): 每 chamber 跑完调一次.
    on_entry(ch_idx, i, j, entry): 每 entry 跑完调一次.
    """
    if algorithm == 'v5_full':
        try:
            return _build_chambers_v5_full(
                U_list, A_global, m_sizes, chamber_ds,
                precision=precision, verbose=verbose,
                progress=progress, on_entry=on_entry, v5_kwargs=v5_kwargs,
            )
        except NotImplementedError:
            if not v5_fallback:
                raise
            if verbose:
                print("[dataset_builder] v5_full unsupported; falling back to legacy_entry")
            algorithm = 'legacy_entry'

    if algorithm not in ('legacy_entry', 'legacy'):
        raise ValueError("unknown build_chambers algorithm %r" % algorithm)

    n = len(U_list)
    cache = {} if use_cache else None
    hits = 0; miss = 0
    out_chambers = []
    for ch_idx, d in enumerate(chamber_ds):
        d = float(d)  # sage preparser 给 RealField(53), 强制 python float
        chamber_data = {'d': d, 'entries': {}}
        for i in range(n):
            for j in range(n):
                if i == j: continue
                try:
                    entry, status = build_chamber_entry(
                        U_list, A_global, m_sizes, i, j, d,
                        precision=precision, verbose=verbose, cache=cache,
                    )
                    if status == 'hit': hits += 1
                    else: miss += 1
                    chamber_data['entries'][f'{i},{j}'] = entry
                    if on_entry is not None:
                        on_entry(ch_idx, i, j, entry)
                except Exception as e:
                    import traceback
                    chamber_data['entries'][f'{i},{j}'] = {
                        'error': f'{type(e).__name__}: {e}',
                        'tb': traceback.format_exc(),
                    }
        out_chambers.append(chamber_data)
        if progress is not None:
            progress(ch_idx, len(chamber_ds), d, out_chambers)
    return out_chambers, {
        'hits': _py_int(hits),
        'miss': _py_int(miss),
        'algorithm': 'legacy_entry',
    }
