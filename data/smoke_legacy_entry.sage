"""
Smoke test: legacy_entry opt-out path still works (v5 promote 后回归保险).

Runs `SD_ALGORITHM=legacy_entry SD_PRECISION=low` export to a temp file
and asserts every entry has:
  - non-null `path` (PL waypoints from the legacy isoeq+tq route)
  - `provenance` field NOT 'v5_full_wall_crossing'
  - 没有 error / KeyError entry

Codex 2026-05-12 反馈: legacy_entry 仍然作 oracle/fallback,
必须有快速 smoke 保证它没被静默坏掉.

Usage:
  sage 60-outputs/sd-viz/data/smoke_legacy_entry.sage

Exit code 0 = PASS, 1 = FAIL (failing entries 打印).
"""
import json
import os
import subprocess
import sys
import tempfile


_WS = "/Users/dtq1997/ai/workspace/academic-formula-workbench"

with tempfile.NamedTemporaryFile(suffix='.json', delete=False) as tmp:
    out_path = tmp.name

env = dict(os.environ)
env['SD_ALGORITHM'] = 'legacy_entry'
env['SD_PRECISION'] = 'low'  # 最快
env['SD_OUT'] = out_path

print(f"[smoke] running legacy_entry export to {out_path}")
result = subprocess.run(
    ['sage', os.path.join(_WS, '60-outputs/sd-viz/data/export_n4_simple.sage')],
    env=env, capture_output=True, text=True, cwd=_WS,
)

if result.returncode != 0:
    print(f"[smoke] FAIL: export returned {result.returncode}")
    print(result.stderr[-2000:])
    sys.exit(1)

with open(out_path) as f:
    data = json.load(f)

fails = []
n_entries = 0
for ch in data['chambers']:
    for key, entry in ch['entries'].items():
        n_entries += 1
        if 'error' in entry:
            fails.append(f"chamber d={ch['d']:.4f} entry {key}: error={entry['error'][:80]}")
            continue
        if entry.get('path') is None:
            fails.append(f"chamber d={ch['d']:.4f} entry {key}: path is null (should be PL waypoints)")
        prov = entry.get('provenance')
        if prov == 'v5_full_wall_crossing':
            fails.append(f"chamber d={ch['d']:.4f} entry {key}: provenance is v5 (should NOT be)")

print(f"[smoke] checked {n_entries} entries across {len(data['chambers'])} chambers")

if fails:
    print(f"[smoke] FAIL: {len(fails)} entries broken")
    for f in fails[:5]:
        print(f"  {f}")
    if len(fails) > 5:
        print(f"  ... and {len(fails) - 5} more")
    os.unlink(out_path)
    sys.exit(1)

print(f"[smoke] PASS: all {n_entries} entries have path + legacy provenance, no error entries")
os.unlink(out_path)
sys.exit(0)
