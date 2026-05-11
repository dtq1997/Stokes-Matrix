# sd-viz / web — Build & Deploy

> 这是 sd-viz 前端（Vite + TypeScript + D3 + KaTeX）的本地开发 / 测试 / 部署说明。
> 项目层面的产品介绍、Phase 路线、用户身份等见 `../README.md` 和 `../AGENTS.md`。
>
> 写于 2026-05-11。

---

## 快速命令

```bash
cd 60-outputs/sd-viz/web
npm install                # 一次
npm run dev                # 本地 dev server, http://localhost:5174
npm run typecheck          # tsc --noEmit
npm run test:e2e           # Playwright e2e (必须全 PASS 才能 push)
npm run test:e2e:headed    # 同上, 显示浏览器
npm run build              # 静态构建到 dist/
npm run preview            # 预览 build 产物
```

数据契约：`web/public/data/*.json` 是 source of truth，schema 见 `web/src/lib/types.ts` 的 `SimpleDataset`。

---

## Deploy（Codex / Claude / Gemini 任何新 AI 必读）

GitHub Actions（`60-outputs/sd-viz/.github/workflows/deploy.yml`）在 push main 后自动部署到
`https://dtq1997.github.io/Stokes-Matrix/`。

**但 deploy 之前 CI 会先 typecheck + 跑 Playwright e2e。e2e 失败 = 不 deploy = 用户看不到任何改动。**

### CI 流水线（参考，不要复制到别处）

```
push main
  → npm ci
  → npm run typecheck
  → npx playwright install --with-deps chromium
  → npm run test:e2e            ← e2e 挂这里 = 全流水线挂, 不 deploy
  → npm run build (VITE_BASE=/Stokes-Matrix/)
  → upload-pages-artifact
  → deploy-pages
  → verify (live HTML/JS/JSON SSOT marker check)
```

最后那个 `verify` job 会拉 live 站，确认 bundle 不是旧版、dataset schema 和当前 source 一致。这两层卡点都过了才算真部署成功。

### 强制流程（改前端任何文件都要走）

1. **本地 e2e**：`npm run test:e2e` → 必须全 PASS
2. **本地 runtime 自检**：跑 dev server，curl 关键页面 + 用户截图浏览器自检（**Claude/Codex 没浏览器和 devtools 访问，必须用户反馈**）
3. **push 后立即** `gh run watch` —— 等 CI 跑完，绿了才算部署成功
4. **用户刷新前**：等 5-10 分钟（GitHub Pages CDN 延迟）。部署后默认给 dataset 加 cache-bust 参数

### 失败诊断

- e2e 本地失败 → `npx playwright test --debug` 看哪个 spec 挂了
- CI deploy 失败 → `gh run view <run-id> --log-failed`
- 用户说"看不到改动" → 依次确认
  1. CI 整条都绿了（不只是 build job，还包括 deploy + verify）
  2. 等够 5-10 分钟
  3. 让用户 hard refresh (`cmd+shift+R`)
  4. 查 dataset URL 是否带新的 cache-bust 参数

### 不要做的事

- ❌ `push --force` 到 main
- ❌ 跳过 e2e（"我手动测过了" 不算）
- ❌ 假设 `tsc --noEmit` 通过 = runtime 不炸（TDZ、hoisting、`undefined` access 都过 tsc 但 runtime 崩）
- ❌ viz 类问题靠 curl + 推理判断（必须用户截图 / console 反馈）

---

## 交互约定（改 viz 前要知道）

详见 `90-meta/conventions.md` §3.2 / §3.3，本节是摘要：

1. **拖 d 时画布不旋转**：仅 cuts 跟方向 d 旋转，punctures / paths 的屏幕位置稳定不变。
2. **显示路径必须如实**：viz 上画出来的几何必须是算法实际走的几何。禁止把 `u_target → u_j` 简化成 `u_i → u_j` 直线（会让算法 bug 在视觉上隐身）。
3. **d → chamber 用 interval-contained**：方向 d 映射 chamber 用 `d ∈ [l, r)` 区间包含判定，不用最近 center。chamber 不等宽时 nearest center 会反直觉错位。

---

## 参考

- 上层 README：`../README.md`
- AI 工作手册：`../AGENTS.md`、`../CLAUDE.md`（两份必须同步）
- 项目状态：`../STATUS.md`
- 项目级约定：`90-meta/conventions.md`
- CI workflow：`../.github/workflows/deploy.yml`
