#!/usr/bin/env python3
"""chase-analyze.py —— 解析 sitemap-probe.sh chase 产出的高频轮询数据。

对每一个在轮询期间「新出现的编辑」，找出它第一次在 sitemap_page_1 里
以正确 lastmod 出现的那一轮，从而把 sitemap 滞后压到 INTERVAL 精度。
"""
import os, re, sys, datetime, importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, 'data')
spec = importlib.util.spec_from_file_location('sa', os.path.join(HERE, 'sitemap-analyze.py'))
sa = importlib.util.module_from_spec(spec); spec.loader.exec_module(sa)

rounds = []
for ln in open(os.path.join(D, 'chase.tsv')):
    k, t_lp, t_sm0, t_sm1 = ln.rstrip('\n').split('\t')
    f = lambda s: datetime.datetime.fromisoformat(s.replace('Z', ''))
    rounds.append((int(k), f(t_lp), f(t_sm0), f(t_sm1)))

# 每轮的 ListPages 前 5 名（fullname -> updated）
lp = {}
for k, *_ in rounds:
    p = os.path.join(D, f'chase_lp.{k}.json')
    if os.path.exists(p):
        lp[k] = {r['fullname']: r['updated'] for r in sa.parse_lp(p)}
# 每轮的 sitemap 快照
sm = {}
for k, *_ in rounds:
    p = os.path.join(D, f'chase_sm.{k}.xml')
    if os.path.exists(p):
        sm[k] = {s: m for _, s, m in sa.parse_sitemap(p)}

print(f'轮次数 {len(rounds)}，间隔约 '
      f'{(rounds[1][1]-rounds[0][1]).total_seconds():.0f}s，'
      f'覆盖 {rounds[0][1]}Z .. {rounds[-1][3]}Z\n')

# 收集观测窗口内被编辑过的页面（以 ListPages 为真值）
edits = {}
for k in sorted(lp):
    for f, u in lp[k].items():
        if u and (f not in edits or u > edits[f]):
            edits[f] = u
t_start = rounds[0][1]
print(f'{"页面":34s} {"编辑时刻(UTC)":20s} {"首次出现在 sitemap":20s} {"滞后":>12s}')
lags = []
for f, u in sorted(edits.items(), key=lambda x: x[1]):
    first = None
    for k, t_lp, t_sm0, t_sm1 in rounds:
        if k in sm and sm[k].get(f) == u:
            first = (k, t_sm0, t_sm1); break
    if first is None:
        # 观测期结束仍未出现
        state = sm[rounds[-1][0]].get(f)
        print(f'{f[:34]:34s} {str(u):20s} {"未出现(末轮="+str(state)+")":20s} {">"+str(round((rounds[-1][2]-u).total_seconds()/60,1))+"min":>12s}')
        continue
    k, t0, t1 = first
    prev = [r for r in rounds if r[0] == k - 1]
    lo = (prev[0][3] - u).total_seconds() / 60 if prev and (k - 1) in sm and sm[k - 1].get(f) != u else None
    hi = (t1 - u).total_seconds() / 60
    lags.append((f, u, hi, lo))
    rng = f'{lo:.1f}~{hi:.1f}min' if lo is not None and lo > 0 else f'≤{hi:.1f}min'
    print(f'{f[:34]:34s} {str(u):20s} r{k} @{t0.strftime("%H:%M:%S")}      {rng:>12s}')
if lags:
    print(f'\n可定界样本 {len(lags)} 个；滞后上界 min={min(l[2] for l in lags):.1f}min '
          f'max={max(l[2] for l in lags):.1f}min')
