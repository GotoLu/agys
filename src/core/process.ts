import { execFileSync } from 'node:child_process';

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepMs(ms: number): void {
  Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

export function isAntigravityDesktopRunning(): boolean {
  try {
    const out = execFileSync(
      '/usr/bin/pgrep',
      ['-f', '/Applications/Antigravity.app/Contents/MacOS/Antigravity'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export function restartAntigravityDesktop(): void {
  if (isAntigravityDesktopRunning()) {
    execFileSync('/usr/bin/osascript', ['-e', 'tell application "Antigravity" to quit'], {
      stdio: 'ignore',
    });

    // Wait up to 8s for all Electron helper processes to exit before relaunching,
    // otherwise macOS ignores `open -a` while the app is still terminating.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && isAntigravityDesktopRunning()) {
      sleepMs(200);
    }
    sleepMs(400);
  }
  execFileSync('/usr/bin/open', ['-a', 'Antigravity'], { stdio: 'ignore' });
}
