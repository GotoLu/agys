import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { parseKeychainDump } from '../core/keychain.js';
import {
  ANTIGRAVITY_OAUTH_CLIENT_ID,
  buildGoogleAuthUrl,
  decodeJwtEmail,
  generatePkcePair,
} from '../core/oauth.js';
import { resolveAppPaths } from '../core/paths.js';
import { formatPercent, formatResetCountdown, parseQuotaResponse } from '../core/quota.js';
import {
  AccountManager,
  decodeGoKeyringOAuth,
  encodeGoKeyringSecret,
} from '../core/snapshot.js';
import type { KeychainAdapter, KeychainEntryMeta } from '../types.js';
import { moveCursor } from '../ui/prompt.js';

class MemoryKeychainAdapter implements KeychainAdapter {
  private store = new Map<string, string>();

  private key(service: string, account: string): string {
    return `${service}\0${account}`;
  }

  listEntriesByServices(services: string[]): KeychainEntryMeta[] {
    const allowed = new Set(services);
    const result: KeychainEntryMeta[] = [];
    for (const k of this.store.keys()) {
      const [service, account] = k.split('\0');
      if (allowed.has(service)) {
        result.push({ service, account });
      }
    }
    return result;
  }

  getSecret(service: string, account: string): string | null {
    return this.store.get(this.key(service, account)) ?? null;
  }

  setSecret(service: string, account: string, secret: string): void {
    this.store.set(this.key(service, account), secret);
  }

  deleteSecret(service: string, account: string): boolean {
    return this.store.delete(this.key(service, account));
  }
}

function makeFakeJwt(email: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ email, sub: '12345' })).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('parseKeychainDump', () => {
  it('extracts matching service and account entries without duplicates', () => {
    const sample = `
keychain: "/Users/test/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "acct"<blob>="u111/oauth2:abc@1_IDENTITY"
    "svce"<blob>="gemini"
class: "genp"
attributes:
    "acct"<blob>="ignored_account"
    "svce"<blob>="other.service"
class: "genp"
attributes:
    "acct"<blob>="u111/oauth2:abc_ACCOUNTS"
    "svce"<blob>="antigravity.plugins"
`;
    const entries = parseKeychainDump(sample, new Set(['gemini', 'antigravity.plugins']));
    assert.deepEqual(entries, [
      { service: 'gemini', account: 'u111/oauth2:abc@1_IDENTITY' },
      { service: 'antigravity.plugins', account: 'u111/oauth2:abc_ACCOUNTS' },
    ]);
  });
});

