// Lightweight CLI progress utilities with ETA
import chalk from 'chalk';
import prettyMs from 'pretty-ms';
import cliProgress from 'cli-progress';

export class Progress {
  static _pausedMs = 0;

  static addPause(ms) {
    if (Number.isFinite(ms) && ms > 0) {
      Progress._pausedMs += ms;
    }
  }

  static createBar({ title = 'Progress', total = 0 } = {}) {
    const start = Date.now();
    const multibar = new cliProgress.MultiBar({
      clearOnComplete: true,
      hideCursor: true,
      stopOnComplete: true,
      format: `${chalk.gray('{title}')} ${chalk.cyan('{bar}')} {percentage}% | {value}/{total} | ETA {eta2} | {rate} it/s`,
      autopadding: true,
      barCompleteChar: '█',
      barIncompleteChar: '░'
    }, cliProgress.Presets.shades_classic);

    const bar = multibar.create(Math.max(total, 1), 0, { title });

    const update = (value) => {
      const now = Date.now();
      const activeElapsedMs = Math.max(0, now - start - Progress._pausedMs);
      const rateNum = value > 0 && activeElapsedMs > 0 ? (value / (activeElapsedMs / 1000)) : 0;
      const rate = rateNum.toFixed(1);
      const remaining = Math.max(0, total - value);
      const etaMs = rateNum > 0 ? Math.ceil((remaining / rateNum) * 1000) : Infinity;
      const eta2 = Number.isFinite(etaMs) ? prettyMs(etaMs, { compact: true }) : '∞';
      bar.update(Math.min(value, total), { rate, eta2 });
    };

    return {
      increment: (delta = 1) => {
        update(bar.value + delta);
      },
      update,
      setTotal: (newTotal) => {
        try { bar.setTotal(newTotal); } catch {}
      },
      stop: () => {
        try { multibar.stop(); } catch {}
        const elapsed = Math.max(0, Date.now() - start);
        const label = chalk.gray(`${title} done in ${prettyMs(elapsed)}`);
        // eslint-disable-next-line no-console
        console.log(label);
      }
    };
  }
}


