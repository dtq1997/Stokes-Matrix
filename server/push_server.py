"""
Sd-viz 异步后端: POST 启动 job 立即返 job_id, GET 查进度 + 增量结果.

启动:
  cd 60-outputs/sd-viz/server
  sage -python push_server.py     # http://127.0.0.1:8000

API:
  POST /api/recompute    body { punctures, A, m_sizes }
       → { job_id }                          (立即返回)
  GET  /api/job/{id}     → { status, progress, chambers_done, chambers_total,
                             partial_chambers, result?, error? }
       status: queued / running / done / error
       partial_chambers: 已完成 chamber 的 dataset 切片 (增量)
  POST /api/job/{id}/cancel  → { ok }

  GET  /api/dataset      → 当前 cache 数据集 (初始 = 磁盘 JSON)
  POST /api/reset        → 恢复初始 dataset
"""
import os, sys, json, time, copy, subprocess, tempfile, threading, uuid, re, signal, select, math
from typing import List, Optional, Dict, Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware

# ISC engines (按需 import 失败也不影响其他端点)
sys.path.insert(0, os.path.expanduser('~/ai/data/wolfram'))
try:
    from wolfram_query import wolfram_identify as _wolfram_identify  # type: ignore
    _WA_AVAILABLE = True
except Exception:
    _wolfram_identify = None
    _WA_AVAILABLE = False
RIES_BIN = os.path.expanduser('~/ai/data/ries/ries')

WS = "/Users/dtq1997/ai/workspace/academic-formula-workbench"
DATA_PATH = os.path.join(WS, "60-outputs/sd-viz/data/n4_simple.json")
RUNNER = os.path.join(WS, "60-outputs/sd-viz/server/recompute_runner.sage")

# Phase 1a: 持久 sage worker. 取消 per-request subprocess.Popen('sage',...) 的
# ~4s cold start. 失败时 worker_pool 内部 respawn.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from worker_pool import get_worker, shutdown as worker_shutdown

app = FastAPI(title="Sd-viz backend (async)")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


class Complex(BaseModel):
    re: float
    im: float


class RecomputeRequest(BaseModel):
    punctures: List[Complex]
    A: List[List[Complex]] = Field(..., description="N×N matrix, N=sum(m_sizes)")
    m_sizes: List[int]
    precision: str = 'medium'  # 'fast' | 'low' | 'medium' | 'high'
    algorithm: str = 'v5_full'  # 唯一 default; 'legacy_entry' 仅作 fallback / oracle


_state: Dict[str, Any] = {'dataset': None, 'initial': None}
_jobs: Dict[str, Dict[str, Any]] = {}
_jobs_lock = threading.Lock()


def _load_initial():
    with open(DATA_PATH) as f:
        d = json.load(f)
    _state['dataset'] = d
    _state['initial'] = copy.deepcopy(d)


@app.on_event("startup")
def startup():
    if os.path.exists(DATA_PATH):
        _load_initial()
    # Phase 1a+ optimization: pre-spawn sage worker in background, so first
    # /api/recompute doesn't pay the ~4s cold start. Spawn is blocking; do it
    # in a thread.
    def _prespawn():
        try:
            get_worker()._spawn()
        except Exception as e:
            # Don't crash startup on worker spawn failure (will lazy-spawn later)
            print(f"[push_server] worker prespawn failed: {e}", flush=True)
    threading.Thread(target=_prespawn, daemon=True).start()


@app.get("/api/dataset")
def get_dataset():
    if _state['dataset'] is None:
        _load_initial()
    return _state['dataset']


@app.post("/api/reset")
def reset():
    if _state['initial'] is None:
        _load_initial()
    _state['dataset'] = copy.deepcopy(_state['initial'])
    return {"ok": True}


