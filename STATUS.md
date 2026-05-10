# Path Algebroid Viz — Status & 路线图

Last updated: 2026-05-10 [Claude]

## Phase 1.0 (当前) — n=4 simple, 静态可视化

### ✅ 已完成

- 复平面主画布 (D3 SVG, dark theme)
- Punctures 可拖, cuts 沿 -d 方向自动重排
- Path γ_ij^(d) 显示 + 中间 vertex 同伦类内可拖
- d slider 连续 0..2π, anti-Stokes ray + chamber center marker 条
- 4×4 entry grid 选择
- (S_d)_ij 数值面板 (KaTeX)
- Path-path 交点自动算 (绿点)
- Playwright e2e smoke test 5/5 PASS (load / entry / vertex drag / puncture drag / d slider)
- GitHub Actions CI deploy to gh-pages

### 已知限制

- 拖动 path vertex 期间不做同伦类检测 (扫掠三角形对高瘦 path 退化, false positive). drag end 应该加 winding number 检测, 见 Phase 1.5
- 拖 puncture 时 Stokes 不重算 (后端 push endpoint 是占位)
- 跨 cut 时 lift twist 没显示提示 (cutCrossings 已实现, UI 没接)
- 只支持单 entry 选择, multi-entry path-path 交点演示需 ctrl/shift 加选 UI
- Chamber 区域填色没做 (只有 cut 线)

## Phase 1.5 (下一步) — 后端接通 + 完善检测

- [ ] `server/push_server.py` 接通 isoeq pusher, 拖 puncture 松手后异步重算所有 chamber × entry, 返回新 JSON
- [ ] Drag end 加 winding number 同伦类整体检测; 跨 puncture 整条 path 回弹 + 警告
- [ ] 跨 cut 时 UI 提示 lift twist (右侧 path-info 加 "lift jumped from k to k±1")
- [ ] Multi-entry 选择 UI (ctrl/shift 加选, path-path 交点高亮 hover 显示 (i,j,k,l, t1, t2))
- [ ] Chamber polygon 填色 (anti-Stokes ray 切分复平面成多边形)

## Phase 2 (待用户教数学) — Goldman bracket / 第二层乘法

依赖 paperYangian:
- `Lem:Leb` — 代表元交点处的手术规则
- `Pro:PathtoUq` — 第二层乘法到 Uq 的映射

UI: 点交点 → 弹两条参与的 path → 选手术方向 → 显示乘积 path

## Phase 3 — 重数 / Jordan 块支持

- 接已有 `compute_Sd_entry` 的块版 (memory `project_loday_block_d_validated`)
- entry grid 改成 block index, 每个 block (i,j) 显示矩阵元 (m_i × m_j)

## Phase 4 — 辫子群作用

paperYangian Phase 4 的 K_i^- X K_i^+ 可视化:
- 拖 puncture 跨 anti-Stokes ray → 触发 K-action 动画
- chamber 切换时 entry 跳跃由 wall-crossing 公式给出

## Engineering 路线

- [x] Vite + TypeScript + D3 + KaTeX 项目结构
- [x] Playwright e2e smoke (5 case)
- [x] GitHub Actions CI deploy
- [x] AGENTS.md / CLAUDE.md / CONTRIBUTING.md / README.md
- [ ] 拆 `canvas.ts` (280 行) 成 ViewBox / Renderer / DragLayer 三个文件
- [ ] ESLint + Prettier
- [ ] 错误 UI 友好化 (网络错 / 数据错 区分)
- [ ] Storybook 或类似工具展示组件单测

## 已踩坑 (新 AI 启动前看)

详见 `CONTRIBUTING.md` 的"关键禁忌"表。
