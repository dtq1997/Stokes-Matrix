"""SSOT: anti-Stokes rays + chamber_midpoints 共享实现.

Used by:
- 60-outputs/sd-viz/data/export_n4_simple.sage
- 60-outputs/sd-viz/server/recompute_runner.sage

Paper convention: anti-Stokes ray for ordered pair (p, q) is -arg(u_q - u_p) mod 2π.

chamber_midpoints 输出 mid ∈ (-π, π], 不在 [0, 2π).
Why: mid 喂给 compute_Stau 当 tau, 内部 arg_near(., -tau) 选 lift; 若 mid 在 [0, 2π)
约定下相邻 chamber 跨 0/2π wrap (e.g. ch_a mid≈6.09, ch_b mid≈0.06 差 ≈2π), 跨边界
时 lift 集体 +2π 给 entry 多 spurious exp(2πi·(A_ss-A_tt)). 压到 (-π, π] 后相邻
chamber mid 在数轴上连续, lift 不再跳.
"""
import math


def anti_stokes_rays(U):
    """Paper aS(u) = {-arg(u_p - u_q) mod 2π : ordered pairs p≠q}, sorted."""
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
    """相邻 sorted rays 之间的中点 (sample d for each chamber).

    SSOT 关键: sample d 在 ℝ 上**单调递增**, 不 mod 2π. 即所有 sample d 落在
    (rays[0], rays[0] + 2π) 内. Why: chamber 是 cyclic 概念 (n*(n-1) 个), 但 d 在
    ℝ 上; paper Stokes 公式的 lift 选取依赖 d 数值 (不是 mod 2π), 所以 sample d
    跨周期给不同 entry 数值 (paper monodromy). 单调递增让相邻 sample 在 ℝ 上连续,
    inf product 跨 chamber 时 lift 不集体跳 → 没有 spurious 2π·(A_ss-A_tt) 因子.

    viz 滑 d 落在不同周期时, viz 端按 m = round((d_user - d_sample) / 2π) 乘
    exp(2πi · m · (A_ss - A_tt)) phase 修正显示真 (S_{d_user}) (paper monodromy).
    """
    twopi = 2 * math.pi
    out = []
    for k in range(len(rays)):
        a = rays[k]
        b = rays[(k+1) % len(rays)]
        if k == len(rays) - 1:
            b = b + twopi
        mid = (a + b) / 2.0
        out.append(mid)
    return out
