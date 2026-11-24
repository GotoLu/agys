import { execFileSync } from 'node:child_process';
import type { KeychainAdapter, KeychainEntryMeta } from '../types.js';

const SECURITY_BIN = '/usr/bin/security';

/**
 * Parse `security dump-keychain` output for generic password service & account pairs.
 * Does not read or expose secret values.
 */
export function parseKeychainDump(dumpOutput: string, targetServices: Set<string>): KeychainEntryMeta[] {
  const results: KeychainEntryMeta[] = [];
  const seen = new Set<string>();

  let currentService: string | null = null;
  let currentAccount: string | null = null;

  const flush = () => {
    if (currentService && currentAccount !== null && targetServices.has(currentService)) {
      const key = `${currentService}\0${currentAccount}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ service: currentService, account: currentAccount });
      }
    }
    currentService = null;
    currentAccount = null;
  };

  for (const rawLine of dumpOutput.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('keychain:') || line.startsWith('class:')) {
      flush();
      continue;
    }

    const svceMatch = line.match(/^"svce"<blob>="(.*)"$/);
    if (svceMatch) {
      currentService = svceMatch[1];
      continue;
    }

    const acctMatch = line.match(/^"acct"<blob>="(.*)"$/);
    if (acctMatch) {
      currentAccount = acctMatch[1];
    }
  }
  flush();

  return results;
}

export class MacOSKeychainAdapter implements KeychainAdapter {
  listEntriesByServices(services: string[]): KeychainEntryMeta[] {
    if (services.length === 0) return [];
    const output = execFileSync(SECURITY_BIN, ['dump-keychain'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseKeychainDump(output, new Set(services));
  }

  getSecret(service: string, account: string): string | null {
    try {
      const output = execFileSync(
        SECURITY_BIN,
        ['find-generic-password', '-s', service, '-a', account, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return output.replace(/\r?\n$/, '');
    } catch {
      return null;
    }
  }

  setSecret(service: string, account: string, secret: string): void {
    // Use -X with hex encoding so arbitrary UTF-8, quotes, or newlines are preserved cleanly.
    const hexSecret = Buffer.from(secret, 'utf8').toString('hex');
    execFileSync(
      SECURITY_BIN,
      ['add-generic-password', '-U', '-s', service, '-a', account, '-X', hexSecret],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  }

  deleteSecret(service: string, account: string): boolean {
    try {
      execFileSync(
        SECURITY_BIN,
        ['delete-generic-password', '-s', service, '-a', account],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return true;
    } catch {
      return false;
    }
  }
}
