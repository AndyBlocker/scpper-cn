// src/utils/Progress.js
import cliProgress from 'cli-progress';
import ora from 'ora';
import chalk from 'chalk';

export class Progress {
  constructor() {
    this.bars = new cliProgress.MultiBar({
      clearOnComplete: false,
      hideCursor: true,
      format: '{phase} {bar} {value}/{total} {percentage}% | ETA {eta}s'
    }, cliProgress.Presets.shades_classic);
    this.map = new Map();
  }

  /** 创建或获取进度条 */
  getBar(phase, total) {
    if (!this.map.has(phase)) {
      const bar = this.bars.create(total, 0, { phase: chalk.cyan(phase) });
      this.map.set(phase, bar);
    }
    return this.map.get(phase);
  }

  stop() {
    this.bars.stop();
  }

  /** 静态方法：返回一个倒计时 spinner */
  static waitSpinner(seconds, text = 'WAIT') {
    const spinner = ora({ text: `${text} ⏳ ${seconds}s`, color: 'yellow' }).start();
    const iv = setInterval(() => {
      seconds--;
      spinner.text = `${text} ⏳ ${seconds}s`;
      if (seconds <= 0) {
        clearInterval(iv);
        spinner.succeed(`${text} done`);
      }
    }, 1000);
  }
}
