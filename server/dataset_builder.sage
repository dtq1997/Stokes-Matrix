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
import collections
_py_int = builtins.int  # sage preparser 把 int() 换 Integer, 用 builtins 绕开

_WS = "/Users/dtq1997/ai/workspace/academic-formula-workbench"
sys.path.insert(0, os.path.join(_WS, "50-computation"))

load(os.path.join(_WS, "50-computation/compute_sd_v5_full.sage"))


# Phase 1b: 把 compute_Sd_chambers_v5() 算出的 (chambers_v5, info_v5) 缓存
# 起来, 让"同参数二次 recompute"完全跳过 ~99% recompute 时间. 持久 worker
# 配合, 一次会话内多次同输入 (e.g. iterating viz settings) 命中后秒回.
#
# 注意 SSOT: compute_Sd_entry.sage:38 已有 _V5_CHAMBER_CACHE 但仅在 legacy
# 路径 (compute_Sd_entry 主入口) 触发; dataset_builder 走 compute_Sd_chambers_v5
# 直接调用, 必须独立缓存. 两个 cache 共用 fingerprint 哲学 (content-based,
# JSON 浮点序列化等价).
_BUILD_CHAMBERS_V5_CACHE = collections.OrderedDict()
_BUILD_CHAMBERS_V5_CACHE_MAX = 32  # 单条 ~1-5MB chambers, 32 条 < 200MB
# 缓存命中/未命中累计计数 (供 /api/worker_stats 调试用)
_BUILD_CHAMBERS_V5_HITS = 0
_BUILD_CHAMBERS_V5_MISSES = 0


def _fp_complex_tuple(c):
    """Coerce sage / mpmath / python complex 到 (re, im) python float 对."""
    cc = complex(c)
    return (float(cc.real), float(cc.imag))


def _fingerprint_v5_chambers(U_list, A_global, m_sizes, kwargs):
    """Content-based key for v5 chambers cache.

    Includes all caller-visible knobs that change compute output. Anything
    not in this tuple MUST not affect numeric result.
    """
    u_tup = tuple(_fp_complex_tuple(u) for u in U_list)
    if hasattr(A_global, 'nrows'):
        N = _py_int(A_global.nrows())
        a_tup = tuple(_fp_complex_tuple(A_global[r, c])
                      for r in range(N) for c in range(N))
    else:
        a_tup = tuple(_fp_complex_tuple(v) for row in A_global for v in row)
    m_tup = tuple(_py_int(m) for m in m_sizes)
    # 必须包含每一个 affects-output 的 v5 kwarg.
    relevant_keys = (
        'backend', 'p1', 'p2', 'p_max',
        'truncation_method', 'tail_order', 'chi_prec_bits',
        'auto_tail_buffer', 'max_tail_order',
        'use_richardson', 'adaptive_tol',
    )
    k_tup = tuple((k, kwargs.get(k)) for k in relevant_keys)
    return (m_tup, u_tup, a_tup, k_tup)


def clear_chambers_v5_cache():
    global _BUILD_CHAMBERS_V5_HITS, _BUILD_CHAMBERS_V5_MISSES
    _BUILD_CHAMBERS_V5_CACHE.clear()
    _BUILD_CHAMBERS_V5_HITS = 0
    _BUILD_CHAMBERS_V5_MISSES = 0


def chambers_v5_cache_stats():
    return {
        'size': len(_BUILD_CHAMBERS_V5_CACHE),
        'max': _BUILD_CHAMBERS_V5_CACHE_MAX,
        'hits': _BUILD_CHAMBERS_V5_HITS,
        'misses': _BUILD_CHAMBERS_V5_MISSES,
    }


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

    precision: 'fast' | 'low' | 'medium' | 'high'. 见 compute_Sd_entry PRECISION_PRESETS.
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


