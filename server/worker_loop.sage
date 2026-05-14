"""Persistent sage worker loop.

Phase 1a: 长寿 sage 进程, 从 stdin 读 job spec, 调 recompute(), 输出结果.
push_server.py via worker_pool.py spawn 一个该进程, 跨多次 /api/recompute
请求复用 → 节省每次 ~4s sage cold start.

Stdin 协议 (line-delimited JSON):
  {"job_id": "<hex>", "in_path": "<path>", "out_path": "<path>"}

Stdout 协议:
  WORKER_READY                                     spawn 完成
  STAGE ... / PROGRESS chamber N/M                  (recompute 内部, 透传)
  JOB_DONE <job_id> ok                              成功完结
  JOB_DONE <job_id> error:<ExceptionClass>          异常完结
  WORKER_TRACE <job_id> <line>                      异常时 traceback (多行)

Worker 自己永远不退出 (除非 SIGTERM 或 stdin EOF).
"""
import os, sys, json, traceback, gc, time, builtins, signal

py_int = builtins.int

_WS = "/Users/dtq1997/ai/workspace/academic-formula-workbench"
sys.path.insert(0, os.path.join(_WS, "50-computation"))
sys.path.insert(0, os.path.join(_WS, "60-outputs/sd-viz/server"))

# 加载 recompute_runner — 它会触发 sage core + 我们的 sage modules 一次性加载,
# 同时跑 _prime_mpmath_caches() (Phase 2 PARI 段错预防).
# 这是 worker spawn 时一次性付的开销 (~4s); 此后每次 job 不再付.
load(os.path.join(_WS, "60-outputs/sd-viz/server/recompute_runner.sage"))


# Phase 1c (soft cancel): SIGINT → raise KeyboardInterrupt in running compute,
# worker 不退出, 下一个 job 仍接受. 旧行为 (SIGTERM hard kill + respawn) 在
# worker_pool 端仍保留作 fallback. 保留 1b cache 跨 cancel.
def _on_sigint(signum, frame):
    raise KeyboardInterrupt("job cancelled via SIGINT")
signal.signal(signal.SIGINT, _on_sigint)


# recompute() 现在在 globals 里. 标记 worker 已就绪.
print("WORKER_READY", flush=True)


def _run_job_line(line):
    try:
        msg = json.loads(line)
    except Exception as e:
        # 协议错误, 跳过该行不影响 worker.
        print(f"WORKER_ERROR bad-json {e}", flush=True)
        return
    job_id = str(msg.get('job_id', ''))
    in_path = msg.get('in_path')
    out_path = msg.get('out_path')
    if not in_path or not out_path:
        print(f"JOB_DONE {job_id} error:bad-spec", flush=True)
        return
    try:
        with open(in_path) as f:
            inp = json.load(f)
        result = recompute(inp)
        with open(out_path, 'w') as f:
            json.dump(result, f)
        print(f"JOB_DONE {job_id} ok", flush=True)
    except KeyboardInterrupt:
        # Phase 1c soft cancel — worker stays alive, cache preserved.
        print(f"JOB_DONE {job_id} error:Cancelled", flush=True)
    except Exception as e:
        tb = traceback.format_exc()
        for tline in tb.splitlines():
            print(f"WORKER_TRACE {job_id} {tline}", flush=True)
        print(f"JOB_DONE {job_id} error:{type(e).__name__}", flush=True)
    finally:
        # 每个 job 后主动 gc, 避免长寿 worker 内存爬升 (中间 sage Element 引用易残留).
        gc.collect()


while True:
    try:
        line = sys.stdin.readline()
    except KeyboardInterrupt:
        # SIGINT 在 readline 阶段无害 (没有 in-flight job), 继续等下一行.
        continue
    if not line:
        # Parent closed stdin → exit cleanly.
        break
    line = line.strip()
    if not line:
        continue
    _run_job_line(line)
