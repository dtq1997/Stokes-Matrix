"""
Push 后端: 接收 (k, u_k_new), 调 isoeq pusher 演化 A,
返回新 (U', A', 所有 chamber 内所有 entry 的 S_d 数值).

用法:
  sage -python 60-outputs/sd-viz/server/push_server.py

依赖: FastAPI + uvicorn (sage 自带 pip 装).
  sage -pip install fastapi uvicorn

热路径:
  POST /api/push  body {"k": int, "re": float, "im": float}
  返回新 SimpleDataset JSON (跟静态 export 同 schema).

非热路径:
  GET  /api/dataset 返回当前 (U_curr, A_curr) 对应的全量数据 (回到初始).
  POST /api/reset   重置 U, A 到 export 时的初始状态.
"""
import os, sys, math, json, time, copy
sys.path.insert(0, "/Users/dtq1997/ai/workspace/academic-formula-workbench/50-computation")

# 不在这里 sage import — sage 启动慢, 用 worker 进程模型
# 第一阶段先做接口契约, 实际计算用静态 JSON 当 oracle, 后续接通

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware

DATA_PATH = "/Users/dtq1997/ai/workspace/academic-formula-workbench/60-outputs/sd-viz/data/n4_simple.json"

app = FastAPI(title="Sd-viz push backend")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


class PushRequest(BaseModel):
    k: int
    re: float
    im: float


# 内存中的当前 dataset (初始 = 磁盘 JSON)
_state = {'dataset': None, 'initial': None}


def _load_initial():
    if not os.path.exists(DATA_PATH):
        raise RuntimeError(f"dataset not found: {DATA_PATH}; 先跑 export_n4_simple.sage")
    with open(DATA_PATH) as f:
        d = json.load(f)
    _state['dataset'] = d
    _state['initial'] = copy.deepcopy(d)


@app.on_event("startup")
def startup():
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


@app.post("/api/push")
def push(req: PushRequest):
    """
    占位实现 (Phase 1.0): 仅更新 punctures, 不重算 Stokes.
    Phase 1.5 接 isoeq_pusher + tq, 实时重算所有 chamber × entry.
    """
    ds = _state['dataset']
    if ds is None:
        _load_initial()
        ds = _state['dataset']
    if not (0 <= req.k < len(ds['punctures'])):
        raise HTTPException(400, f"k={req.k} out of range")
    ds['punctures'][req.k] = {'re': req.re, 'im': req.im}
    # TODO Phase 1.5: 调 isoeq pusher 演化 A, 重算所有 entry
    # 先标记 entries 为 stale
    for ch in ds['chambers']:
        for key in ch['entries']:
            ch['entries'][key]['_stale'] = True
    return ds


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8000)