describe('AccountManager', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function setupTestEnv() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-account-test-'));
    tempDirs.push(tmpRoot);
    const homeDir = path.join(tmpRoot, 'home');
    const vaultDir = path.join(tmpRoot, 'vault');
    fs.mkdirSync(homeDir, { recursive: true });
    const paths = resolveAppPaths(homeDir, vaultDir);
    const keychain = new MemoryKeychainAdapter();
    const manager = new AccountManager(paths, keychain);
    return { paths, keychain, manager };
  }

  it('encrypts snapshots and switches cleanly between two accounts', () => {
    const { paths, keychain, manager } = setupTestEnv();

    // Account 1 login state
    const scopePath = paths.stateFiles[0].path;
    fs.mkdirSync(path.dirname(scopePath), { recursive: true });
    fs.writeFileSync(scopePath, 'u_account_one_scope', 'utf8');
    keychain.setSecret(
      'gemini',
      'u_account_one/oauth2:1@1_IDENTITY',
      JSON.stringify({ refresh_token: 'secret-token-1', id_token: makeFakeJwt('pro1@gmail.com') }),
    );

    const meta1 = manager.save('pro1');
    assert.equal(meta1.alias, 'pro1');
    assert.equal(meta1.email, 'pro1@gmail.com');

    // Verify encrypted file does not leak plaintext secrets
    const encRaw = fs.readFileSync(path.join(paths.profilesDir, 'pro1.enc'), 'utf8');
    assert.equal(encRaw.includes('secret-token-1'), false);
    assert.equal(encRaw.includes('pro1@gmail.com'), false);

    // Account 2 login state (simulating user logging into another account)
    keychain.deleteSecret('gemini', 'u_account_one/oauth2:1@1_IDENTITY');
    keychain.setSecret(
      'gemini',
      'u_account_two/oauth2:2@1_IDENTITY',
      JSON.stringify({ refresh_token: 'secret-token-2', email: 'pro2@gmail.com' }),
    );
    fs.writeFileSync(scopePath, 'u_account_two_scope', 'utf8');

    const meta2 = manager.save('pro2');
    assert.equal(meta2.email, 'pro2@gmail.com');

    // Switch back to pro1
    const switch1 = manager.use('pro1');
    assert.equal(switch1.switchedTo.alias, 'pro1');
    assert.equal(switch1.autoBackedUp, false);
    assert.equal(keychain.getSecret('gemini', 'u_account_two/oauth2:2@1_IDENTITY'), null);
    assert.ok(keychain.getSecret('gemini', 'u_account_one/oauth2:1@1_IDENTITY')?.includes('secret-token-1'));
    assert.equal(fs.readFileSync(scopePath, 'utf8'), 'u_account_one_scope');

    // Switch back to previous (pro2) via '-'
    const switch2 = manager.use('-');
    assert.equal(switch2.switchedTo.alias, 'pro2');
    assert.ok(keychain.getSecret('gemini', 'u_account_two/oauth2:2@1_IDENTITY')?.includes('secret-token-2'));
    assert.equal(fs.readFileSync(scopePath, 'utf8'), 'u_account_two_scope');
  });

  it('auto-backs up unsaved live credentials before switching', () => {
    const { keychain, manager } = setupTestEnv();

    keychain.setSecret('gemini', 'u1/oauth2:1@1_IDENTITY', JSON.stringify({ email: 'a@gmail.com' }));
    manager.save('acc1');

    // Mutate live state without saving
    keychain.setSecret('gemini', 'u1/oauth2:1@1_IDENTITY', JSON.stringify({ email: 'unsaved@gmail.com' }));
    const res = manager.use('acc1');
    assert.equal(res.autoBackedUp, true);

    // Auto backup should not clutter public list()
    const { accounts } = manager.list();
    assert.deepEqual(
      accounts.map((a) => a.alias),
      ['acc1'],
    );
  });

  it('rejects invalid aliases and supports removal', () => {
    const { keychain, manager } = setupTestEnv();
    keychain.setSecret('gemini', 'u1/oauth2:1@1_IDENTITY', '{"email":"a@gmail.com"}');

    assert.throws(() => manager.save('../evil'), /Invalid alias/);
    manager.save('temp');
    assert.equal(manager.remove('temp'), true);
    assert.equal(manager.remove('temp'), false);
    assert.throws(() => manager.use('temp'), /not found/);
  });

  it('clears live session safely with auto-backup for new account onboarding', () => {
    const { keychain, manager } = setupTestEnv();
    keychain.setSecret('gemini', 'antigravity', JSON.stringify({ email: 'unsaved@gmail.com' }));

    const cleared = manager.clearLiveSession();
    assert.equal(cleared.autoBackedUp, true);
    assert.equal(cleared.clearedCount, 1);
    assert.equal(keychain.getSecret('gemini', 'antigravity'), null);
    assert.equal(manager.list().activeAlias, null);
  });

  it('encrypts OAuth credentials and auto-generates go-keyring Keychain entry for direct switching', () => {
    const { paths, keychain, manager } = setupTestEnv();

    const meta = manager.saveOAuthAccount('oauth_only', {
      email: 'oauth-pro@example.com',
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      idToken: makeFakeJwt('oauth-pro@example.com'),
      tokenType: 'Bearer',
      scope: 'openid email',
      expiryDate: Date.now() + 3600_000,
    });

    assert.equal(meta.alias, 'oauth_only');
    assert.equal(meta.email, 'oauth-pro@example.com');
    assert.equal(meta.hasOAuth, true);

    const encRaw = fs.readFileSync(path.join(paths.profilesDir, 'oauth_only.enc'), 'utf8');
    assert.equal(encRaw.includes('mock-refresh-token'), false);
    assert.equal(encRaw.includes('mock-access-token'), false);

    // Should switch directly without requiring a second manual client login
    const switched = manager.use('oauth_only');
    assert.equal(switched.switchedTo.alias, 'oauth_only');
    const written = keychain.getSecret('gemini', 'antigravity');
    assert.ok(written?.startsWith('go-keyring-base64:'));
    const decoded = decodeGoKeyringOAuth(written ?? '');
    assert.equal(decoded?.email, 'oauth-pro@example.com');
    assert.equal(decoded?.accessToken, 'mock-access-token');

    // Verify get/update OAuth credentials
    const loaded = manager.getOAuthCredentials('oauth_only');
    assert.equal(loaded?.accessToken, 'mock-access-token');
    if (loaded) {
      manager.updateOAuthCredentials('oauth_only', {
        ...loaded,
        accessToken: 'mock-refreshed-token',
      });
    }
    assert.equal(manager.getOAuthCredentials('oauth_only')?.accessToken, 'mock-refreshed-token');
  });

  it('extracts email and OAuth credentials from existing go-keyring-base64 Keychain entry on save()', () => {
    const { keychain, manager } = setupTestEnv();
    const encoded = encodeGoKeyringSecret({
      email: 'saved-cli@example.com',
      accessToken: 'mock-cli-token',
      refreshToken: 'mock-cli-refresh',
      idToken: null,
      tokenType: 'Bearer',
      scope: '',
      expiryDate: Date.now() + 3600_000,
    });
    keychain.setSecret('gemini', 'antigravity', encoded);

    const meta = manager.save('from_cli');
    assert.equal(meta.email, 'saved-cli@example.com');
    assert.equal(meta.hasOAuth, true);
    assert.equal(manager.getOAuthCredentials('from_cli')?.refreshToken, 'mock-cli-refresh');
  });

  it('preserves existing antigravity.plugins entries when target snapshot has no plugin entries', () => {
    const { keychain, manager } = setupTestEnv();
    keychain.setSecret('gemini', 'antigravity', encodeGoKeyringSecret({
      email: 'acc1@example.com',
      accessToken: 'mock-acc1-token',
      refreshToken: 'mock-acc1-refresh',
      idToken: null,
      tokenType: 'Bearer',
      scope: '',
      expiryDate: Date.now() + 3600_000,
    }));
    keychain.setSecret('antigravity.plugins', 'u1/oauth2:gdrive@1', 'plugin-secret-acc1');
    manager.save('acc1');

    // Create OAuth-only account acc2 (has no antigravity.plugins entries)
    manager.saveOAuthAccount('acc2', {
      email: 'acc2@example.com',
      accessToken: 'mock-acc2-token',
      refreshToken: 'mock-acc2-refresh',
      idToken: null,
      tokenType: 'Bearer',
      scope: '',
      expiryDate: Date.now() + 3600_000,
    });

    manager.use('acc2');
    // Primary gemini switched to acc2, while plugin entry from acc1 is preserved
    assert.equal(decodeGoKeyringOAuth(keychain.getSecret('gemini', 'antigravity') ?? '')?.email, 'acc2@example.com');
    assert.equal(keychain.getSecret('antigravity.plugins', 'u1/oauth2:gdrive@1'), 'plugin-secret-acc1');
  });
});

