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
import os, sys, math, json, time

_WS = "/Users/dtq1997/ai/workspace/academic-formula-workbench"
sys.path.insert(0, os.path.join(_WS, "50-computation"))

from sage.all import matrix, ComplexField

load(os.path.join(_WS, "50-computation/compute_Sd_entry.sage"))


def anti_stokes_rays(U):
    rays = set()
    twopi = 2 * math.pi
    for i in range(len(U)):
        for j in range(len(U)):
            if i == j: continue
            diff = U[i] - U[j]
            ang = math.atan2(diff.imag, diff.real) % twopi
            rays.add(round(ang, 10))
    rays.add(0.0)
    rays.add(round(math.pi, 10))
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
                    val, info = compute_Sd_entry(
                        U_list, A_global, m_sizes,
                        i, j, d, waypoints=wp,
                        p_base=400, p_factor=3, verbose=False,
                    )
                    chamber_data['entries'][f'{i},{j}'] = {
                        'value_re': float(val.real),
                        'value_im': float(val.imag),
                        'path': pack_path(full_path),
                        'tau_code': float(info['tau_code']),
                        'theta_t_lift': float(info['theta_t_lift']),
                    }
                except Exception as e:
                    chamber_data['entries'][f'{i},{j}'] = {'error': str(e)}
        out['chambers'].append(chamber_data)
        # progress 行 (push_server 接 stdout 转 SSE 用)
        print(f"PROGRESS chamber {ch_idx+1}/{len(chambers)} d={d:.4f}", flush=True)

    print(f"DONE elapsed={time.time()-t0:.1f}s", flush=True)
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
