"""
Sd-viz n=4 simple case static data exporter.

输出: n4_simple.json — punctures, A, anti-Stokes rays, all chambers,
所有 chamber 内 12 个 (i,j) entry 的 S_d 数值, 默认 PL path waypoints.

调用: sage 60-outputs/sd-viz/data/export_n4_simple.sage
"""
import os, sys, math, json, time

_WS = "/Users/dtq1997/ai/workspace/academic-formula-workbench"
sys.path.insert(0, os.path.join(_WS, "50-computation"))

from sage.all import matrix, ComplexField

load(os.path.join(_WS, "50-computation/compute_Sd_entry.sage"))


# ---------- n=4 simple case 固定数据 ----------
# 选 generic 位置: 不共线, 距离差异明显, anti-Stokes rays 在 [0, π) 都不重合
U_list = [complex(0.0, 0.0),
          complex(2.5, 0.4),
          complex(1.6, 1.8),
          complex(-0.6, 1.3)]

# A: skew-symmetric off-diag (Frobenius 风格), 对角为 spectral params
# 简单谱保证 |Re(α-β)| 小, 都用实数对角避 monodromy 复杂
A_diag = [0.10, 0.17, 0.22, 0.31]
# off-diag 不对称, 但量级控制在 ~0.5 内防 ODE stiff
A_off = [
    # (i, j, re, im): sage preparser 让 j 当虚单位, 用元组绕开
    (0, 1, 0.5, 0.1),
    (0, 2, 0.4, -0.2),
    (0, 3, 0.6, 0.3),
    (1, 0, 0.3, -0.1),
    (1, 2, 0.5, 0.4),
    (1, 3, 0.4, -0.2),
    (2, 0, 0.6, 0.2),
    (2, 1, 0.3, -0.3),
    (2, 3, 0.5, 0.1),
    (3, 0, 0.4, -0.4),
    (3, 1, 0.5, 0.2),
    (3, 2, 0.3, -0.1),
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


# ---------- chamber 结构 ----------
def anti_stokes_rays(U):
    """所有 arg(u_i - u_j) mod 2π, 0-indexed pairs i≠j. 返回 sorted unique."""
    rays = set()
    twopi = 2 * math.pi
    for i in range(len(U)):
        for j in range(len(U)):
            if i == j: continue
            diff = U[i] - U[j]
            ang = math.atan2(diff.imag, diff.real) % twopi
            rays.add(round(ang, 10))
    # 加 πℤ (admissibility 要求 d ∉ πℤ)
    rays.add(0.0)
    rays.add(round(math.pi, 10))
    return sorted(rays)


def chamber_midpoints(rays):
    """相邻 rays 之间的中点, 返回 chamber 代表方向."""
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


rays = anti_stokes_rays(U_list)
chambers = chamber_midpoints(rays)
print(f"anti-Stokes rays: {len(rays)} 个 (含 0, π)")
print(f"chambers: {len(chambers)}")


# ---------- 算所有 entry ----------
results = {
    'punctures': [{'re': float(u.real), 'im': float(u.imag)} for u in U_list],
    'A_diag': [float(x) for x in A_diag],
    'A_off': [{'i': int(i), 'j': int(j), 're': float(re), 'im': float(im)} for (i, j, re, im) in A_off],
    'm_sizes': [int(x) for x in m_sizes],
    'rays': [float(x) for x in rays],          # anti-Stokes + πℤ
    'chambers': [],                            # 每 chamber: {d, entries: {(i,j): {value, path}}}
}


def pack_path(waypoints):
    # 强制 python float, 避 sage RealLiteral 进 json
    return [{'re': float(p.real), 'im': float(p.imag)} for p in waypoints]


def to_pyfloat(x):
    return float(x)


t0 = time.time()
for ch_idx, d in enumerate(chambers):
    print(f"\n=== chamber {ch_idx+1}/{len(chambers)}, d = {d:.4f} rad = {math.degrees(d):.2f}° ===")
    chamber_data = {
        'd': float(d),
        'entries': {},
    }
    for i in range(n):
        for j in range(n):
            if i == j: continue
            try:
                # 默认 PL 路径
                u_i_f = complex(U_list[i])
                u_j_f = complex(U_list[j])
                # target 跟 compute_Sd_entry 内部一致
                from numpy import abs as np_abs
                # min dist from u_j to other punctures
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
                print(f"  ({i},{j}): {val:.5e}  (path 段数 {len(full_path)-1})")
            except Exception as e:
                chamber_data['entries'][f'{i},{j}'] = {'error': str(e)}
                print(f"  ({i},{j}): FAIL — {e}")
    results['chambers'].append(chamber_data)
    # 增量保存: 每 chamber 算完就 dump, 避免崩盘丢全部
    out = os.path.join(_WS, "60-outputs/sd-viz/data/n4_simple.json")
    try:
        with open(out, 'w') as f:
            json.dump(results, f, indent=2)
        print(f"  [saved {ch_idx+1}/{len(chambers)} chambers → n4_simple.json]")
    except Exception as e:
        print(f"  [save FAILED: {e}]")

print(f"\n总耗时 {time.time()-t0:.1f} s")
print(f"最终输出: {out}")
