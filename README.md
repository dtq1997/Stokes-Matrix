# Path Algebroid Viz — Stokes Matrix Interactive Visualizer

[![Live Demo](https://img.shields.io/badge/demo-live-2ea44f)](https://dtq1997.github.io/Stokes-Matrix/)

非奇异 ODE 系统 Stokes 矩阵 + path algebroid 的交互式可视化。每个 entry $(S_d)_{ij}$ 对应代数胚里 $\boldsymbol{\gamma}_{ij}^{(d)}$ 的几何代表元 — 用户可以拖动顶点（同伦类内）、拖动 punctures（沿 isomonodromy 流演化 A）、连续切换方向 d。

## 功能

- **左侧** $n \times n$ entry grid: 点击 $(i,j)$ 选 entry, 主画布显示对应 path
- **中间画布**: 复平面, punctures (蓝点, 可拖) + cuts (沿 $-d$ 方向虚线) + path (紫线, 顶点可拖)
- **右侧** Stokes 数值面板: $(S_d)_{ij}$ 实部/虚部 + path 元数据
- **底部 d slider** ($0$ 到 $2\pi$ 连续): 拖动时 cuts 实时旋转, chamber 自动跟随; 下方 marker 条标记 anti-Stokes rays (紫线) 和 chamber 中心 (绿短线)
- **拖动 path vertex**: 同伦类内自由调整几何代表元
- **拖动 puncture**: cuts 跟随重排; Stokes 数值会通过后端 isomonodromy 流重算 (Phase 1.5 接通)
- **多 entry 选择**: path-path 交点显示绿点 (Phase 2 准备)

## 启动

### 前端

```bash
cd web
npm install
npm run dev   # http://localhost:5174
```

构建静态站点：

```bash
npm run build  # 输出到 web/dist/
```

### 后端 (可选, Phase 1.5)

```bash
cd server
sage -pip install fastapi uvicorn   # 一次
sage -python push_server.py         # http://127.0.0.1:8000
```

后端提供 `POST /api/push`, 给定 $(k, u_k')$ 沿 isomonodromy 流演化 $A$, 返回新 Stokes 数据。

### 数据生成 (可选, 需父项目)

`data/n4_simple.json` 已 commit。重新生成需要 [academic-formula-workbench](../../) 父仓库的 `50-computation/`:

```bash
sage data/export_n4_simple.sage   # 5 分钟, 168 entry
```

## 数学背景

详见父项目 `paperYangian` 的 Sect:PathAlg。简要：

- $\nabla = d - (U + A/z) dz$, $U = \mathrm{diag}(u_1, \ldots, u_n)$, $A$ 任意 $n \times n$ 复矩阵
- $S_d$ = $z = 0$ 处 canonical solution 沿方向 $d$ 的 Stokes 矩阵, $d \notin aS(u)$
- $(S_d)_{ij}$ = path algebroid 元素 $\boldsymbol{\gamma}_{ij}^{(d)}$ 在表示 $\mathcal{S}: \mathrm{PathAlg} \to \mathrm{Mat}_n$ 下的值

## 测试

```bash
cd web
npm run typecheck    # tsc --noEmit
npm run test:e2e     # playwright headless
npm run test:e2e:headed  # 浏览器可视化
```

## 工程化文档

- [`AGENTS.md`](AGENTS.md) — Codex 工作手册
- [`CLAUDE.md`](CLAUDE.md) — Claude 工作手册  (与 AGENTS.md 共享核心规则)
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — 改前端/数据/后端的防坑清单
- [`STATUS.md`](STATUS.md) — 当前实现进度 / Phase 路线图

## 架构

```
web/                          Vite + TypeScript + D3 前端
├── src/
│   ├── main.ts               app 入口, 三栏布局组装
│   ├── lib/
│   │   ├── types.ts          数据契约 (SimpleDataset / PathRep)
│   │   ├── geometry.ts       segment 交点 / triangle / cut crossing
│   │   └── data.ts           fetch / push API
│   ├── components/
│   │   └── canvas.ts         主画布 (D3 SVG, drag, render layers)
│   └── styles/main.css       dark theme
├── public/data/              静态数据 (gh-pages 直接 serve)
├── e2e/                      playwright smoke tests
└── dist/                     vite build 产出 (gitignored)

server/                       FastAPI push 后端 (依赖 sage)
data/                         sage exporter + JSON
```

## 部署

GitHub Actions 自动构建 + 部署 `web/dist/` 到 `gh-pages` 分支, 见 `.github/workflows/deploy.yml`。

## License

Academic use; for research collaboration contact 唐乾 (Qian Tang), 清华大学。
