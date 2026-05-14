"""Persistent sage worker pool for sd-viz backend.

Phase 1a (MVP, single worker):
- 启动时 lazy spawn 一个 sage 子进程跑 worker_loop.sage
- 每次 submit() 投递 job, 阻塞读 stdout 直到 JOB_DONE
- worker 死 → 下次 submit() 自动 respawn
- cancel = kill worker 整个进程 (会重启). Phase 1c 再做 soft cancel.

后续 phase 待加:
- 1b: cache 大小 watchdog
- 1c: SIGINT-based soft cancel
- 2/3+: 不必扩 pool size (单用户场景), 但留接口.
"""
import os, sys, json, time, threading, subprocess, signal, uuid, select


_WS = "/Users/dtq1997/ai/workspace/academic-formula-workbench"
WORKER_SCRIPT = os.path.join(_WS, "60-outputs/sd-viz/server/worker_loop.sage")
SAGE_BIN = "sage"
SPAWN_TIMEOUT = 90  # sage cold start + worker_loop module load


class SageWorkerError(Exception):
    pass


class SageWorker:
    """One persistent sage subprocess running worker_loop.sage.

    Thread-safety: submit() is serialized via _lock — single worker handles
    single job at a time. Cancel can fire from another thread (sets flag),
    submit() polls it and kills worker if set.
    """

    def __init__(self):
        self._proc = None
        self._lock = threading.Lock()
        self._spawn_lock = threading.Lock()
        self._jobs_done = 0  # 计数 (供日志/watchdog 用)
        self._spawn_at = None

    # --- lifecycle ---

    def _spawn(self):
        """Block until WORKER_READY. Raises SageWorkerError on failure."""
        with self._spawn_lock:
            # double-check after acquiring lock
            if self._proc is not None and self._proc.poll() is None:
                return
            self._proc = subprocess.Popen(
                [SAGE_BIN, WORKER_SCRIPT],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,             # line-buffered
                preexec_fn=os.setsid,  # new pgid for killpg
            )
            self._spawn_at = time.time()
            deadline = time.time() + SPAWN_TIMEOUT
            while time.time() < deadline:
                if self._proc.poll() is not None:
                    raise SageWorkerError(
                        f"worker died during startup (exit={self._proc.returncode})"
                    )
                line = self._proc.stdout.readline()
                if not line:
                    continue
                if line.strip() == 'WORKER_READY':
                    return
                # discard pre-ready output (sage banner, deprecation warnings)
            raise SageWorkerError(f"worker not ready within {SPAWN_TIMEOUT}s")

    def _is_alive(self):
        return self._proc is not None and self._proc.poll() is None

    def _kill(self):
        if self._proc is None:
            return
        if self._proc.poll() is None:
            try:
                os.killpg(os.getpgid(self._proc.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(self._proc.pid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
        self._proc = None

    def restart(self):
        """Force kill + respawn. Called externally if watchdog wants reset."""
        self._kill()
        self._spawn()

    # --- main API ---

    def submit(self, in_path, out_path,
               on_line=None, cancel_event=None, timeout=600):
        """Run one recompute job. Returns (ok: bool, error: str|None).

        on_line(str): called per stdout line that is NOT JOB_DONE / WORKER_*.
                      Caller uses this to parse STAGE/PROGRESS.
        cancel_event: threading.Event or callable returning bool. If set/True,
                      kills the worker (Phase 1a hard cancel — respawn next time).
        timeout: seconds before killing worker and returning failure.
        """
        with self._lock:
            if not self._is_alive():
                self._spawn()
            job_id = uuid.uuid4().hex[:8]
            spec = json.dumps({
                'job_id': job_id,
                'in_path': in_path,
                'out_path': out_path,
            })
            try:
                self._proc.stdin.write(spec + '\n')
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError) as e:
                self._kill()
                return False, f'worker stdin write failed: {e}'

            deadline = time.time() + timeout
            done_prefix_ok = f'JOB_DONE {job_id} ok'
            done_prefix_err = f'JOB_DONE {job_id} error:'
            while True:
                # cancel poll
                if cancel_event is not None:
                    cancelled = (cancel_event.is_set()
                                 if hasattr(cancel_event, 'is_set')
                                 else bool(cancel_event()))
                    if cancelled:
                        self._kill()  # Phase 1a hard cancel
                        return False, 'cancelled'

                if not self._is_alive():
                    return False, f'worker died (exit={self._proc.returncode if self._proc else "?"})'

                if time.time() > deadline:
                    self._kill()
                    return False, f'timeout after {timeout}s'

                ready, _, _ = select.select([self._proc.stdout], [], [], 0.5)
                if not ready:
                    continue
                line = self._proc.stdout.readline()
                if not line:
                    # EOF — worker likely died
                    return False, 'worker stdout EOF'
                line = line.rstrip('\n')
                if line == done_prefix_ok:
                    self._jobs_done += 1
                    return True, None
                if line.startswith(done_prefix_err):
                    self._jobs_done += 1
                    return False, line[len('JOB_DONE '):]
                # Pass through STAGE / PROGRESS / WORKER_TRACE etc. to caller.
                if on_line is not None:
                    try:
                        on_line(line)
                    except Exception:
                        # caller's parser must not break worker loop
                        pass

    def stats(self):
        return {
            'alive': self._is_alive(),
            'pid': self._proc.pid if self._proc else None,
            'spawn_at': self._spawn_at,
            'jobs_done': self._jobs_done,
        }


# Module-global singleton worker (Phase 1a — single worker is enough).
_GLOBAL_WORKER = None
_GLOBAL_LOCK = threading.Lock()


def get_worker():
    global _GLOBAL_WORKER
    with _GLOBAL_LOCK:
        if _GLOBAL_WORKER is None:
            _GLOBAL_WORKER = SageWorker()
        return _GLOBAL_WORKER


def shutdown():
    """Kill the global worker if exists. Used on push_server shutdown."""
    global _GLOBAL_WORKER
    with _GLOBAL_LOCK:
        if _GLOBAL_WORKER is not None:
            _GLOBAL_WORKER._kill()
            _GLOBAL_WORKER = None
