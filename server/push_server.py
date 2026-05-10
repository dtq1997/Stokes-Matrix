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
import os, sys, json, time, copy, subprocess, tempfile, threading, uuid, re, signal
from typing import List, Optional, Dict, Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware

WS = "/Users/dtq1997/ai/workspace/academic-formula-workbench"
DATA_PATH = os.path.join(WS, "60-outputs/sd-viz/data/n4_simple.json")
RUNNER = os.path.join(WS, "60-outputs/sd-viz/server/recompute_runner.sage")

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
    job = _jobs[job_id]
    inp = {
        'punctures': [p.dict() for p in req.punctures],
        'A': [[c.dict() for c in row] for row in req.A],
        'm_sizes': req.m_sizes,
    }
    in_fd, in_path = tempfile.mkstemp(suffix='.json')
    out_path = in_path + '.out'
    with os.fdopen(in_fd, 'w') as f:
        json.dump(inp, f)

    try:
        with _jobs_lock:
            job['status'] = 'running'
            job['t_start'] = time.time()
        proc = subprocess.Popen(
            ['sage', RUNNER, in_path, out_path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            preexec_fn=os.setsid,
        )
        with _jobs_lock:
            job['pid'] = proc.pid

        # 流式读 stdout, 提取 PROGRESS / PARTIAL 行
        prog_re = re.compile(r'PROGRESS chamber (\d+)/(\d+)')
        for line in proc.stdout:
            with _jobs_lock:
                if job.get('cancelled'):
                    break
            m = prog_re.search(line)
            if m:
                done, total = int(m.group(1)), int(m.group(2))
                with _jobs_lock:
                    job['chambers_done'] = done
                    job['chambers_total'] = total
                    job['progress'] = done / total if total else 0.0
                continue
            # 增量 partial chamber 不在第一版加 — sage runner 当前不输出
            # (后续在 runner 加 PARTIAL_CHAMBER {json} 行 + 这里 parse + 累积到 partial)

        proc.wait()
        with _jobs_lock:
            if job.get('cancelled'):
                job['status'] = 'cancelled'
                job['error'] = 'cancelled by user'
                return
        if proc.returncode != 0:
            err = proc.stderr.read()[-2000:] if proc.stderr else ''
            with _jobs_lock:
                job['status'] = 'error'
                job['error'] = f'sage exit {proc.returncode}: {err}'
            return
        with open(out_path) as f:
            ds = json.load(f)
        ds['_compute_seconds'] = time.time() - job['t_start']
        with _jobs_lock:
            _state['dataset'] = ds
            job['result'] = ds
            job['status'] = 'done'
            job['progress'] = 1.0
    except Exception as e:
        with _jobs_lock:
            job['status'] = 'error'
            job['error'] = str(e)
    finally:
        for p in (in_path, out_path):
            try: os.unlink(p)
            except FileNotFoundError: pass


@app.post("/api/recompute")
def recompute_start(req: RecomputeRequest):
    n = len(req.punctures)
    N = sum(req.m_sizes)
    if N != len(req.A):
        raise HTTPException(400, f"A is {len(req.A)}×… but N=sum(m)={N}")
    if n != len(req.m_sizes):
        raise HTTPException(400, f"len(punctures)={n} != len(m_sizes)={len(req.m_sizes)}")
    job_id = str(uuid.uuid4())
    with _jobs_lock:
        _jobs[job_id] = {
            'status': 'queued',
            'progress': 0.0,
            'chambers_done': 0,
            'chambers_total': 0,
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
            'elapsed_s': time.time() - j.get('t_start', j['t_created']),
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
        pid = j.get('pid')
    if pid:
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except ProcessLookupError:
            pass
    return {'ok': True}


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8000)
