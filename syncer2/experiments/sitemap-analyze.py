#!/usr/bin/env python3
"""
sitemap-analyze.py —— 配合 sitemap-probe.sh 的离线分析器（可重跑）

用法（在 experiments/ 目录下）：
  python3 sitemap-analyze.py lag      <label> [<label> ...]   # Q1/Q2 滞后与新页发现
  python3 sitemap-analyze.py drift    <labelA> <labelB>       # 两轮 sitemap_page_1 差分
  python3 sitemap-analyze.py order    <label>                 # Q4 排序是否 lastmod 降序
  python3 sitemap-analyze.py domain   <label>                 # Q3 枚举域（需先 full + db_slugs.csv）
  python3 sitemap-analyze.py threads  <label>                 # Q5 thread/category sitemap 对账

依赖数据文件（由 sitemap-probe.sh 生成 / psql 导出，全部在 ./data 下）：
  sm1.<L>.xml  lp_upd.<L>.json  lp_new.<L>.json  smp{1..4}.<L>.xml
  smt{1..9}.<L>.xml  smc.<L>.xml
  db_slugs.csv          <- \\copy (select replace(url,'http://scp-wiki-cn.wikidot.com/',''), "isDeleted" from "Page") ...
  db_pageactivity.csv   <- 见 sitemap-probe.md 附录
  db_threads_live.txt   <- select id from "ForumThread" where not "isDeleted"
"""
import sys, os, re, json, html, csv, datetime, statistics, collections

D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
URLPFX = 'http://scp-wiki-cn.wikidot.com/'


def parse_sitemap(path):
    """-> list[(ordinal, slug, lastmod|None)]，跳过站点根条目"""
    txt = open(path, encoding='utf-8', errors='replace').read()
    out, i = [], 0
    for m in re.finditer(r'<url><loc>' + re.escape(URLPFX) + r'([^<]*)</loc>(?:<lastmod>([^<]*)</lastmod>)?</url>', txt):
        i += 1
        slug, lm = m.group(1), m.group(2)
        if not slug:
            continue
        out.append((i, slug, datetime.datetime.fromisoformat(lm).replace(tzinfo=None) if lm else None))
    return out


def parse_lp(path):
    """ListPages AMC 响应 -> list[dict]；odate 的 time_<unix> 才是秒级真值"""
    raw = open(path, encoding='utf-8', errors='replace').read()
    try:
        body = json.loads(raw).get('body', '')
    except Exception:
        body = raw
    body = html.unescape(body)
    rows = []
    for m in re.finditer(r'F=(.*?)\|U=(.*?)\|C=(.*?)\|CB=(.*?)\|T=(\d*)', body, re.S):
        f, u, c, cb, t = m.groups()

        def ux(s):
            g = re.search(r'time_(\d+)', s)
            return datetime.datetime.utcfromtimestamp(int(g.group(1))) if g else None
        rows.append(dict(fullname=f.strip(), updated=ux(u), created=ux(c),
                         by=cb.strip(), total=int(t) if t else None))
    return rows


def fetched_at(label, kind='sm1'):
    p = os.path.join(D, f'{kind}.{label}.fetched')
    if os.path.exists(p):
        return datetime.datetime.fromisoformat(open(p).read().strip().replace('Z', ''))
    return datetime.datetime.utcfromtimestamp(os.path.getmtime(os.path.join(D, f'{kind}.{label}.xml')))


def load_db_activity():
    p = os.path.join(D, 'db_pageactivity.csv')
    if not os.path.exists(p):
        return {}
    act = {}
    for r in csv.reader(open(p, encoding='utf-8')):
        def q(x): return datetime.datetime.fromisoformat(x) if x else None
        act[r[0].replace(URLPFX, '')] = (q(r[1]), q(r[2]), q(r[3]))
    return act


# ---------------------------------------------------------------- Q1 / Q2
def cmd_lag(labels):
    for L in labels:
        sm = {s: (lm, o) for o, s, lm in parse_sitemap(os.path.join(D, f'sm1.{L}.xml'))}
        F = fetched_at(L)
        mx = max(v[0] for v in sm.values() if v[0])
        print(f'\n===== 轮次 {L}  sitemap_page_1 抓取于 {F}Z =====')
        print(f'  sitemap 内最大 lastmod = {mx}  → 滞后上界 ≤ {(F - mx).total_seconds() / 60:.1f} 分钟')
        for kind, title in (('lp_upd', 'Q1 最近被编辑的页'), ('lp_new', 'Q2 最近被创建的页')):
            p = os.path.join(D, f'{kind}.{L}.json')
            if not os.path.exists(p):
                continue
            rows = parse_lp(p)
            hit = miss = eq = ne = 0
            worst = []
            for r in rows:
                e = sm.get(r['fullname'])
                if not e:
                    miss += 1
                    worst.append((r['fullname'], r['updated'], None))
                    continue
                hit += 1
                if e[0] == r['updated']:
                    eq += 1
                else:
                    ne += 1
                    worst.append((r['fullname'], r['updated'], e[0]))
            print(f'  [{title}] n={len(rows)} 命中 sitemap={hit} 缺席={miss} '
                  f'lastmod 逐秒相等={eq} 不等={ne}')
            for w in worst[:10]:
                print('     异常:', w)
            if rows:
                newest = max(r['updated'] for r in rows)
                print(f'     该轮站内最新编辑 = {newest}（距抓取 {(F - newest).total_seconds() / 60:.1f} 分钟）')


