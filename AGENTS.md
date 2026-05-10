# Path Algebroid Viz — AI Agent 工作手册

(Codex / Claude / Gemini 共享; Claude 看的是 `CLAUDE.md`, 两份必须同步)

## 用户身份

唐乾 (Qian Tang), 清华博后。徐晓濛组 (Stokes phenomenon, isomonodromy, q-Painlevé) + 张友金/刘思齐组 (Frobenius 流形, WDVV 方程, 可积系统)。沟通用中文, 技术术语保留英文, 语气直接不客套。

## 启动必读

动手前先 cat:

1. 本文件全部
2. `CONTRIBUTING.md` — 改前端 / 数据 / 后端的防坑清单
3. `STATUS.md` — 当前 Phase 进度 + 已知 bug + 路线图
4. 父项目 `../../paperYangian` 的 `Sect:PathAlg` (按需查行号, 不读全文)

## 核心规则

### 工程纪律

- **改完前端代码必须跑 `npm run test:e2e` 确认全 PASS** 再让用户刷浏览器
- TypeScript 类型检查 (`npm run typecheck`) 不抓 runtime 错 (TDZ, hoisting, undefined access). 必须靠 e2e
- 装新依赖前看 `package.json` 已有的, 不重复
- 不写无意义注释 (复述代码 / 引用任务 / 加 emoji)
- 不主动加错误 fallback / 抽象层 / 设计模式, 三处重复才考虑抽象

### 数据契约

`web/public/data/*.json` 是 source of truth, schema 见 `web/src/lib/types.ts` 的 `SimpleDataset`。

新增数据字段:
1. 同时改 `types.ts` 的 interface
2. 改 `data/export_*.sage` 输出
3. 加 e2e test 验证字段被消费

### Drag / 几何

D3 drag 在 viewBox 缩放下 `event.x/y` 不靠谱。**必须** 用:
```ts
const [px, py] = d3.pointer(event.sourceEvent, this.svg.node());
const newPos = this.toPlane(px, py);
```
不要回到 `event.x` 那套。详见 `STATUS.md` 已知踩坑。

`viewBox` 必须包含**所有 chamber 所有 path 的 waypoints**, 不只 punctures。否则 vertex 渲染在视野外, drag boundingBox 报告位置错。

同伦类内拖动检测: 当前 Phase 1 不在 drag 期间检测 (扫掠三角形对高瘦 path 退化, false positive). Phase 1.5 加 winding number 整体检测在 drag end。

### 视觉

- Dark theme, 配色见 `src/styles/main.css` `:root` 变量
- 字体: Inter (UI) + JetBrains Mono (数据) + KaTeX (数学)
- 不要用 emoji, 不要 matplotlib 风格
- 演示给同行用, 视觉必须专业

### 不做的事

- 不接 loday 算法 (`feedback_path_algebroid_no_loday`); 后端 Stokes 计算只用 tq 无穷连乘 + isoeq pusher
- 不在 demo 里展示 ω / matrix_stokes_v2 / ore_algebra 这些 backend
- 不脑补辫子群作用直到用户教 paper Phase 4 (`Lem:Leb`, `Pro:PathtoUq`)
- 不写 markdown 描述任务, 改代码 + 改文档就够

## 子任务

- **加新 Phase**: 改 `STATUS.md` 的路线图, 不要散落在多个 .md
- **改数据 schema**: 同时改 export sage + types.ts + 重跑 e2e test
- **加 UI 元素**: 先在 `index.html` 加占位 div + `main.ts` 装内容; 不直接改 `canvas.ts`
- **后端接通**: 改 `server/push_server.py`, `data.ts` 的 `pushPuncture` 已经准备好契约

## 多 AI 协同

- 写入共享区域 (`STATUS.md`, `CONTRIBUTING.md`) 标 `[Claude]` / `[Codex]` / `[Gemini]`
- 不假设你之前的 git commit 还在; pull 后再开工
- 复杂决策 (架构 / 第二层乘法实现) 由用户确认, 不自作主张
