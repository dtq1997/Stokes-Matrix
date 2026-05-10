# 改 Path Algebroid Viz 防坑清单

每次改前端 / 数据 / 后端前, 先读完。

## 强制流程

### 改前端 (web/src/)

1. **改完跑 typecheck**: `cd web && npm run typecheck`
2. **改完跑 e2e**: `npm run test:e2e` 全 PASS
3. **改 drag / SVG 坐标系**: 必须加 e2e test 验证 (像素级 boundingBox 比对)
4. **改样式**: 不要硬编码颜色, 用 `src/styles/main.css` 的 CSS 变量
5. 不直接 `console.log` 调试, 用 `console.debug`, 推前删除

### 改数据 schema

1. 改 `web/src/lib/types.ts` 的 interface
2. 改 `data/export_*.sage` 字段输出
3. 字段进 JSON 前强制 `float()` (sage `RealLiteral` 不能直接序列化)
4. 重跑 sage exporter, 拷新 JSON 到 `web/public/data/`
5. 加 e2e test 验证新字段被消费

### 改后端 (server/)

1. 后端依赖父项目 `50-computation/isoeq_pusher.sage` 等; sys.path 写死绝对路径在 `push_server.py` 顶部
2. 不要把后端响应 schema 改了不告诉前端 — `web/src/lib/types.ts` 同步改
3. 改完手动 `curl http://127.0.0.1:8000/api/dataset` 验通

## 关键禁忌

| 禁忌 | 后果 | 防护 |
|---|---|---|
| `event.x / event.y` 当 SVG 像素坐标用 | drag 不跟手, vertex 飞远处 | 必须 `d3.pointer(event.sourceEvent, svg)` |
| `fitViewBox` 只看 punctures | path waypoints 落 viewBox 外, hit test 失败 | 把所有 chamber 所有 path 一起 bbox |
| 拖动期间做扫掠三角形 homotopy 检测 | 高瘦三角形退化 false positive 拒绝所有拖动 | drag 期间放任, drag end 用 winding number 整体校验 |
| 用 `enter.merge(sel)` + 在 update 上 `.call(drag)` | 多次 render 累加 listener, drag state 漂 | 用 `.join(enter, update, exit)`, drag 在 enter 块或显式 idempotent call |
| `npm init -y` 默认 `type: commonjs` | ES module import 全报错 | 必须 `type: module` |
| sage `0.5j` 字面量进 sage script | 解析成 `RealLiteral`, JSON 序列化崩 | 用元组 `(re, im)` 或 `complex(re, im)` |
| `cd 60-outputs/...` 在 Bash tool 里持续依赖 cwd | 跨 tool call cwd 不一致 | 用绝对路径 |
| 加 npm 依赖前不查 `package.json` | 重复装 / 版本冲突 | 先看再装 |

## Git

- 推 `main` 前必须本地 typecheck + e2e PASS
- commit 包含改动原因 (why), 不只复述 what
- GitHub Pages 自动部署 `main` 分支推送, 见 `.github/workflows/deploy.yml`

## 加新 Phase

改 `STATUS.md` 的路线图章节, 不另起 .md。Phase 命名跟 paperYangian 对齐 (Phase 1 = 第一层 right-left detour, Phase 2 = Goldman bracket, Phase 4 = braid action)。