def _run_job(job_id: str, req: RecomputeRequest):
    """Phase 1a: 提交 job 到持久 worker. cold start 已经被 worker 摊销.

    Worker 单例 (worker_pool.get_worker), 跨多 request 复用 sage 进程.
    cancel 通过 cancel_event 传给 worker, Phase 1a 实现是 hard kill + respawn.
    """
    job = _jobs[job_id]
    inp = {
        'punctures': [p.dict() for p in req.punctures],
        'A': [[c.dict() for c in row] for row in req.A],
        'm_sizes': req.m_sizes,
        'precision': req.precision,
        'algorithm': req.algorithm,
    }
    in_fd, in_path = tempfile.mkstemp(suffix='.json')
    out_path = in_path + '.out'
    with os.fdopen(in_fd, 'w') as f:
        json.dump(inp, f)

    cancel_event = threading.Event()
    # poll loop: 把 jobs[].cancelled 翻译给 worker.
    def _cancel_poll():
        with _jobs_lock:
            if job.get('cancelled'):
                cancel_event.set()
        return cancel_event.is_set()

    try:
        with _jobs_lock:
            job['status'] = 'running'
            job['phase'] = 'submit'
            job['phase_detail'] = 'persistent worker'
            job['t_start'] = time.time()

        prog_re = re.compile(r'PROGRESS chamber (\d+)/(\d+)')
        stage_re = re.compile(r'STAGE\s+([^|]+?)(?:\|(.+))?$')
        output_tail = []

        def _on_line(line: str):
            output_tail.append(line)
            if len(output_tail) > 80:
                del output_tail[:-80]
            m = prog_re.search(line)
            if m:
                done, total = int(m.group(1)), int(m.group(2))
                with _jobs_lock:
                    job['chambers_done'] = done
                    job['chambers_total'] = total
                    job['progress'] = done / total if total else 0.0
                return
            sm = stage_re.search(line)
            if sm:
                phase = sm.group(1).strip()
                detail = (sm.group(2) or '').strip()
                with _jobs_lock:
                    job['phase'] = phase
                    job['phase_detail'] = detail

        worker = get_worker()
        ok, err = worker.submit(
            in_path, out_path,
            on_line=_on_line, cancel_event=_cancel_poll,
            timeout=_JOB_TIMEOUT,
        )

        with _jobs_lock:
            if job.get('cancelled'):
                job['status'] = 'cancelled'
                job['error'] = 'cancelled by user'
                job['t_end'] = time.time()
                return

        if not ok:
            tail = "\n".join(output_tail)[-2000:]
            with _jobs_lock:
                job['status'] = 'error'
                job['error'] = f'worker job failed: {err}\n{tail}'
                job['t_end'] = time.time()
            return

        with open(out_path) as f:
            ds = json.load(f)
        ds['_compute_seconds'] = time.time() - job['t_start']
        with _jobs_lock:
            _state['dataset'] = ds
            job['result'] = ds
            job['status'] = 'done'
            job['progress'] = 1.0
            job['t_end'] = time.time()
    except Exception as e:
        with _jobs_lock:
            job['status'] = 'error'
            job['error'] = str(e)
            job['t_end'] = time.time()
    finally:
        for p in (in_path, out_path):
            try: os.unlink(p)
            except FileNotFoundError: pass


_MAX_N = 20       # upper bound on number of punctures
_MAX_M_SUM = 40   # upper bound on total matrix dimension sum(m_sizes)
_JOB_TIMEOUT = 600  # 10 minutes max per sage computation
_ALLOWED_PRECISIONS = {'fast', 'low', 'medium', 'high'}
_ALLOWED_ALGORITHMS = {'v5_full', 'legacy_entry'}

def _cleanup_old_jobs(max_age=3600):
    """Remove completed/error/cancelled jobs older than max_age seconds."""
    now = time.time()
    stale = [jid for jid, j in _jobs.items()
             if j['status'] in ('done', 'error', 'cancelled')
             and now - j['t_created'] > max_age]
    for jid in stale:
        del _jobs[jid]


