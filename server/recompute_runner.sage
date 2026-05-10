"""
Recompute runner: 命令行参数 input.json + output.json.

Input schema:
  {
    "punctures": [{"re": float, "im": float}, ...],
    "A":         [[{"re": float, "im": float}, ...], ...],   # N×N
    "m_sizes":   [int, ...]                                  # n 个块大小
  }

Output schema: SimpleDataset (跟 web/src/lib/types.ts 对齐).

调用:
  sage server/recompute_runner.sage input.json output.json

注意: 当前 simple-spectrum (m_k=1) 才稳; 重数 case compute_Sd_entry 块版返回
m_i×m_j entry, 需要扩展输出 schema (TODO).
"""
import os, sys, math, json, time, builtins
py_int = builtins.int     # sage preparser 把 int() 替换成 Integer(), 用 builtins 绕开

_WS = "/Users/dtq1997/ai/workspace/academic-formula-workbench"
sys.path.insert(0, os.path.join(_WS, "50-computation"))

from sage.all import matrix, ComplexField

load(os.path.join(_WS, "50-computation/compute_Sd_entry.sage"))


def anti_stokes_rays(U):
    """Paper aS(u) = {-arg(u_p - u_q) mod 2π} for ordered pairs.
    严格不含 πℤ: 0/π 不是 anti-Stokes (除非某对 puncture 让 arg 落在那).
    跨这条 ray 时 Im((u_p - u_q) e^{id}) 跨零 → σ_d 邻位 transposition."""
    rays = set()
    twopi = 2 * math.pi
    for i in range(len(U)):
        for j in range(len(U)):
            if i == j: continue
            diff = U[i] - U[j]
            ang = (-math.atan2(diff.imag, diff.real)) % twopi
            rays.add(round(ang, 10))
    return sorted(rays)


def chamber_midpoints(rays):
    twopi = 2 * math.pi
    out = []
    for k in range(len(rays)):
        a = rays[k]
        b = rays[(k+1) % len(rays)]
        if k == len(rays) - 1:
            b = b + twopi
        mid = (a + b) / 2.0
        if mid >= twopi:
            mid -= twopi
        out.append(mid)
    return out


def pack_path(waypoints):
    return [{'re': float(p.real), 'im': float(p.imag)} for p in waypoints]


def winding_around(path_pts, u_k, eps=1e-9):
    """折线 path_pts 围 u_k 的 winding number (signed python int)."""
    total = 0.0
    for q in range(len(path_pts) - 1):
        a = path_pts[q] - u_k
        b = path_pts[q + 1] - u_k
        if abs(a) < eps or abs(b) < eps:
            continue
        ang_a = math.atan2(a.imag, a.real)
        ang_b = math.atan2(b.imag, b.real)
        diff = ang_b - ang_a
        if diff > math.pi: diff -= 2 * math.pi
        elif diff < -math.pi: diff += 2 * math.pi
        total += diff
    # int(round(...)) 在 sage preparser 下可能返回 sage.Integer; 强制 python int
    return py_int(round(total / (2 * math.pi)))


def homotopy_signature(path_pts, U_all, i, j, lift_s, lift_t):
    """同伦类签名: (i, j, winding around each u_k for k != i,j, lift_s, lift_t).
    两条 path 同 signature ⇒ 在 ℂ\{u_k\} 中同伦 + 同 lift ⇒ S entry 相同.
    """
    windings = []
    for k in range(len(U_all)):
        if k == i or k == j: continue
        windings.append(winding_around(path_pts, U_all[k]))
    return (py_int(i), py_int(j), tuple(windings),
            py_int(round(lift_s / math.pi * 2)),
            py_int(round(lift_t / math.pi * 2)))


