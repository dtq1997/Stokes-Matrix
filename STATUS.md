# sd-viz — Status & 维护手册

Last updated: 2026-05-12 [Claude] — Codex + Claude 双家合作维护协议见 §7.

---

## 0. 一句话

`https://dtq1997.github.io/Stokes-Matrix/` 部署的 Stokes 矩阵交互可视化, 真实
后端 (用户 mac 上 sage push_server, Cloudflare named tunnel 暴露为
`https://sd-viz.dtq1997.org`) 通过 GitHub Pages 跨源 fetch 调用. 主要观众
是数学家, UI 全英文 + 不出现实现 jargon.

## 1. 当前生效部署

**Live URL**: `https://dtq1997.github.io/Stokes-Matrix/`

**Backend tunnel**: `https://sd-viz.dtq1997.org`
- DNS: Cloudflare zone `dtq1997.org`, CNAME → cloudflared named tunnel `bridge` (UUID `442ee821-9653-4af3-b4c8-87c44340c564`)
- cloudflared 由 launchd 管: `~/Library/LaunchAgents/org.dtq1997.bridge-tunnel.plist`
- 配置文件: `~/.cloudflared/config.yml`, ingress `sd-viz.dtq1997.org → http://localhost:8000`
- 改完 config.yml 用 `kill -HUP <cloudflared_pid>` reload, 不重启

**Backend (sage push_server)**:
- launchd: `~/Library/LaunchAgents/org.dtq1997.sd-viz-backend.plist`
- 路径: `60-outputs/sd-viz/server/push_server.py`, 由 `sage -python push_server.py` 启
- 端口 127.0.0.1:8000, CORS 已开 `["*"]`
- 日志: `~/Library/Logs/sd-viz/push_server.log`
- RunAtLoad + KeepAlive + ThrottleInterval=10 (crash 10s 内自动重启)
- 改 push_server 后重启:
  ```
  launchctl bootout gui/$(id -u)/org.dtq1997.sd-viz-backend
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.dtq1997.sd-viz-backend.plist
  ```

**Frontend 部署**:
- `60-outputs/sd-viz/` 是独立 git repo: `github.com/dtq1997/Stokes-Matrix`
- `.github/workflows/deploy.yml`: push main → typecheck + e2e 10/10 + build (with `VITE_BACKEND_URL=https://sd-viz.dtq1997.org`) → GH Pages
- 部署成功后 GH Pages CDN 5-10 min propagate, 用户硬刷新 (Cmd+Shift+R)

**数据**:
- `web/public/data/n4_simple.json` + `web/public/data/n4_block.json` 是 v5_full + high precision 静态 dataset (`_v5.p1=500, p2=1500`, residual 机器精度)
- `data/n4_*.json` 是 sage export 的输出位置; 改后**必须 `cp` 到 `web/public/data/`** 才能被 frontend 用 (CI 不做这步)
- 历史 medium-precision baseline backup 在 `data/snapshots/2026-05-12-pre-v5-medium-baseline/`

## 2. Stokes 计算算法 (v5 pipeline)

唯一 default 路径 (legacy 仅作 fallback / oracle):

```
v5 word path                       直线段几何 word, 端点幅角 lift
  ↓
isoeq pusher + tq tail             ρ([i] Σ_geom [j]), 每对 (i, j) 一次
  (asymptotic_tail + auto χ_s/ψ_s, Jordan-safe matrix argument)
  ↓
sign-hypercube BFS                 (S_{d_reg})_kt = ρ([i] 全 - [j])
  ↓
single wall-crossing rule          由 S_{d_reg} 算所有 chamber 的 S_d
+ multi-swap reduced-word          (任意 same-angle multi-ray 退化)
+ cyclic 2π sandwich               cross d → d+2π 关闭
  ↓
chamber cache + 2π lift            任意 d → S_d
```

**详细文档** (上层 academic-formula-workbench 主仓库):
- `90-meta/Sd-v5-pipeline-report.md` — 算法栈 + 验证证据 + 接口
- `90-meta/conventions.md` §2.8-§2.11 — 数学约定
- `90-meta/Sd-v5-degenerate-wall-yang-baxter.md` — 退化 wall + reduced-word independence
- `90-meta/Sd-v5-migration-plan.md` — 整合迁移完整轨迹