def _pack_v5_eg_entries(info_v5, m_sizes):
    raw = info_v5.get('d_reg_info', {}).get('eg_entries', {})
    out = {}
    for key in sorted(raw.keys()):
        i, j = key
        rec = raw[key]
        block = rec['value_block']
        mi, mj = int(m_sizes[i]), int(m_sizes[j])
        entry = _entry_from_block(
            block, mi, mj, 'v5_raw_anchor',
            {
                'tau_lift': float(rec['tau_lift']),
                'v5_labels': [_py_int(x) for x in rec.get('v5_labels', [])],
                'sigma_geom': rec.get('sigma_geom'),
                'word_string': rec.get('word_string'),
            },
        )
        if rec.get('confidence') is not None:
            entry['confidence'] = float(rec['confidence'])
        if rec.get('romberg_increment_rel') is not None:
            entry['romberg_increment_rel'] = float(rec['romberg_increment_rel'])
        out[f'{_py_int(i)},{_py_int(j)}'] = entry
    return out


def _v5_metadata_for_dataset(info_v5, kwargs, precompute_seconds):
    return {
        'd_reg': float(info_v5['d_reg_info']['d_reg']),
        'base_chamber_index': _py_int(info_v5['base_chamber_index']),
        'p1': _py_int(kwargs.get('p1')),
        'p2': _py_int(kwargs.get('p2')) if kwargs.get('p2') is not None else None,
        'backend': kwargs.get('backend'),
        'truncation_method': info_v5['d_reg_info'].get('truncation_method'),
        'tail_order': info_v5['d_reg_info'].get('tail_order'),
        'safety_factor': float(info_v5['d_reg_info'].get('safety_factor')),
        'detour_factor': float(info_v5['d_reg_info'].get('detour_factor')),
        'residual_max': float(info_v5['d_reg_info']['residual_max']),
        'confidence': (
            float(info_v5['d_reg_info']['confidence'])
            if info_v5['d_reg_info'].get('confidence') is not None else None
        ),
        'chamber_eigvals_cache_size': (
            _py_int(info_v5['d_reg_info']['chamber_eigvals_cache_size'])
            if info_v5['d_reg_info'].get('chamber_eigvals_cache_size') is not None else None
        ),
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
    # Phase 2: 默认并行 base case (i,j) 对到所有可用核. caller 可 v5_kwargs
    # override (e.g. tests 想跑顺序). 上限 = min(cpu_count, n*(n-1)).
    #
    # **CRITICAL** numpy backend 才并行: mpmath/CBF 路径会触发 sage.primes() →
    # PARI nextprime, PARI 单线程不可重入, 多线程并发会段错. 实测 2026-05-15.
    #
    # 调试 escape: env SD_VIZ_N_JOBS 强制覆盖 n_jobs (设 1 = 强制串行).
    if v5_kwargs:
        kwargs.update(v5_kwargs)
    env_n_jobs = os.environ.get('SD_VIZ_N_JOBS', '').strip()
    if env_n_jobs:
        try:
            kwargs['n_jobs'] = _py_int(env_n_jobs)
        except ValueError:
            pass
    if 'n_jobs' not in kwargs:
        # Phase 2/3.5/4A 决策 (2026-05-15):
        # - threading 在 mpmath (GIL-bound) 和 numpy (overhead>benefit) 都不
        #   净加速. 默认 n_jobs=1.
        # - 但 fork-based ProcessPool 突破 GIL, 实测有效. 由 env SD_VIZ_FORK_POOL=1
        #   开启 (compute_sd_v5_full.sage 内 ProcessPoolExecutor 路径).
        # 当 SD_VIZ_FORK_POOL=1 时也设 n_jobs > 1, 否则 fork pool 入口 dead code.
        if os.environ.get('SD_VIZ_FORK_POOL', '').strip() == '1':
            n_pairs = len(U_list) * (len(U_list) - 1)
            cpu_n = os.cpu_count() or 4
            kwargs['n_jobs'] = min(cpu_n, n_pairs)
        else:
            kwargs['n_jobs'] = 1

    # Forward base-case pair + wall progress to upstream callback as the
    # *real* progress signal during v5_full. Caller's `progress(ch_idx, n, d, ...)`
    # gets a final-pass batch at the end. Real time is spent in
    # compute_Sd_chambers_v5 internals (n*(n-1) PL+tq base case + N-1 walls).
    n_v5 = len(U_list)
    pair_total = n_v5 * (n_v5 - 1)
    # split the chamber_ds "virtual progress" 0..1 into
    #   [0, 0.85) for base-case pairs  (dominant cost)
    #   [0.85, 0.95) for wall-crossings
    #   [0.95, 1.0] for chamber-pack (effectively instant)
    n_chambers_total = len(chamber_ds)
    if n_chambers_total < 1:
        n_chambers_total = 1

    def _emit_progress(virtual_ch_idx, label_d):
        if progress is not None:
            try:
                progress(int(virtual_ch_idx), int(n_chambers_total), float(label_d), [])
            except Exception:
                pass

    # Phase 1b: cache lookup. fingerprint 覆盖 (U, A, m_sizes, 所有 v5 kwargs).
    # 命中 → 直接复用 chambers_v5/info_v5 + 跳过 base case / wall-crossing /
    # 进度回调, 只跑 chamber-pack (毫秒级). 不动数学.
    global _BUILD_CHAMBERS_V5_HITS, _BUILD_CHAMBERS_V5_MISSES
    _cache_key = _fingerprint_v5_chambers(U_list, A_global, m_sizes, kwargs)
    if _cache_key in _BUILD_CHAMBERS_V5_CACHE:
        # LRU touch: move-to-end
        _BUILD_CHAMBERS_V5_CACHE.move_to_end(_cache_key)
        chambers_v5, info_v5 = _BUILD_CHAMBERS_V5_CACHE[_cache_key]
        _BUILD_CHAMBERS_V5_HITS += 1
        print(f"STAGE profile-cache-hit|v5 chambers reused|hits={_BUILD_CHAMBERS_V5_HITS}|misses={_BUILD_CHAMBERS_V5_MISSES}|size={len(_BUILD_CHAMBERS_V5_CACHE)}", flush=True)
        precompute_seconds = 0.0
        _base_case_wall_s = 0.0
        _walls_wall_s = 0.0
        # 单次进度信号让前端动起来
        _emit_progress(0, 0.0)
        n = len(U_list)
        print(f"STAGE chamber-pack|packing {len(chamber_ds)} chambers with {n*(n-1)} entries each", flush=True)
        _t_pack_start = time.time()
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
        _pack_s = time.time() - _t_pack_start
        print(f"STAGE profile-build|v5_total_s=0.00|base_case_s=0.00|walls_s=0.00|pack_s={_pack_s:.2f}|n_pairs=0|n_walls=0|backend={kwargs.get('backend','?')}|p1={kwargs.get('p1','?')}|cache=hit", flush=True)
        return out_chambers, {
            'hits': _py_int(0),
            'miss': _py_int(n * (n - 1) * len(chamber_ds)),
            'algorithm': 'v5_full',
            'v5': _v5_metadata_for_dataset(info_v5, kwargs, precompute_seconds),
            'v5_eg_entries': _pack_v5_eg_entries(info_v5, m_sizes),
        }

    # Cache miss → 真算. 后续进 LRU.
    _BUILD_CHAMBERS_V5_MISSES += 1

    # Phase 0 profiling: 收集回调时戳推导 wall-clock 拆分.
    _prof = {'t_first_pair': None, 't_last_pair': None,
             't_first_wall': None, 't_last_wall': None,
             'n_pairs': 0, 'n_walls': 0}

    def _on_pair(done, total, i, j):
        # ramp 0..ceil(0.85*n_chambers_total)
        ch_idx = _py_int(round((done / total) * 0.85 * n_chambers_total))
        if ch_idx < 1:
            ch_idx = 1
        if ch_idx > n_chambers_total:
            ch_idx = n_chambers_total
        # use 0.0 as label d; frontend just shows progress bar
        _emit_progress(ch_idx - 1, 0.0)
        _now = time.time()
        if _prof['t_first_pair'] is None:
            _prof['t_first_pair'] = _now
        _prof['t_last_pair'] = _now
        _prof['n_pairs'] += 1
        # 详细 phase 标签 (push_server 单独 parse STAGE 行)
        print(f"STAGE base-case|pair=({_py_int(i)+1},{_py_int(j)+1})|done={_py_int(done)}/{_py_int(total)}", flush=True)

    def _on_wall(done, total, from_idx, to_idx):
        ch_idx = _py_int(round(0.85 * n_chambers_total + (done / max(total, 1)) * 0.10 * n_chambers_total))
        if ch_idx < 1:
            ch_idx = 1
        if ch_idx > n_chambers_total:
            ch_idx = n_chambers_total
        _emit_progress(ch_idx - 1, 0.0)
        _now = time.time()
        if _prof['t_first_wall'] is None:
            _prof['t_first_wall'] = _now
        _prof['t_last_wall'] = _now
        _prof['n_walls'] += 1
        print(f"STAGE wall-crossing|chamber={_py_int(from_idx)}->{_py_int(to_idx)}|done={_py_int(done)}/{_py_int(total)}", flush=True)

    print("STAGE base-case|starting v5 base entries (PL push + tq Richardson per ordered pair)", flush=True)

    t0 = time.time()
    chambers_v5, info_v5 = compute_Sd_chambers_v5(
        U_list, A_global, m_sizes,
        on_pair_done=_on_pair, on_wall_done=_on_wall,
        **kwargs,
    )
    precompute_seconds = time.time() - t0
    # Phase 1b: 存入 LRU 缓存. 同一 worker 进程内下次同 fingerprint 命中直接复用.
    _BUILD_CHAMBERS_V5_CACHE[_cache_key] = (chambers_v5, info_v5)
    while len(_BUILD_CHAMBERS_V5_CACHE) > _BUILD_CHAMBERS_V5_CACHE_MAX:
        _BUILD_CHAMBERS_V5_CACHE.popitem(last=False)

    # Phase 0: 拆 base case / wall-crossing wall-clock. base = t0 → t_last_pair;
    # walls = t_first_wall → t_last_wall (若有). chamber_pack 在下面统计.
    _base_case_wall_s = (_prof['t_last_pair'] - t0) if _prof['t_last_pair'] else 0.0
    _walls_wall_s = (_prof['t_last_wall'] - _prof['t_first_wall']) if (
        _prof['t_first_wall'] and _prof['t_last_wall']) else 0.0

    n = len(U_list)
    print(f"STAGE chamber-pack|packing {len(chamber_ds)} chambers with {n*(n-1)} entries each", flush=True)
    _t_pack_start = time.time()
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
        # final-pass real chamber progress (overwrites virtual base/wall ramp)
        if progress is not None:
            progress(ch_idx, len(chamber_ds), d, out_chambers)

    # Phase 0: 整段 wall-clock 拆解. 这是后续 Phase 1/2 优化的 baseline.
    _pack_s = time.time() - _t_pack_start
    print(f"STAGE profile-build|v5_total_s={precompute_seconds:.2f}|base_case_s={_base_case_wall_s:.2f}|walls_s={_walls_wall_s:.2f}|pack_s={_pack_s:.2f}|n_pairs={_prof['n_pairs']}|n_walls={_prof['n_walls']}|backend={kwargs.get('backend','?')}|p1={kwargs.get('p1','?')}", flush=True)

    return out_chambers, {
        'hits': _py_int(0),
        'miss': _py_int(n * (n - 1) * len(chamber_ds)),
        'algorithm': 'v5_full',
        'v5': _v5_metadata_for_dataset(info_v5, kwargs, precompute_seconds),
        'v5_eg_entries': _pack_v5_eg_entries(info_v5, m_sizes),
    }


def build_chambers(U_list, A_global, m_sizes, chamber_ds,
                    precision='medium', verbose=False, use_cache=False,
                    progress=None, on_entry=None,
                    algorithm='v5_full', v5_fallback=True,
                    v5_kwargs=None):
    """遍历所有 chamber × (i,j) 算 entry, 返回 chambers list.

    precision: 'fast' | 'low' | 'medium' | 'high'. legacy_entry 透传给 compute_Sd_entry;
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
