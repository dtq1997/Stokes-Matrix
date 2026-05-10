"""SSOT: 单 chamber × 所有 entry 的 dataset 装载逻辑共享.

Used by:
- 60-outputs/sd-viz/data/export_n4_simple.sage
- 60-outputs/sd-viz/server/recompute_runner.sage

调用方负责: U_list, A_global (sage matrix), m_sizes, chambers (sample d list).
可选 cache_homotopy: 同 homotopy signature 跨 chamber 复用 entry value 省重算.

display_path = algo_full + [u_j]: algo_full = [u_i] + algo_wp (含 u_target ≈ u_j),
末段补 u_j 表 ε→0 极限. viz 显示用. 数值不依赖这个末段 (算法 push 走 u_target).
"""
import math
import builtins
_py_int = builtins.int  # sage preparser 把 int() 换 Integer, 用 builtins 绕开


def pack_path(waypoints):
    return [{'re': float(p.real), 'im': float(p.imag)} for p in waypoints]


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
                         p_base=400, p_factor=3, verbose=False, cache=None):
    """算一个 (i, j) entry, 返回 entry dict + cache 状态. caller 负责 try/except.

    cache: 可选 dict {sig → entry_template}, 命中跳过重算只重画 path. None = 不 cache.
    """
    u_i_f = complex(U_list[i])
    u_j_f = complex(U_list[j])
    val, info = compute_Sd_entry(
        U_list, A_global, m_sizes,
        i, j, d, waypoints=None,
        p_base=p_base, p_factor=p_factor, verbose=verbose,
    )
    algo_full = [u_i_f] + list(info['algo_wp'])
    display_path = list(algo_full) + [u_j_f]
    theta_t = info['theta_t_lift']
    theta_s = -d
    entry = {
        'value_re': float(val.real),
        'value_im': float(val.imag),
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
            entry['_cache'] = 'hit'
            cache_status = 'hit'
        else:
            cache[sig] = {'value_re': entry['value_re'], 'value_im': entry['value_im']}
    return entry, cache_status


def build_chambers(U_list, A_global, m_sizes, chamber_ds,
                    p_base=400, p_factor=3, verbose=False, use_cache=False,
                    progress=None, on_entry=None):
    """遍历所有 chamber × (i,j) 算 entry, 返回 chambers list.

    progress(ch_idx, n_chambers, d, chambers_so_far): 每 chamber 跑完调一次,
        chambers_so_far 是已装好的 chamber dict list (含当前 ch_idx) — 可用作增量 dump.
    on_entry(ch_idx, i, j, entry): 每 entry 跑完调一次.
    """
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
                        p_base=p_base, p_factor=p_factor, verbose=verbose, cache=cache,
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
    return out_chambers, {'hits': _py_int(hits), 'miss': _py_int(miss)}
