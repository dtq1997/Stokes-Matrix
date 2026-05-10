"""
Sd-viz push 后端: 接 (U, A, m) 重算 Stokes (跑 sage subprocess).

启动:
  cd 60-outputs/sd-viz/server
  sage -python push_server.py     # http://127.0.0.1:8000

热路径:
  POST /api/recompute  body { punctures, A, m_sizes }
       → 返回新 SimpleDataset (跟 web/src/lib/types.ts 对齐)
       同步阻塞, n=4 simple 大概 5 分钟; loading spinner 等

  GET  /api/dataset    返回当前缓存 (初始 = 磁盘 JSON)
  POST /api/reset      恢复初始 dataset

实现: subprocess 调 sage runner. 每 request 5s sage startup + 5min compute.
后续优化: 持久 sage worker / wall-crossing / SSE progress.
"""
import os, sys, json, time, copy, subprocess, tempfile
from typing import List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware

WS = "/Users/dtq1997/ai/workspace/academic-formula-workbench"
DATA_PATH = os.path.join(WS, "60-outputs/sd-viz/data/n4_simple.json")
RUNNER = os.path.join(WS, "60-outputs/sd-viz/server/recompute_runner.sage")

app = FastAPI(title="Sd-viz backend")
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


_state = {'dataset': None, 'initial': None}


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


@app.post("/api/recompute")
def recompute(req: RecomputeRequest):
    n = len(req.punctures)
    N = sum(req.m_sizes)
    if N != len(req.A):
        raise HTTPException(400, f"A is {len(req.A)}×… but N=sum(m)={N}")
    if n != len(req.m_sizes):
        raise HTTPException(400, f"len(punctures)={n} != len(m_sizes)={len(req.m_sizes)}")

    inp = {
        'punctures': [p.dict() for p in req.punctures],
        'A': [[c.dict() for c in row] for row in req.A],
        'm_sizes': req.m_sizes,
    }

    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
        json.dump(inp, f)
        in_path = f.name
    out_path = in_path + '.out'

    try:
        t0 = time.time()
        proc = subprocess.run(
            ['sage', RUNNER, in_path, out_path],
            capture_output=True, text=True, timeout=900,
        )
        if proc.returncode != 0:
            raise HTTPException(500, f"sage failed: {proc.stderr[-1000:]}")
        with open(out_path) as f:
            ds = json.load(f)
        ds['_compute_seconds'] = time.time() - t0
        _state['dataset'] = ds
        return ds
    finally:
        for p in (in_path, out_path):
            try: os.unlink(p)
            except FileNotFoundError: pass


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8000)
