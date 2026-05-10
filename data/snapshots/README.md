# Dataset snapshots

每次重要 dataset 在这里存一份带 timestamp 的副本, 防止 export 重跑覆盖.

命名: `n4_{simple,block}-YYYY-MM-DD-{precision}-{note}.json`

恢复: `cp snapshots/<file>.json ../n4_{simple,block}.json`

当前 baseline:
- 2026-05-11 medium: 第一份成功的 simple + block dataset, sample d 单调递增 + paper monodromy phase 修正后, 12 个 (i,j) 跨自己 self-ray 全 flat (simple); block (1,2) 完整 2×2 跨 self-ray 全不变到 4 位精度 (block).

旧版本可通过 git 历史拿: `git log --oneline -- ../n4_block.json`
然后 `git show <hash>:60-outputs/sd-viz/data/n4_block.json > snapshots/recovered.json`.
