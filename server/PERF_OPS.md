# sd-viz backend perf operations

启动: launchd `org.dtq1997.sd-viz-backend.plist` 自动管. 手动重启:

```bash
launchctl unload ~/Library/LaunchAgents/org.dtq1997.sd-viz-backend.plist
launchctl load ~/Library/LaunchAgents/org.dtq1997.sd-viz-backend.plist
# 或一步:
launchctl kickstart -k gui/$(id -u)/org.dtq1997.sd-viz-backend
```

## 性能架构 (Phase 0-4A, 2026-05-15)

```
HTTP request → push_server.py
                     ↓
            worker_pool.get_worker()  (持久 sage subprocess)
                     ↓
              worker_loop.sage  (recompute, 复用 mpmath bernoulli cache)
                     ↓
         _build_chambers_v5_full
                     ↓
            cache lookup (Phase 1b LRU)
                     ↓ (miss only)
        compute_Sd_chambers_v5 (Phase 4A fork pool 10 children)
                     ↓
        select_Sd_from_chambers + pack
                     ↓
                 response
```

## 环境变量

plist 已配置, 改动后 kickstart 生效.

| 变量 | 默认 | 作用 |
|---|---|---|
| `SD_VIZ_FORK_POOL` | `1` (live) | `1` = fork ProcessPool (Phase 4A, 主路径). `0` 或未设 = 顺序 / ThreadPool fallback |
| `OBJC_DISABLE_INITIALIZE_FORK_SAFETY` | `YES` (live) | macOS fork() 必需, 否则子进程立刻段错 |
| `SD_VIZ_N_JOBS` | (unset) | 强制 n_jobs 值. 设 `1` = 串行调试. 设 N = N 个 worker |
| `SD_ALGORITHM` | `v5_full` | `legacy_entry` 用作 oracle fallback |

## API endpoints

`/api/recompute` POST 触发计算, 返 job_id 立即返.  
`/api/job/{id}` GET 查进度.  
`/api/job/{id}/cancel` POST 软取消 (SIGINT, worker 存活, 缓存保留).  
`/api/worker_stats` GET worker 健康 (alive/pid/jobs_done/spawn_at).

## 排错

| 症状 | 排查 |
|---|---|
| 502 / API down | `ps aux | grep push_server`, 看 launchd 日志 `tail ~/Library/Logs/sd-viz/push_server.log` |
| recompute 永远 running | `curl /api/worker_stats` 看 worker.alive, 若 false 则 `cancel` 触发 respawn |
| 段错 | 设 `SD_VIZ_FORK_POOL=0` 临时关 fork pool, 排查是不是 PARI/mpmath 状态污染 |
| 数值不对 | 跑 `/tmp/perf-baselines/verify_outputs.py baseline.json candidate.json` 对照 |

## 性能 baseline (n=4..5, M4 10 cores)

| dataset | precision | cold | 缓存命中 |
|---|---|---|---|
| n=4 simple | fast | 0.7s | 0.05s |
| n=4 simple | high | 3.6s | 0.05s |
| n=5 simple | medium | 4.3s | 0.05s |
| n=3 block (m=[2,1,1]) | medium | 1.7s | 0.05s |
| n=4 block (m=[2,2,2,2]) | medium | 10.4s | 0.05s |

参考: Phase 0 baseline (无优化) 上述分别 2.2s / 18.8s / 22.5s / 6.5s / 30.5s.