@app.post("/api/recompute")
def recompute_start(req: RecomputeRequest):
    n = len(req.punctures)
    N = sum(req.m_sizes)
    if req.precision not in _ALLOWED_PRECISIONS:
        raise HTTPException(400, f"precision={req.precision!r} not in {sorted(_ALLOWED_PRECISIONS)}")
    if req.algorithm not in _ALLOWED_ALGORITHMS:
        raise HTTPException(400, f"algorithm={req.algorithm!r} not in {sorted(_ALLOWED_ALGORITHMS)}")
    if any(m <= 0 for m in req.m_sizes):
        raise HTTPException(400, "all m_sizes must be positive")
    if N != len(req.A):
        raise HTTPException(400, f"A is {len(req.A)}×… but N=sum(m)={N}")
    if any(len(row) != N for row in req.A):
        raise HTTPException(400, f"A must be square with {N} columns in every row")
    if n != len(req.m_sizes):
        raise HTTPException(400, f"len(punctures)={n} != len(m_sizes)={len(req.m_sizes)}")
    if n > _MAX_N:
        raise HTTPException(400, f"n={n} exceeds maximum {_MAX_N}")
    if N > _MAX_M_SUM:
        raise HTTPException(400, f"N=sum(m)={N} exceeds maximum {_MAX_M_SUM}")
    # reject if a job is already running
    with _jobs_lock:
        _cleanup_old_jobs()
        running = [jid for jid, j in _jobs.items() if j['status'] in ('queued', 'running')]
        if running:
            raise HTTPException(429, "A computation is already running. Cancel it first or wait.")
        job_id = str(uuid.uuid4())
        _jobs[job_id] = {
            'status': 'queued',
            'progress': 0.0,
            'chambers_done': 0,
            'chambers_total': 0,
            'phase': 'queued',
            'phase_detail': '',
            'result': None,
            'error': None,
            'cancelled': False,
            't_created': time.time(),
        }
    threading.Thread(target=_run_job, args=(job_id, req), daemon=True).start()
    return {'job_id': job_id}


@app.get("/api/job/{job_id}")
def job_status(job_id: str):
    with _jobs_lock:
        if job_id not in _jobs:
            raise HTTPException(404, "unknown job")
        j = _jobs[job_id]
        return {
            'status': j['status'],
            'progress': j['progress'],
            'chambers_done': j['chambers_done'],
            'chambers_total': j['chambers_total'],
            'phase': j.get('phase', ''),
            'phase_detail': j.get('phase_detail', ''),
            'elapsed_s': (j['t_end'] - j.get('t_start', j['t_created'])
                          if 't_end' in j
                          else time.time() - j.get('t_start', j['t_created'])),
            'result': j['result'] if j['status'] == 'done' else None,
            'error': j['error'],
        }


@app.post("/api/job/{job_id}/cancel")
def job_cancel(job_id: str):
    with _jobs_lock:
        if job_id not in _jobs:
            raise HTTPException(404)
        j = _jobs[job_id]
        if j['status'] in ('done', 'error', 'cancelled'):
            return {'ok': True, 'note': 'already finished'}
        j['cancelled'] = True
    # Phase 1a: 实际 kill 由 worker_pool.submit 内部根据 cancel_event 处理
    # (kill worker → respawn). 这里只设标志.
    return {'ok': True}


@app.on_event("shutdown")
def _shutdown():
    worker_shutdown()


@app.get("/api/worker_stats")
def worker_stats():
    """Phase 1a debug: 暴露 worker 状态 (alive/pid/jobs_done/spawn_at)."""
    return get_worker().stats()


# ---------- Inverse Symbolic Computation (ISC) ----------
# 给定复数, 跑 simple → RIES → WolframAlpha 三层 identify.
# 通道: re, im, |z|, arg/π.
# 'kind' 字段告诉前端 form 是值表达式 (integer/rational/sqrt/pi-rational/wolfram)
# 还是方程 (ries-equation) — cell 渲染只能用值表达式.

from fractions import Fraction as _Fraction