`compute_Sd_entry(...)` 主入口 default `use_v5_pipeline=True`, content-fingerprint
chamber cache, NotImplementedError 透明 fallback legacy.

## 3. Frontend 当前 UI 状态

```
[左栏: Configuration (U, A, d)]              [右栏: Stokes matrix S_d]
├ n input + m_k inputs (m = Σ m_k = N)       ├ N×N grid (点击 cell 选 entry)
├ precision select (low/medium/high)         ├ Selected entry display
├ Leading term U = diag(...)                 └ Path info γ_ij^(d)
│  └ table: Re/Im/m_k per puncture
├ Residue matrix A
│  └ N×N table: Re input | Im input + i suffix
├ [Recompute Stokes] [Reset]
│  └ progress: 4 阶段 checkbox + ETA
└ Direction d ∈ [(2k-1)π, (2k+1)π) (k 跟用户输入)
   ├ d input (units of π)
   └ slider + ray markers
```

**关键 invariants**:
- 默认 d = `_v5.d_reg`, k=0 branch `[-π, π)`. 输入 d=2.3 → k=1 branch `[π, 3π)`
- A 虚部输入框尾巴有 `i` 标记 (`.im-unit` class, 正体 serif font)
- 改 m_k 触发 `applyBlockResize`: A 维度跟 N=sum(m) 同步, 变小取左上子矩阵, 变大补 0
- Computing 进行中所有 input 锁定 (`setComputingLock(true)`), puncture drag + path-vertex drag 不响应
- UI 全英文, 不出现 sage / backend / tunnel / tq Richardson / PL push 等技术 jargon. 数学家词汇 (chamber, wall-crossing, anti-Stokes ray, entry, residue matrix, Stokes matrix, direction) 保留.

## 4. 已验证, 不要重启的

- 算法层: v5_full 跟 oracle 一致到 chamber data 精度地板 (`tests/diag_*` 全 PASS)
- Wall-crossing: braid + commutation reduced-word independence 验证到 1e-15
- Tunnel 链路: GH Pages 跨源 fetch → cloudflared → push_server → recompute_runner → sage runner
- e2e 10/10 PASS (含 v5_full null-path fixture + 部署 SSOT 检查)
- launchd crash recovery 测过

## 5. 路线图 (按优先级)

### 短期 (codex 接手时可做)

- [x] **tq 矩阵无穷连乘升级**: 用 h-差分典范解的幂级数展开改 `50-computation/stokes_skeleton.sage` truncation loop. 当前 live 后端默认 `asymptotic_tail + tail_order='auto'`, 三后端 numpy/mpmath/CBF 均可用；`A_{ss},A_{tt}` 的近 Jordan/Jordan 代入走 Cauchy functional-calculus fallback.
- [ ] **A-only push 实时拖拽**: 拖 puncture 时只跑 isoeq push (~2ms/帧, 不重算 Stokes), 拖完才触发 v5 重算. 让用户感觉到"A 跟着 u 实时演化". 后端要加 `/api/push_a_only` endpoint, 前端 onPunctureDrag 改 throttled 调用.

### 中期

- [ ] tq 升级后, 看 base case 是否能并行 (n*(n-1) ordered pairs 互相独立)
- [ ] 块版 Jordan 支持 (现 v5 处理 simple-spectrum block; Jordan 退化已知精度退档 1e-4)
- [ ] Multi-entry 选择 UI (现在每次只能选一个)
- [ ] Chamber 填色 (rays 切复平面成多边形)

### 长期 (依赖 paperYangian 内容)

- [ ] Phase 2 — Goldman bracket / 第二层乘法 (Lem:Leb + Pro:PathtoUq)
- [ ] Phase 4 — 辫子群作用 (paper Phase 4 的 K_i^- X K_i^+)

## 6. 已踩坑 (新 AI 看)

详见 `CONTRIBUTING.md`. 最常见 4 个:

1. **`web/public/data/*.json` 跟 `data/*.json` 不自动同步**. sage export 写到 `data/`, 但 frontend serve 的是 `web/public/data/`. 改了 dataset 必须 `cp data/n4_*.json web/public/data/`.
2. **D3 drag 在 viewBox 缩放下** `event.x/y` 不靠谱. 必须 `d3.pointer(event.sourceEvent, svg)` + `toPlane(...)`.
3. **TypeScript typecheck 不抓 runtime TDZ / hoisting**. 必须靠 e2e (e.g. 在 d3-drag setup 引用未初始化的 `currentK` → page crash, typecheck PASS).
4. **build 用 `VITE_BACKEND_URL` env var** 把 tunnel URL 编进 JS bundle. CI 已配, 本地 dev 也用同样 env (`env VITE_BACKEND_URL=https://sd-viz.dtq1997.org npm run dev`).

## 7. AI 维护协议 (2026-05-12 起)

**Codex + Claude 双家合作维护**, 任一家都能独立工作. Gemini 不参与.

1. 本 STATUS.md + AGENTS.md + CONTRIBUTING.md + README.md + web/README.md 是
   双家共享的 SSOT, **不依赖任何一家的私有 memory**. 进入仓库的 AI 拿这几份
   文档 + git log 就能完整理解架构、决策和踩坑.
2. 一家上手前 pull 一次, 别假设上次 commit 还是 git tip.
3. **Mac 端 launchd 服务**由用户管 (用户重启 mac 时自动恢复, AI 不动). AI
   只管 git repo 代码.
4. 用户后续重大任务: **tq 矩阵无穷连乘升级** (见 §5 短期第一条). 数学母版在
   `~/research/notes/Analytic theory of difference equations.tm` + 主仓库
   `60-outputs/formula-notes/formula-notes-cn.tex` 的 h-差分 section. SSOT
   改造点是 `50-computation/stokes_skeleton.sage` 的 truncation loop
   (line 171-175). 不要去碰 `compute_sd_v5_full.sage` / `compute_Sd_entry.sage`
   / `dataset_builder.sage` 等已稳定的整合层.
5. **不动 `.github/workflows/deploy.yml` 中 `VITE_BACKEND_URL`**; 改后会让
   live frontend 找不到 backend.
6. **不动 `web/public/data/*.json` 跟 `data/*.json` 的同步**, 现在是 sage
   export → 手动 cp → commit, 没有 CI 自动化. 改了 dataset 自己同步.
7. **改前端**: 流程是 `npm run typecheck` → `npm run build` → 本地起 dev
   server 跑 `npm run test:e2e` (10/10 必须 PASS) → commit → push → CI
   deploy. e2e 不靠 CI 抓 runtime 错也跑.
8. **改 backend (push_server.py / dataset_builder.sage)**: 后端是 launchd
   管的, 改完用 §1 的 launchctl bootout/bootstrap 命令重启. 本地 sage 跟
   backend 是同一份代码 (launchd 跑 mac 本地文件).

## 8. 关键文件索引

| 文件 | 用途 |
|---|---|
| `web/index.html` | UI 骨架 |
| `web/src/main.ts` | 主入口, state + UI logic + recompute orchestration |
| `web/src/components/canvas.ts` | SVG 复平面, D3 drag, cuts/punctures/paths 渲染 |
| `web/src/lib/data.ts` | Backend API client (loadDataset, recomputeAsync, getBackendBase) |
| `web/src/lib/types.ts` | TypeScript schema (SimpleDataset, JobStatus, SdEntryData) |
| `web/src/lib/geometry.ts` | chamberOfDirection, monodromyTransforms |
| `web/src/styles/main.css` | CSS, dark theme, lock styles, .im-unit 正体 |
| `web/e2e/smoke.spec.ts` | Playwright e2e 10 tests |
| `web/public/data/n4_*.json` | 静态 dataset (frontend serve) |
| `server/push_server.py` | FastAPI + uvicorn, /api/recompute /api/job /api/dataset |
| `server/recompute_runner.sage` | sage subprocess, 调 build_chambers |
| `server/dataset_builder.sage` | v5_full / legacy_entry 路径 + STAGE emit |
| `data/export_n4_*.sage` | 重新生成 static dataset (本地手动跑) |
| `data/smoke_legacy_entry.sage` | legacy 路径 smoke (codex 2026-05-12 加) |
| `data/snapshots/` | 历史 dataset backup |
| `.github/workflows/deploy.yml` | CI: typecheck + e2e + build + GH Pages |