def recompute(inp):
    punctures = inp['punctures']
    A_in = inp['A']
    m_sizes = list(inp['m_sizes'])
    n = len(punctures)
    N = sum(m_sizes)
    if N != len(A_in):
        raise ValueError(f"A 维度 {len(A_in)} != N=sum(m_k)={N}")

    U_list = [complex(p['re'], p['im']) for p in punctures]

    # 输出 A_diag / A_off (跟原 dataset 兼容): A_diag 用块的 (k,k) entry,
    # off 是 i≠j 块. simple 谱时直接对应; 块时仅记录块版 leading entry.
    A_diag = []
    starts = []
    s = 0
    for m in m_sizes:
        starts.append(s)
        s += m
    for I in range(n):
        v = A_in[starts[I]][starts[I]]
        A_diag.append(float(v['re']))   # 简单谱: 对角 entry; 块版: 只记录 [0,0]
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
                        # 简单谱: 用 I,J 当索引; 块版需扩展 schema (后续)
                        A_off.append({
                            'i': int(I), 'j': int(J),
                            're': float(v['re']), 'im': float(v['im']),
                        })

    CC = ComplexField(80)
    A_global = matrix(CC, N, N)
    for i_ in range(N):
        for j_ in range(N):
            v = A_in[i_][j_]
            A_global[i_, j_] = CC(float(v['re']), float(v['im']))

    rays = anti_stokes_rays(U_list)
    chambers = chamber_midpoints(rays)

    out = {
        'punctures': [{'re': float(u.real), 'im': float(u.imag)} for u in U_list],
        'A_diag': A_diag,
        'A_off': A_off,
        'm_sizes': m_sizes,
        'rays': [float(x) for x in rays],
        'chambers': [],
    }

    t0 = time.time()
    cache = {}        # (i, j, winding_tuple, lift_s_q, lift_t_q) → entry dict
    cache_hits = py_int(0)
    cache_miss = py_int(0)
    for ch_idx, d in enumerate(chambers):
        chamber_data = {'d': float(d), 'entries': {}}
        for i in range(n):
            for j in range(n):
                if i == j: continue
                try:
                    u_i_f = complex(U_list[i])
                    u_j_f = complex(U_list[j])
                    other_dists = [abs(complex(U_list[l]) - u_j_f)
                                   for l in range(n) if l != j]
                    target_dist = 0.5 * min(other_dists) if other_dists else 0.5
                    u_target = u_j_f + target_dist * complex(math.cos(d), math.sin(d))
                    U_others = [complex(U_list[k]) for k in range(n)
                                if k != i and k != j]
                    wp = pl_path_in_chamber(u_i_f, u_target, U_others, d,
                                             epsilon_factor=0.3, verbose=False)
                    full_path = [u_i_f] + list(wp)
                    # lift: 起点 θ_s = -d, 终点 θ_t = arg(u_j - u_i_pushed) lift to (-d-π, -d+π)
                    diff = u_target - u_i_f
                    theta_t_raw = math.atan2(diff.imag, diff.real)
                    # lift to closest 2π mod center -d
                    twopi = 2 * math.pi
                    theta_t = theta_t_raw
                    while theta_t > -d + math.pi: theta_t -= twopi
                    while theta_t < -d - math.pi: theta_t += twopi
                    theta_s = -d  # 起点 θ_s = -d (paper convention)
                    sig = homotopy_signature(full_path, U_list, i, j, theta_s, theta_t)
                    if sig in cache:
                        cached = cache[sig]
                        display_path_hit = list(full_path[:-1]) + [complex(U_list[j])]
                        chamber_data['entries'][f'{i},{j}'] = {
                            'value_re': cached['value_re'],
                            'value_im': cached['value_im'],
                            'path': pack_path(display_path_hit),
                            'tau_code': float(-theta_t),
                            'theta_t_lift': float(theta_t),
                            '_cache': 'hit',
                        }
                        cache_hits += 1
                        continue
                    val, info = compute_Sd_entry(
                        U_list, A_global, m_sizes,
                        i, j, d, waypoints=wp,
                        p_base=400, p_factor=3, verbose=False,
                    )
                    # Visualization: path 端点应该是 puncture u_j, 不是 ε-偏移的 u_target
                    # (内部 evaluation 用 u_target 因为 u_j 是奇异点 ODE 进不去)
                    display_path = list(full_path[:-1]) + [complex(U_list[j])]
                    entry = {
                        'value_re': float(val.real),
                        'value_im': float(val.imag),
                        'path': pack_path(display_path),
                        'tau_code': float(info['tau_code']),
                        'theta_t_lift': float(info['theta_t_lift']),
                    }
                    cache[sig] = entry
                    cache_miss += 1
                    chamber_data['entries'][f'{i},{j}'] = entry
                    continue
                except Exception as e:
                    chamber_data['entries'][f'{i},{j}'] = {'error': str(e)}
        out['chambers'].append(chamber_data)
        # progress 行 (push_server 接 stdout 转 SSE 用)
        print(f"PROGRESS chamber {ch_idx+1}/{len(chambers)} d={d:.4f}", flush=True)

    total = cache_hits + cache_miss
    rate = (100.0 * cache_hits / total) if total else 0
    print(f"DONE elapsed={time.time()-t0:.1f}s cache_hit={cache_hits}/{total} ({rate:.0f}%)",
          flush=True)
    out['_cache_stats'] = {'hits': py_int(cache_hits), 'miss': py_int(cache_miss)}
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
