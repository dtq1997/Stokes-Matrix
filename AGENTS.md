# Path Algebroid Viz — AI Agent 工作手册

**Codex + Claude 双家合作维护**. 任何一家上手都能独立工作, 不需要查另一家的私有 memory.
共享 SSOT 是 `STATUS.md` + `CONTRIBUTING.md` + `web/README.md` + git log + commit
messages. Gemini 不参与 sd-viz.

## 用户身份

唐乾 (Qian Tang), 清华博后。徐晓濛组 (Stokes phenomenon, isomonodromy, q-Painlevé) + 张友金/刘思齐组 (Frobenius 流形, WDVV 方程, 可积系统)。沟通用中文, 技术术语保留英文, 语气直接不客套。

用户终端用户是数学家 (做差分方程 / isomonodromy / Stokes 现象). UI 必须全英文,
不出现实现 jargon (sage / backend / tunnel / tq Richardson / PL push 等),
数学家词汇 (chamber, wall-crossing, anti-Stokes ray, entry (i, j), residue
matrix A, Stokes matrix S_d, direction d) 保留.

## 启动必读

动手前先 cat:

1. 本文件全部
2. `STATUS.md` — 当前部署状态 + 算法栈 + 路线图 + 踩坑 (Codex 接手须知在 §7)
3. `CONTRIBUTING.md` — 改前端 / 数据 / 后端的防坑清单
4. `web/README.md` — frontend build / deploy / e2e 流程
5. 父项目 `../../paperYangian` 的 `Sect:PathAlg` (按需查行号, 不读全文)

## 核心规则

### 工程纪律

- **改完前端代码必须跑 `npm run test:e2e` 确认全 PASS** 再让用户刷浏览器
- TypeScript 类型检查 (`npm run typecheck`) 不抓 runtime 错 (TDZ, hoisting, undefined access). 必须靠 e2e
- 装新依赖前看 `package.json` 已有的, 不重复
- 不写无意义注释 (复述代码 / 引用任务 / 加 emoji)
- 不主动加错误 fallback / 抽象层 / 设计模式, 三处重复才考虑抽象

### 数据契约

`web/public/data/*.json` 是 source of truth (frontend serve 路径), schema
见 `web/src/lib/types.ts` 的 `SimpleDataset`. 当前是 v5_full + high
precision (`_v5.p1=500, p2=1500`, residual 机器精度).

新增数据字段:
1. 同时改 `types.ts` 的 interface
2. 改 `data/export_*.sage` 输出
3. **手动 `cp data/n4_*.json web/public/data/`** (CI 不做这步)
4. 加 e2e test 验证字段被消费

### Drag / 几何

D3 drag 在 viewBox 缩放下 `event.x/y` 不靠谱。**必须** 用:
```ts
const [px, py] = d3.pointer(event.sourceEvent, this.svg.node());
const newPos = this.toPlane(px, py);
```
不要回到 `event.x` 那套。详见 `STATUS.md` 已知踩坑。

`viewBox` 必须包含**所有 chamber 所有 path 的 waypoints**, 不只 punctures。否则 vertex 渲染在视野外, drag boundingBox 报告位置错。

### Computing 锁

Recompute 进行中所有用户输入都锁定 (`setComputingLock(true)`):
- puncture / path-vertex drag (canvas `interaction-locked` class + d3.drag.filter)
- n / m_k inputs, U/A 表 inputs, Reset button, precision select, d input/slider
- Cancel button **保留可点**

任何 try/catch/finally 的 finally 块都必须 `setComputingLock(false)` 解锁,
不然 user input dead.

### 视觉

- Dark theme, 配色见 `src/styles/main.css` `:root` 变量
- 字体: Inter (UI) + JetBrains Mono (数据) + KaTeX (数学)
- 虚数单位 i 用正体 (`.im-unit` class, serif font), 跟 LaTeX \mathrm{i} 一致
- 不要用 emoji, 不要 matplotlib 风格
- 演示给同行用, 视觉必须专业

### 不做的事

- 不接 loday 算法; 后端 Stokes 计算只用 v5 pipeline (= tq 无穷连乘 + isoeq pusher + wall-crossing)
- 不在 demo 里展示 ω / matrix_stokes_v2 / ore_algebra 这些底层
- 不脑补辫子群作用直到用户教 paper Phase 4 (`Lem:Leb`, `Pro:PathtoUq`)
- 不写 markdown 描述任务, 改代码 + 改文档就够
- 不改 `.github/workflows/deploy.yml` 中 `VITE_BACKEND_URL` (会让 live frontend 找不到 backend)
- 不动 `compute_sd_v5_full.sage` / `compute_Sd_entry.sage` / `dataset_builder.sage` 等已稳定的整合层 (除非用户明说)

## 子任务模板

- **加新 Phase**: 改 `STATUS.md` 的路线图, 不要散落在多个 .md
- **改数据 schema**: 改 export sage + types.ts + `cp` 到 public/data/ + 重跑 e2e
- **加 UI 元素**: 先在 `index.html` 加占位 div + `main.ts` 装内容; 不直接改 `canvas.ts`
- **改 backend**: 改 `server/push_server.py` 或 `server/dataset_builder.sage`, 然后
  ```
  launchctl bootout gui/$(id -u)/org.dtq1997.sd-viz-backend
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.dtq1997.sd-viz-backend.plist
  ```
  重启 launchd 服务. launchd 跑的是 mac 本地代码, 改完直接生效.

## 多 AI 协同 (历史背景 + 当前)

2026-05-12 起 **Codex + Claude 双家合作维护** sd-viz. Gemini 不参与.

合作规则:
- 任一家拿这份 AGENTS.md + STATUS.md + CONTRIBUTING.md + 仓库 git log
  就能独立工作, 不需要查另一家的私有 memory.
- 重大决策 (架构 / 第二层乘法实现 / promote default 等) 由用户拍板, 不
  自作主张; 拍板后 commit message + STATUS.md 双线记录.
- Lock 协议: 两家同时编辑同一文件时, 改前在 commit message 说清楚区域;
  pull 后开工, 不假设上一次的 git tip 还有效.