describe('Quota parser & formatters', () => {
  it('extracts 5h and weekly Gemini buckets and formats percentages & countdowns', () => {
    const summary = parseQuotaResponse({
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-5h',
              displayName: 'Five Hour Limit Remaining',
              remainingFraction: 0.72,
              resetTime: '2026-11-24T10:00:00Z',
            },
            {
              bucketId: 'gemini-weekly',
              displayName: 'Weekly Limit Remaining',
              remainingFraction: 0.8331,
              resetTime: '2026-11-26T08:00:00Z',
            },
          ],
        },
      ],
    });

    assert.equal(summary.fiveHourRemaining, 0.72);
    assert.equal(summary.weeklyRemaining, 0.8331);
    assert.equal(formatPercent(summary.fiveHourRemaining), '72%');
    assert.equal(formatPercent(summary.weeklyRemaining), '83%');
    assert.equal(formatPercent(null), '--');

    const nowMs = Date.parse('2026-11-24T08:00:00Z');
    assert.equal(formatResetCountdown(summary.fiveHourResetTime, nowMs), '2h0m');
    assert.equal(formatResetCountdown(summary.weeklyResetTime, nowMs), '2d0h');
  });
});

describe('OAuth helpers', () => {
  it('generates PKCE pair, builds auth URL, and decodes JWT email', () => {
    const pkce = generatePkcePair();
    assert.ok(pkce.verifier.length >= 43);
    assert.ok(pkce.challenge.length >= 43);

    const url = new URL(
      buildGoogleAuthUrl({
        redirectUri: 'http://127.0.0.1:12345/oauth-callback',
        state: 'state123',
        codeChallenge: pkce.challenge,
      }),
    );
    assert.equal(url.searchParams.get('client_id'), ANTIGRAVITY_OAUTH_CLIENT_ID);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('state'), 'state123');
    assert.equal(decodeJwtEmail(makeFakeJwt('user@gmail.com')), 'user@gmail.com');
  });
});

describe('moveCursor', () => {
  it('wraps around cleanly at boundaries and handles empty list', () => {
    assert.equal(moveCursor(0, -1, 3), 2);
    assert.equal(moveCursor(2, 1, 3), 0);
    assert.equal(moveCursor(1, 1, 3), 2);
    assert.equal(moveCursor(0, 1, 0), 0);
  });
});
