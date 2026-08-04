/**
 * 断言记录器 + 中文报告表。
 *
 * 为什么不直接用 node:assert 逐条 throw：第一条失败就中断，后面几十条断言的结论全部丢失。
 * 冒烟 smoke_test.sql 用的是同一套模式（pg_temp.chk 先记录、最后统一 RAISE），
 * 这里保持一致 —— 一次运行给出**全部**结论，回归时才能一眼看出"坏了几条、坏在哪一节"。
 *
 * 三态：通过 / 失败 / 跳过（跳过用于 T6.6 这种"角色还不存在"的条件测试，
 * 跳过必须打印原因和补救提示，绝不能静默变成"通过"）。
 */

export type CheckState = 'pass' | 'fail' | 'skip';

export interface CheckRow {
  section: string;
  name: string;
  state: CheckState;
  detail?: string;
}

function stateTag(s: CheckState): string {
  return s === 'pass' ? '通过' : s === 'fail' ? '失败' : '跳过';
}

/** 稳定的 JSON 序列化（对象键排序），用于把结构化实际值/期望值印成可比对的字符串。 */
export function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(Object.entries(val as Record<string, unknown>).sort());
    }
    return val;
  });
}

export class Report {
  private readonly rows: CheckRow[] = [];

  constructor(readonly title: string) {}

  /** 布尔断言。 */
  chk(section: string, name: string, cond: boolean, detail?: string): boolean {
    this.rows.push({ section, name, state: cond ? 'pass' : 'fail', ...(detail ? { detail } : {}) });
    return cond;
  }

  /** 相等断言（深比较走 stable()）。失败时 detail 自动带上「期望/实得」。 */
  eq(section: string, name: string, actual: unknown, expected: unknown, detail?: string): boolean {
    const a = stable(actual);
    const e = stable(expected);
    const ok = a === e;
    const d = ok
      ? (detail ?? a)
      : `期望 ${e}，实得 ${a}${detail ? `（${detail}）` : ''}`;
    return this.chk(section, name, ok, d);
  }

  /** 条件跳过。 */
  skip(section: string, name: string, reason: string): void {
    this.rows.push({ section, name, state: 'skip', detail: reason });
  }

  get counts(): { pass: number; fail: number; skip: number; total: number } {
    const pass = this.rows.filter((r) => r.state === 'pass').length;
    const fail = this.rows.filter((r) => r.state === 'fail').length;
    const skip = this.rows.filter((r) => r.state === 'skip').length;
    return { pass, fail, skip, total: this.rows.length };
  }

  /** 打印明细 + 分节汇总；有失败则抛错（node:test 据此判红）。 */
  finish(): void {
    const out: string[] = [];
    const bar = '═'.repeat(78);
    out.push('');
    out.push(bar);
    out.push(`  ${this.title}`);
    out.push(bar);

    let lastSection = '';
    for (const r of this.rows) {
      if (r.section !== lastSection) {
        out.push(`── ${r.section} ${'─'.repeat(Math.max(0, 72 - r.section.length))}`);
        lastSection = r.section;
      }
      const mark = r.state === 'pass' ? '✔' : r.state === 'fail' ? '✘' : '○';
      out.push(`  ${mark} [${stateTag(r.state)}] ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
    }

    // 分节汇总
    const bySection = new Map<string, { pass: number; fail: number; skip: number }>();
    for (const r of this.rows) {
      const acc = bySection.get(r.section) ?? { pass: 0, fail: 0, skip: 0 };
      acc[r.state] += 1;
      bySection.set(r.section, acc);
    }
    out.push('─'.repeat(78));
    out.push('  节'.padEnd(34) + '用例'.padStart(6) + '通过'.padStart(8) + '失败'.padStart(8) + '跳过'.padStart(8));
    for (const [sec, c] of bySection) {
      const total = c.pass + c.fail + c.skip;
      out.push(
        `  ${sec}`.padEnd(34) +
          String(total).padStart(6) +
          String(c.pass).padStart(8) +
          String(c.fail).padStart(8) +
          String(c.skip).padStart(8),
      );
    }
    const t = this.counts;
    out.push('─'.repeat(78));
    out.push(
      '  总计'.padEnd(34) +
        String(t.total).padStart(6) +
        String(t.pass).padStart(8) +
        String(t.fail).padStart(8) +
        String(t.skip).padStart(8),
    );
    out.push(bar);
    out.push('');
    process.stdout.write(out.join('\n') + '\n');

    if (t.fail > 0) {
      const failed = this.rows.filter((r) => r.state === 'fail');
      throw new Error(
        `${this.title}：${t.fail} 条断言失败\n` +
          failed.map((r) => `  · [${r.section}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`).join('\n'),
      );
    }
  }
}

/** 确定性 PRNG（mulberry32）。属性测试必须可复现：失败时报告 seed 就能原样重跑。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