# ---------------------------------------------------------------- 差分
def cmd_drift(a, b):
    A = {s: (lm, o) for o, s, lm in parse_sitemap(os.path.join(D, f'sm1.{a}.xml'))}
    B = {s: (lm, o) for o, s, lm in parse_sitemap(os.path.join(D, f'sm1.{b}.xml'))}
    FA, FB = fetched_at(a), fetched_at(b)
    print(f'{a}({FA}Z) -> {b}({FB}Z)  间隔 {(FB - FA).total_seconds() / 60:.1f} 分钟')
    print(f'  条目数 {len(A)} -> {len(B)}')
    print(f'  进入 page_1: {sorted(set(B) - set(A))}')
    print(f'  退出 page_1: {sorted(set(A) - set(B))}')
    ch = [(s, A[s][0], B[s][0]) for s in set(A) & set(B) if A[s][0] != B[s][0]]
    print(f'  lastmod 变化: {len(ch)}')
    for x in sorted(ch, key=lambda y: y[2] or datetime.datetime.min, reverse=True)[:20]:
        print('    ', x)
    mv = [abs(B[s][1] - A[s][1]) for s in set(A) & set(B)]
    if mv:
        print(f'  |Δ名次| median={statistics.median(mv):.0f} p90={sorted(mv)[int(len(mv) * .9)]} max={max(mv)}')


# ---------------------------------------------------------------- Q4
def cmd_order(L):
    act = load_db_activity()
    for n in (1, 2, 3, 4):
        p = os.path.join(D, f'smp{n}.{L}.xml')
        if not os.path.exists(p):
            p = os.path.join(D, f'sm1.{L}.xml') if n == 1 else None
        if not p or not os.path.exists(p):
            continue
        rows = [r for r in parse_sitemap(p) if r[2]]
        lm = [r[2] for r in rows]
        viol = sum(1 for i in range(1, len(lm)) if lm[i] > lm[i - 1])
        byl = sorted(rows, key=lambda r: r[2], reverse=True)
        rank = {r[1]: k for k, r in enumerate(byl)}
        disp = [abs(rank[r[1]] - k) for k, r in enumerate(rows)]
        print(f'page_{n}: n={len(rows)} lastmod∈[{min(lm).date()}, {max(lm).date()}] '
              f'降序违例={viol}({100 * viol / max(1, len(lm) - 1):.1f}%) '
              f'|Δ名次| median={statistics.median(disp):.0f}')
        segs = []
        for k in range(10):
            seg = sorted(x[2] for x in rows[k * len(rows) // 10:(k + 1) * len(rows) // 10])
            segs.append(str(seg[len(seg) // 2].date()))
        print('   lastmod 十分位中位数:', ' '.join(segs))
        if act:
            def K(x):
                a = act.get(x[1])
                return max([y for y in ((a[0], a[1], x[2]) if a else (x[2],)) if y])
            segs = []
            for k in range(10):
                seg = sorted(K(x) for x in rows[k * len(rows) // 10:(k + 1) * len(rows) // 10])
                segs.append(str(seg[len(seg) // 2].date()))
            print('   K=max(lastmod,末次投票,末次评论) 十分位中位数:', ' '.join(segs))


# ---------------------------------------------------------------- Q3
def cmd_domain(L):
    sm = set()
    for n in (1, 2, 3, 4):
        p = os.path.join(D, f'smp{n}.{L}.xml')
        if os.path.exists(p):
            sm |= {s for _, s, _ in parse_sitemap(p)}
    print('sitemap 唯一 slug:', len(sm))

    def cat(s): return s.split(':')[0] if ':' in s else '_default'

    def name(s): return s.split(':', 1)[1] if ':' in s else s
    und = sorted(s for s in sm if name(s).startswith('_'))
    print(f'其中「页名以 _ 开头」（ListPages 默认不返回）: {len(und)}')
    for s in und:
        print('   ', s)
    print('\nsitemap 前缀分布:')
    for c, n in collections.Counter(map(cat, sm)).most_common():
        print(f'   {c:<28} {n}')
    p = os.path.join(D, 'db_slugs.csv')
    if os.path.exists(p):
        live = {r[0] for r in csv.reader(open(p, encoding='utf-8')) if r[1] == 'f'}
        print(f'\nv1 库活页 {len(live)}；sitemap∖库={len(sm - live)}；库∖sitemap={len(live - sm)}')
        print('  库∖sitemap 前缀:', dict(collections.Counter(map(cat, live - sm)).most_common(10)))


# ---------------------------------------------------------------- Q5
def cmd_threads(L):
    tid = set()
    for n in range(1, 10):
        p = os.path.join(D, f'smt{n}.{L}.xml')
        if not os.path.exists(p):
            continue
        ids = re.findall(r'forum/t-(\d+)', open(p, encoding='utf-8').read())
        print(f'  smt{n}: {len(ids)} 条  id∈[{min(map(int, ids))}, {max(map(int, ids))}]')
        tid |= set(map(int, ids))
    print('thread sitemap 唯一 id:', len(tid))
    p = os.path.join(D, 'db_threads_live.txt')
    if os.path.exists(p):
        db = {int(x) for x in open(p) if x.strip()}
        print(f'  v1 库活 thread {len(db)}；sitemap∖库={len(tid - db)}；库∖sitemap={len(db - tid)}')
    p = os.path.join(D, f'smc.{L}.xml')
    if os.path.exists(p):
        cids = re.findall(r'forum/c-(\d+)', open(p, encoding='utf-8').read())
        print(f'  category sitemap: {len(cids)} 个 -> {sorted(map(int, cids))}')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    c, a = sys.argv[1], sys.argv[2:]
    {'lag': lambda: cmd_lag(a), 'drift': lambda: cmd_drift(*a), 'order': lambda: cmd_order(*a),
     'domain': lambda: cmd_domain(*a), 'threads': lambda: cmd_threads(*a)}[c]()