def _simple_identify(val: float, tol: float = 1e-10, max_denom: int = 1000) -> List[Dict[str, Any]]:
    """快速 closed-form 识别 (整数/有理/√有理/π·有理). 返回每个匹配的 dict."""
    out: List[Dict[str, Any]] = []
    if not math.isfinite(val):
        return out
    av = abs(val)
    scale = max(av, 1.0)
    # 1. integer
    n = round(val)
    if abs(val - n) < tol * scale:
        out.append({'form': str(n), 'err_abs': abs(val - n), 'kind': 'integer'})
        return out  # 整数直接退出, 其他形式无意义
    # 2. rational p/q
    try:
        f = _Fraction(val).limit_denominator(max_denom)
        if abs(val - float(f)) < tol * scale:
            out.append({'form': f'{f.numerator}/{f.denominator}',
                        'err_abs': abs(val - float(f)), 'kind': 'rational'})
    except Exception:
        pass
    # 3. sqrt of rational: val^2 = p/q  →  val = ±sqrt(p/q), 完美平方提出来
    def _sqrt_token(n: int) -> str:
        """sqrt(n) 化简: 提出完美平方因子. n>0."""
        s = math.isqrt(n)
        if s * s == n:
            return str(s)
        # 提因子: n = a^2 * b, sqrt(n) = a * sqrt(b)
        a = 1
        for d in range(2, math.isqrt(n) + 1):
            d2 = d * d
            while n % d2 == 0:
                n //= d2
                a *= d
        if a == 1:
            return f'sqrt({n})'
        if n == 1:
            return str(a)
        return f'{a}*sqrt({n})'

    if av > 0:
        sq = val * val
        try:
            fsq = _Fraction(sq).limit_denominator(max_denom)
            if fsq != 0 and abs(sq - float(fsq)) < tol * max(sq, 1.0):
                sign = '-' if val < 0 else ''
                p, q = fsq.numerator, fsq.denominator
                num_tok = _sqrt_token(p)
                if q == 1:
                    body = num_tok
                else:
                    den_tok = _sqrt_token(q)
                    body = f'{num_tok}/{den_tok}' if num_tok != '1' else f'1/{den_tok}'
                # 跳过纯整数/有理 (上面已收录) — 只在 form 含 sqrt 时记入
                if 'sqrt' in body:
                    out.append({'form': f'{sign}{body}',
                                'err_abs': abs(av - math.sqrt(float(fsq))),
                                'kind': 'sqrt'})
        except Exception:
            pass
    # 4. rational multiple of π: val = p/q * π
    try:
        rp = val / math.pi
        fp = _Fraction(rp).limit_denominator(max_denom)
        if abs(rp - float(fp)) < tol * max(abs(rp), 1.0):
            p, q = fp.numerator, fp.denominator
            if p == 0:
                pass  # zero already handled by integer branch
            elif abs(p) == 1 and q == 1:
                out.append({'form': '-pi' if p < 0 else 'pi',
                            'err_abs': abs(val - p * math.pi), 'kind': 'pi-rational'})
            elif q == 1:
                out.append({'form': f'{p}*pi',
                            'err_abs': abs(val - p * math.pi), 'kind': 'pi-rational'})
            elif abs(p) == 1:
                form = f'pi/{q}' if p > 0 else f'-pi/{q}'
                out.append({'form': form,
                            'err_abs': abs(val - float(fp) * math.pi), 'kind': 'pi-rational'})
            else:
                out.append({'form': f'{p}*pi/{q}',
                            'err_abs': abs(val - float(fp) * math.pi), 'kind': 'pi-rational'})
    except Exception:
        pass
    return out


_RIES_LINE_RE = re.compile(
    r'^\s*(\S.*?)\s+=\s+(\S.*?)\s+(?:for x = T\s*([+\-])\s*([0-9.eE+\-]+)|\(\'exact\' match\))'
)


def _ries_value_form(lhs: str, rhs: str) -> Optional[str]:
    """把 RIES 方程逆解成 x 的值表达式 (仅简单 pattern).
    返回 None 表示无法直接逆解, 调用方保留方程形式."""
    lhs_s = lhs.strip()
    rhs_s = rhs.strip()
    # x = expr  /  expr = x
    if lhs_s == 'x':
        return rhs_s
    if rhs_s == 'x':
        return lhs_s
    # -x = expr  /  expr = -x
    if lhs_s == '-x':
        return f'-({rhs_s})'
    if rhs_s == '-x':
        return f'-({lhs_s})'
    # 1/x = expr  →  x = 1/expr
    if lhs_s == '1/x':
        return f'1/({rhs_s})'
    if rhs_s == '1/x':
        return f'1/({lhs_s})'
    # x^2 = expr  →  x = sqrt(expr) (符号丢失, 跳过留 RIES 输出)
    # k*x = expr (k 整数) → x = expr/k. 简化版: 数字 + "x" 的形式.
    m = re.fullmatch(r'(-?\d+)\*x', lhs_s)
    if m:
        return f'({rhs_s})/{m.group(1)}'
    m = re.fullmatch(r'(-?\d+)\*x', rhs_s)
    if m:
        return f'({lhs_s})/{m.group(1)}'
    return None


