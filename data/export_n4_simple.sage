"""
Sd-viz n=4 simple case static data exporter.

输出: n4_simple.json — punctures, A, anti-Stokes rays, all chambers,
所有 chamber 内 12 个 (i,j) entry 的 S_d 数值, 默认 PL path waypoints.

调用: sage 60-outputs/sd-viz/data/export_n4_simple.sage
"""
import os, sys, math, json, time

_WS = "/Users/dtq1997/ai/workspace/academic-formula-workbench"
sys.path.insert(0, os.path.join(_WS, "50-computation"))
sys.path.insert(0, os.path.join(_WS, "60-outputs/sd-viz/server"))

from sage.all import matrix, ComplexField
from sd_chamber_geom import anti_stokes_rays, chamber_midpoints  # SSOT

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


# chamber 结构: anti_stokes_rays + chamber_midpoints 已从 server/sd_chamber_geom.py
# import (SSOT). 此处不再重复定义.


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
                # SSOT: 直接调 compute_Sd_entry, 不自己算 u_target/wp.
                # 算法内部 u_target = u_j - ε·e^{-id} 让 push 后 arg(u_j-u_i')=-d.
                # algo_wp = 算法跑的几何 (起点 u_i, 终点 u_target ≈ u_j).
                # display_path = algo_wp 末端补 u_j (视觉表 ε→0 极限). 跟 runner 一致.
                u_i_f = complex(U_list[i])
                val, info = compute_Sd_entry(
                    U_list, A_global, m_sizes,
                    i, j, d, waypoints=None,
                    target_ratio=0.5, eps_factor=0.3,
                    p_base=400, p_factor=3, verbose=False,
                )
                algo_full = [u_i_f] + list(info['algo_wp'])
                display_path = list(algo_full) + [complex(U_list[j])]
                chamber_data['entries'][f'{i},{j}'] = {
                    'value_re': float(val.real),
                    'value_im': float(val.imag),
                    'path': pack_path(display_path),
                    'tau_code': float(info['tau_code']),
                    'theta_t_lift': float(info['theta_t_lift']),
                }
                print(f"  ({i},{j}): {val:.5e}  (path 段数 {len(display_path)-1})")
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
