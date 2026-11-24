import readline from 'node:readline';
import readlinePromises from 'node:readline/promises';

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

export const style = {
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
};

export interface SelectOption<T> {
  label: string;
  hint?: string;
  value: T;
}

export function isInteractiveTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Pure helper for cursor movement in list selectors (exported for unit testing).
 */
export function moveCursor(current: number, delta: number, total: number): number {
  if (total <= 0) return 0;
  return (current + delta + total) % total;
}

export async function selectOption<T>(
  title: string,
  options: SelectOption<T>[],
  initialIndex = 0,
  cancelLabel = 'Esc/q 返回上一级',
): Promise<T | null> {
  if (options.length === 0) return null;
  if (!isInteractiveTty()) {
    throw new Error('当前非交互式终端，请通过命令行参数指定目标。');
  }

  let cursor = Math.max(0, Math.min(initialIndex, options.length - 1));
  let renderedLines = 0;

  const render = () => {
    if (renderedLines > 0) {
      readline.moveCursor(process.stdout, 0, -renderedLines);
      readline.clearScreenDown(process.stdout);
    }
    const lines: string[] = [
      style.bold(title),
      style.yellow(`  (↑/↓ 或 j/k 移动，Enter 确认，${cancelLabel})`),
    ];
    options.forEach((opt, idx) => {
      const isSelected = idx === cursor;
      const prefix = isSelected ? style.cyan('❯ ') : '  ';
      const label = isSelected ? style.cyan(style.bold(opt.label)) : opt.label;
      const hint = opt.hint ? `  (${opt.hint})` : '';
      lines.push(`${prefix}${label}${hint}`);
    });
    process.stdout.write(`${lines.join('\n')}\n`);
    renderedLines = lines.length;
  };

  return new Promise<T | null>((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    // Hide cursor while selecting
    process.stdout.write('\x1b[?25l');
    render();

    const cleanup = () => {
      process.stdin.removeListener('keypress', onKeypress);
      if (!wasRaw) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      process.stdout.write('\x1b[?25h');
    };

    const onKeypress = (str: string, key: readline.Key) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        process.stdout.write('\n');
        resolve(null);
        return;
      }
      if (key.name === 'escape' || str === 'q') {
        cleanup();
        resolve(null);
        return;
      }
      if (key.name === 'up' || str === 'k') {
        cursor = moveCursor(cursor, -1, options.length);
        render();
        return;
      }
      if (key.name === 'down' || str === 'j') {
        cursor = moveCursor(cursor, 1, options.length);
        render();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const chosen = options[cursor]?.value ?? null;
        cleanup();
        resolve(chosen);
      }
    };

    process.stdin.on('keypress', onKeypress);
  });
}

export async function askText(prompt: string, defaultValue?: string): Promise<string> {
  const rl = readlinePromises.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const suffix = defaultValue ? ` ${style.dim(`[${defaultValue}]`)}` : '';
    const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
    return answer || defaultValue || '';
  } finally {
    rl.close();
  }
}

export async function confirm(prompt: string, defaultYes = false): Promise<boolean> {
  if (!isInteractiveTty()) return defaultYes;
  const rl = readlinePromises.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const hint = defaultYes ? '[Y/n]' : '[y/N]';
    const answer = (await rl.question(`${prompt} ${style.dim(hint)} `)).trim().toLowerCase();
    if (!answer) return defaultYes;
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export async function waitForEnter(message = '按回车键返回主菜单...'): Promise<void> {
  if (!isInteractiveTty()) return;
  const rl = readlinePromises.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    await rl.question(style.cyan(`\n${message}`));
  } finally {
    rl.close();
  }
}