def _ries_identify(val: float, timeout: float = 3.0, max_results: int = 5) -> List[Dict[str, Any]]:
    if not os.path.exists(RIES_BIN):
        return []
    try:
        proc = subprocess.run(
            [RIES_BIN, '-l3', str(val)],
            capture_output=True, text=True, timeout=timeout,
        )
    except Exception:
        return []
    out: List[Dict[str, Any]] = []
    for line in proc.stdout.splitlines():
        m = _RIES_LINE_RE.match(line)
        if not m:
            continue
        lhs, rhs, sign, delta_s = m.group(1), m.group(2), m.group(3), m.group(4)
        err_abs = float(delta_s) if delta_s is not None else 0.0
        v = _ries_value_form(lhs, rhs)
        if v is not None:
            out.append({'form': v, 'raw_form': f'{lhs} = {rhs}',
                        'err_abs': err_abs, 'kind': 'ries-value'})
        else:
            out.append({'form': f'{lhs} = {rhs}',
                        'err_abs': err_abs, 'kind': 'ries-equation'})
        if len(out) >= max_results:
            break
    return out


def _wa_identify_wrap(val: float, max_results: int = 5) -> List[Dict[str, Any]]:
    if not _WA_AVAILABLE:
        return []
    try:
        forms = _wolfram_identify(val)
    except Exception:
        return []
    out: List[Dict[str, Any]] = []
    for f in forms[:max_results]:
        # WA forms look like "1/sqrt(3)≈0.577..." — split on ≈ to extract pure expression.
        if '≈' in f:
            expr = f.split('≈', 1)[0].strip()
        else:
            expr = f.strip()
        out.append({'form': expr, 'err_abs': None})
    return out


class IscRequest(BaseModel):
    re: float
    im: float = 0.0
    # 通道选择. 默认全开.
    channels: List[str] = Field(default_factory=lambda: ['re', 'im', 'abs', 'arg'])
    engines: List[str] = Field(default_factory=lambda: ['ries', 'wolfram'])


@app.post('/api/isc')
def api_isc(req: IscRequest):
    """Single-value ISC. 返回每个通道的候选 (re/im/abs/arg/π)."""
    EPS = 1e-12
    mag = math.hypot(req.re, req.im)
    has_im = abs(req.im) > EPS
    targets: List[tuple] = []
    if 're' in req.channels:
        targets.append(('Re', req.re))
    if 'im' in req.channels and has_im:
        targets.append(('Im', req.im))
    if 'abs' in req.channels and has_im and mag > EPS:
        targets.append(('|z|', mag))
    if 'arg' in req.channels and has_im and mag > EPS:
        targets.append(('arg/π', math.atan2(req.im, req.re) / math.pi))

    candidates: List[Dict[str, Any]] = []
    for axis, val in targets:
        if abs(val) < EPS:
            candidates.append({'axis': axis, 'value': val, 'engine': 'simple',
                               'form': '0', 'err_abs': abs(val), 'kind': 'integer'})
            continue
        # fast 本地 simple-identify (整数/有理/√有理/π·有理)
        for c in _simple_identify(val):
            candidates.append({'axis': axis, 'value': val, 'engine': 'simple', **c})
        if 'ries' in req.engines:
            for c in _ries_identify(val):
                candidates.append({'axis': axis, 'value': val, 'engine': 'ries', **c})
        if 'wolfram' in req.engines:
            for c in _wa_identify_wrap(val):
                candidates.append({'axis': axis, 'value': val, 'engine': 'wolfram',
                                   'kind': 'wolfram', **c})
    return {'candidates': candidates,
            'engines_available': {'ries': os.path.exists(RIES_BIN), 'wolfram': _WA_AVAILABLE}}


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8000)
