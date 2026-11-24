import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AccountMeta,
  AccountSnapshot,
  EncryptedPayload,
  KeychainAdapter,
  KeychainEntry,
  OAuthCredentials,
  StateFileSnapshot,
  VaultIndex,
} from '../types.js';
import type { AppPaths } from './paths.js';

export const TARGET_KEYCHAIN_SERVICES = ['gemini', 'antigravity.plugins'];
const VAULT_KEY_SERVICE = 'agy-account.vault-key';
const VAULT_KEY_ACCOUNT = 'default';
const AUTO_BACKUP_ALIAS = '_auto_backup';
const ALIAS_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

export class MissingKeychainBindingError extends Error {
  readonly alias: string;
  readonly email: string | null;

  constructor(alias: string, email: string | null) {
    super(
      `账号 "${alias}" 目前仅保存了 OAuth 凭证，尚未捕获客户端 Keychain 登录态。请先用该账号在 Antigravity 客户端或 agy 登录一次后执行 save ${alias}。`,
    );
    this.name = 'MissingKeychainBindingError';
    this.alias = alias;
    this.email = email;
  }
}

export interface InspectResult {
  keychainEntries: Array<{ service: string; account: string }>;
  stateFiles: Array<{ key: string; path: string; exists: boolean; sizeBytes: number }>;
  detectedEmail: string | null;
  fingerprint: string;
  matchedAlias: string | null;
  activeAlias: string | null;
}

export class AccountManager {
  private readonly paths: AppPaths;
  private readonly keychain: KeychainAdapter;

  constructor(paths: AppPaths, keychain: KeychainAdapter) {
    this.paths = paths;
    this.keychain = keychain;
  }

  private ensureVaultDirs(): void {
    fs.mkdirSync(this.paths.vaultDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.paths.profilesDir, { recursive: true, mode: 0o700 });
  }

  private getOrCreateVaultKey(): Buffer {
    const existingHex = this.keychain.getSecret(VAULT_KEY_SERVICE, VAULT_KEY_ACCOUNT);
    if (existingHex && /^[0-9a-f]{64}$/i.test(existingHex.trim())) {
      return Buffer.from(existingHex.trim(), 'hex');
    }
    const newKey = crypto.randomBytes(32);
    this.keychain.setSecret(VAULT_KEY_SERVICE, VAULT_KEY_ACCOUNT, newKey.toString('hex'));
    return newKey;
  }

  private encryptSnapshot(snapshot: AccountSnapshot): EncryptedPayload {
    const key = this.getOrCreateVaultKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(JSON.stringify(snapshot), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      version: 1,
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: encrypted.toString('base64'),
    };
  }

  private decryptSnapshot(payload: EncryptedPayload): AccountSnapshot {
    const keyHex = this.keychain.getSecret(VAULT_KEY_SERVICE, VAULT_KEY_ACCOUNT);
    if (!keyHex) {
      throw new Error('Vault encryption key not found in macOS Keychain.');
    }
    const key = Buffer.from(keyHex.trim(), 'hex');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(payload.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString('utf8')) as AccountSnapshot;
  }

  private readIndex(): VaultIndex {
    if (!fs.existsSync(this.paths.indexFile)) {
      return { version: 1, activeAlias: null, previousAlias: null, accounts: {} };
    }
    const raw = fs.readFileSync(this.paths.indexFile, 'utf8');
    return JSON.parse(raw) as VaultIndex;
  }

  private writeIndex(index: VaultIndex): void {
    this.ensureVaultDirs();
    fs.writeFileSync(this.paths.indexFile, JSON.stringify(index, null, 2), { mode: 0o600 });
  }

  private profilePath(alias: string): string {
    return path.join(this.paths.profilesDir, `${alias}.enc`);
  }

  private validateAlias(alias: string): void {
    if (!ALIAS_PATTERN.test(alias)) {
      throw new Error(`Invalid alias "${alias}". Use 1-32 characters of [a-zA-Z0-9_-].`);
    }
  }

  private captureLiveEntries(): KeychainEntry[] {
    const metas = this.keychain.listEntriesByServices(TARGET_KEYCHAIN_SERVICES);
    const entries: KeychainEntry[] = [];
    for (const meta of metas) {
      const secret = this.keychain.getSecret(meta.service, meta.account);
      if (secret !== null) {
        entries.push({ ...meta, secret });
      }
    }
    return entries.sort((a, b) => `${a.service}\0${a.account}`.localeCompare(`${b.service}\0${b.account}`));
  }

  private captureLiveStateFiles(): StateFileSnapshot[] {
    const snapshots: StateFileSnapshot[] = [];
    for (const item of this.paths.stateFiles) {
      if (fs.existsSync(item.path)) {
        const buf = fs.readFileSync(item.path);
        snapshots.push({
          key: item.key,
          targetPath: item.path,
          contentBase64: buf.toString('base64'),
        });
      }
    }
    return snapshots;
  }

  private computeFingerprint(
    entries: KeychainEntry[],
    stateFiles: StateFileSnapshot[],
    oauth?: OAuthCredentials,
  ): string {
    const hash = crypto.createHash('sha256');
    for (const entry of entries) {
      hash.update(`kc:${entry.service}:${entry.account}:${entry.secret}\n`);
    }
    for (const file of stateFiles) {
      hash.update(`fs:${file.key}:${file.contentBase64}\n`);
    }
    if (oauth) {
      hash.update(`oauth:${oauth.email ?? ''}:${oauth.refreshToken ?? oauth.accessToken}\n`);
    }
    return hash.digest('hex').slice(0, 16);
  }

  inspect(): InspectResult {
    const entries = this.captureLiveEntries();
    const stateFiles = this.captureLiveStateFiles();
    const fingerprint = this.computeFingerprint(entries, stateFiles);
    const index = this.readIndex();

    const matched = Object.values(index.accounts).find(
      (acc) => acc.alias !== AUTO_BACKUP_ALIAS && acc.fingerprint === fingerprint,
    );

    return {
      keychainEntries: entries.map(({ service, account }) => ({ service, account })),
      stateFiles: this.paths.stateFiles.map((item) => {
        const exists = fs.existsSync(item.path);
        const sizeBytes = exists ? fs.statSync(item.path).size : 0;
        return { key: item.key, path: item.path, exists, sizeBytes };
      }),
      detectedEmail: extractEmailFromEntries(entries),
      fingerprint,
      matchedAlias: matched?.alias ?? null,
      activeAlias: index.activeAlias,
    };
  }

  save(alias: string, emailOverride?: string): AccountMeta {
    this.validateAlias(alias);
    const entries = this.captureLiveEntries();
    if (entries.length === 0) {
      throw new Error(
        'No Antigravity / Gemini credentials found in macOS Keychain. Sign in first before saving.',
      );
    }
    const stateFiles = this.captureLiveStateFiles();
    const fingerprint = this.computeFingerprint(entries, stateFiles);
    const index = this.readIndex();
    const now = new Date().toISOString();
    const existing = index.accounts[alias];
    const existingOAuth = this.readExistingOAuth(alias);
    const derivedOAuth = extractOAuthFromEntries(entries);
    const oauth = existingOAuth ?? derivedOAuth ?? undefined;
    const email =
      emailOverride ?? extractEmailFromEntries(entries) ?? oauth?.email ?? existing?.email ?? null;

    const snapshot: AccountSnapshot = {
      version: 1,
      alias,
      email,
      fingerprint,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      oauth,
      keychainEntries: entries,
      stateFiles,
    };

    this.ensureVaultDirs();
    const encrypted = this.encryptSnapshot(snapshot);
    fs.writeFileSync(this.profilePath(alias), JSON.stringify(encrypted), { mode: 0o600 });

    const meta: AccountMeta = {
      alias,
      email,
      hasOAuth: Boolean(snapshot.oauth),
      fingerprint,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    };
    index.accounts[alias] = meta;
    if (alias !== AUTO_BACKUP_ALIAS) {
      if (index.activeAlias && index.activeAlias !== alias) {
        index.previousAlias = index.activeAlias;
      }
      index.activeAlias = alias;
    }
    this.writeIndex(index);
    return meta;
  }

  private readExistingOAuth(alias: string): OAuthCredentials | undefined {
    const encFile = this.profilePath(alias);
    if (!fs.existsSync(encFile)) return undefined;
    try {
      const payload = JSON.parse(fs.readFileSync(encFile, 'utf8')) as EncryptedPayload;
      return this.decryptSnapshot(payload).oauth;
    } catch {
      return undefined;
    }
  }

  getOAuthCredentials(alias: string): OAuthCredentials | null {
    this.validateAlias(alias);
    return this.readExistingOAuth(alias) ?? null;
  }

  updateOAuthCredentials(alias: string, oauth: OAuthCredentials): void {
    this.validateAlias(alias);
    const encFile = this.profilePath(alias);
    if (!fs.existsSync(encFile)) return;
    const payload = JSON.parse(fs.readFileSync(encFile, 'utf8')) as EncryptedPayload;
    const snapshot = this.decryptSnapshot(payload);
    snapshot.oauth = oauth;
    snapshot.email = oauth.email ?? snapshot.email;
    snapshot.updatedAt = new Date().toISOString();
    snapshot.fingerprint = this.computeFingerprint(
      snapshot.keychainEntries,
      snapshot.stateFiles,
      oauth,
    );
    const updatedPayload = this.encryptSnapshot(snapshot);
    fs.writeFileSync(encFile, JSON.stringify(updatedPayload), { mode: 0o600 });

    const index = this.readIndex();
    if (index.accounts[alias]) {
      index.accounts[alias] = {
        ...index.accounts[alias],
        email: snapshot.email,
        hasOAuth: true,
        fingerprint: snapshot.fingerprint,
        updatedAt: snapshot.updatedAt,
      };
      this.writeIndex(index);
    }
  }

  saveOAuthAccount(
    alias: string,
    oauth: OAuthCredentials,
    options: { includeLiveKeychain?: boolean; emailOverride?: string } = {},
  ): AccountMeta {
    this.validateAlias(alias);
    const encFile = this.profilePath(alias);
    let existingSnapshot: AccountSnapshot | null = null;
    if (fs.existsSync(encFile)) {
      try {
        const payload = JSON.parse(fs.readFileSync(encFile, 'utf8')) as EncryptedPayload;
        existingSnapshot = this.decryptSnapshot(payload);
      } catch {
        existingSnapshot = null;
      }
    }

    const entries = options.includeLiveKeychain
      ? this.captureLiveEntries()
      : (existingSnapshot?.keychainEntries ?? []);
    if (!entries.some((e) => e.service === 'gemini' && e.account === 'antigravity')) {
      entries.push({
        service: 'gemini',
        account: 'antigravity',
        secret: encodeGoKeyringSecret(oauth),
      });
    }
    const stateFiles = options.includeLiveKeychain
      ? this.captureLiveStateFiles()
      : (existingSnapshot?.stateFiles ?? []);
    const fingerprint = this.computeFingerprint(entries, stateFiles, oauth);
    const index = this.readIndex();
    const now = new Date().toISOString();
    const existing = index.accounts[alias];
    const email = options.emailOverride ?? oauth.email ?? existing?.email ?? null;

    const snapshot: AccountSnapshot = {
      version: 1,
      alias,
      email,
      fingerprint,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      oauth,
      keychainEntries: entries,
      stateFiles,
    };

    this.ensureVaultDirs();
    const encrypted = this.encryptSnapshot(snapshot);
    fs.writeFileSync(this.profilePath(alias), JSON.stringify(encrypted), { mode: 0o600 });

    const meta: AccountMeta = {
      alias,
      email,
      hasOAuth: true,
      fingerprint,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    };
    index.accounts[alias] = meta;
    if (options.includeLiveKeychain && alias !== AUTO_BACKUP_ALIAS) {
      if (index.activeAlias && index.activeAlias !== alias) {
        index.previousAlias = index.activeAlias;
      }
      index.activeAlias = alias;
    }
    this.writeIndex(index);
    return meta;
  }

  use(target: string): { switchedTo: AccountMeta; autoBackedUp: boolean } {
    const index = this.readIndex();
    const alias = target === '-' ? index.previousAlias : target;
    if (!alias) {
      throw new Error('No previous account recorded to switch back to.');
    }
    this.validateAlias(alias);

    const encFile = this.profilePath(alias);
    if (!fs.existsSync(encFile)) {
      throw new Error(`Account "${alias}" not found. Run "agy-account ls" to see saved accounts.`);
    }

    const payload = JSON.parse(fs.readFileSync(encFile, 'utf8')) as EncryptedPayload;
    const snapshot = this.decryptSnapshot(payload);

    if (snapshot.keychainEntries.length === 0) {
      if (snapshot.oauth) {
        snapshot.keychainEntries = [
          {
            service: 'gemini',
            account: 'antigravity',
            secret: encodeGoKeyringSecret(snapshot.oauth),
          },
        ];
      } else {
        throw new MissingKeychainBindingError(alias, snapshot.email);
      }
    }

    // Safety guard: back up current live state if it differs from any saved profile.
    let autoBackedUp = false;
    const liveEntries = this.captureLiveEntries();
    const liveFiles = this.captureLiveStateFiles();
    if (liveEntries.length > 0) {
      const liveFp = this.computeFingerprint(liveEntries, liveFiles);
      const isAlreadySaved = Object.values(index.accounts).some(
        (acc) => acc.alias !== AUTO_BACKUP_ALIAS && acc.fingerprint === liveFp,
      );
      if (!isAlreadySaved) {
        this.save(AUTO_BACKUP_ALIAS);
        autoBackedUp = true;
      }
    }

    // Clear and restore Keychain entries per service:
    // - Always replace primary `gemini` entries.
    // - Only replace `antigravity.plugins` if the target snapshot actually includes plugin entries;
    //   otherwise preserve existing plugin logins (e.g. Google Drive / Docs) so they don't break.
    const snapshotHasPlugins = snapshot.keychainEntries.some(
      (e) => e.service === 'antigravity.plugins',
    );
    const servicesToReplace = snapshotHasPlugins
      ? TARGET_KEYCHAIN_SERVICES
      : ['gemini'];

    const existingMetas = this.keychain.listEntriesByServices(servicesToReplace);
    for (const meta of existingMetas) {
      this.keychain.deleteSecret(meta.service, meta.account);
    }

    for (const entry of snapshot.keychainEntries) {
      if (!snapshotHasPlugins && entry.service === 'antigravity.plugins') continue;
      this.keychain.setSecret(entry.service, entry.account, entry.secret);
    }

    // Restore state files mapped by key to current AppPaths (supports safe path migration/testing).
    const pathByKey = new Map(this.paths.stateFiles.map((s) => [s.key, s.path]));
    for (const file of snapshot.stateFiles) {
      const destPath = pathByKey.get(file.key) ?? file.targetPath;
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, Buffer.from(file.contentBase64, 'base64'), { mode: 0o600 });
    }

    const updatedIndex = this.readIndex();
    if (updatedIndex.activeAlias && updatedIndex.activeAlias !== alias) {
      updatedIndex.previousAlias = updatedIndex.activeAlias;
    }
    updatedIndex.activeAlias = alias;
    this.writeIndex(updatedIndex);

    return {
      switchedTo: updatedIndex.accounts[alias] ?? {
        alias: snapshot.alias,
        email: snapshot.email,
        fingerprint: snapshot.fingerprint,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
      },
      autoBackedUp,
    };
  }

  list(): { activeAlias: string | null; previousAlias: string | null; accounts: AccountMeta[] } {
    const index = this.readIndex();
    const accounts = Object.values(index.accounts)
      .filter((acc) => acc.alias !== AUTO_BACKUP_ALIAS)
      .sort((a, b) => a.alias.localeCompare(b.alias));
    return {
      activeAlias: index.activeAlias,
      previousAlias: index.previousAlias,
      accounts,
    };
  }

  remove(alias: string): boolean {
    this.validateAlias(alias);
    const index = this.readIndex();
    if (!index.accounts[alias]) {
      return false;
    }
    delete index.accounts[alias];
    if (index.activeAlias === alias) index.activeAlias = null;
    if (index.previousAlias === alias) index.previousAlias = null;
    this.writeIndex(index);

    const encFile = this.profilePath(alias);
    if (fs.existsSync(encFile)) {
      fs.unlinkSync(encFile);
    }
    return true;
  }

  /**
   * Back up unsaved live state if needed, then clear live target Keychain entries
   * so the user can sign into a new Google account cleanly.
   */
  clearLiveSession(): { autoBackedUp: boolean; clearedCount: number } {
    const index = this.readIndex();
    let autoBackedUp = false;
    const liveEntries = this.captureLiveEntries();
    const liveFiles = this.captureLiveStateFiles();

    if (liveEntries.length > 0) {
      const liveFp = this.computeFingerprint(liveEntries, liveFiles);
      const isAlreadySaved = Object.values(index.accounts).some(
        (acc) => acc.alias !== AUTO_BACKUP_ALIAS && acc.fingerprint === liveFp,
      );
      if (!isAlreadySaved) {
        this.save(AUTO_BACKUP_ALIAS);
        autoBackedUp = true;
      }
    }

    // Only clear primary `gemini` login so plugin accounts (Google Drive/Docs) stay intact.
    const existingMetas = this.keychain.listEntriesByServices(['gemini']);
    let clearedCount = 0;
    for (const meta of existingMetas) {
      if (this.keychain.deleteSecret(meta.service, meta.account)) {
        clearedCount++;
      }
    }

    const updatedIndex = this.readIndex();
    if (updatedIndex.activeAlias) {
      updatedIndex.previousAlias = updatedIndex.activeAlias;
    }
    updatedIndex.activeAlias = null;
    this.writeIndex(updatedIndex);

    return { autoBackedUp, clearedCount };
  }
}

const GO_KEYRING_PREFIX = 'go-keyring-base64:';

export function encodeGoKeyringSecret(oauth: OAuthCredentials): string {
  const expiresIn = Math.max(0, Math.round((oauth.expiryDate - Date.now()) / 1000));
  const payload = {
    token: {
      access_token: oauth.accessToken,
      token_type: oauth.tokenType || 'Bearer',
      refresh_token: oauth.refreshToken ?? '',
      expiry: new Date(oauth.expiryDate).toISOString(),
      expires_in: expiresIn,
    },
    auth_method: 'consumer',
    id_token_email: oauth.email ?? '',
    writer_id: crypto.randomBytes(24).toString('base64url'),
  };
  return `${GO_KEYRING_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`;
}

export function decodeGoKeyringOAuth(secret: string): OAuthCredentials | null {
  if (!secret.startsWith(GO_KEYRING_PREFIX)) return null;
  try {
    const jsonStr = Buffer.from(secret.slice(GO_KEYRING_PREFIX.length), 'base64').toString('utf8');
    const parsed = JSON.parse(jsonStr) as {
      token?: {
        access_token?: string;
        refresh_token?: string;
        token_type?: string;
        expiry?: string;
        expires_in?: number;
      };
      id_token_email?: string;
    };
    if (!parsed.token?.access_token) return null;
    const expiryDate = parsed.token.expiry
      ? Date.parse(parsed.token.expiry)
      : Date.now() + (parsed.token.expires_in ?? 3600) * 1000;
    return {
      email: typeof parsed.id_token_email === 'string' && parsed.id_token_email ? parsed.id_token_email : null,
      accessToken: parsed.token.access_token,
      refreshToken: parsed.token.refresh_token || null,
      idToken: null,
      tokenType: parsed.token.token_type ?? 'Bearer',
      scope: '',
      expiryDate: Number.isNaN(expiryDate) ? Date.now() + 3600_000 : expiryDate,
    };
  } catch {
    return null;
  }
}

export function extractOAuthFromEntries(entries: KeychainEntry[]): OAuthCredentials | null {
  for (const entry of entries) {
    const decoded = decodeGoKeyringOAuth(entry.secret.trim());
    if (decoded) return decoded;
  }
  return null;
}

export function extractEmailFromEntries(entries: KeychainEntry[]): string | null {
  for (const entry of entries) {
    const raw = entry.secret.trim();
    if (!raw) continue;

    const goOAuth = decodeGoKeyringOAuth(raw);
    if (goOAuth?.email) return goOAuth.email;

    // 1. Try JSON object (common for OAuth2 credential blobs)
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const key of ['email', 'user_email', 'account_email', 'id_token_email']) {
        if (typeof parsed[key] === 'string' && parsed[key].includes('@')) {
          return parsed[key];
        }
      }
      if (typeof parsed.id_token === 'string') {
        const jwtEmail = extractEmailFromJwt(parsed.id_token);
        if (jwtEmail) return jwtEmail;
      }
    } catch {
      // Not plain JSON, try fallback patterns.
    }

    // 2. Fallback regex for embedded email strings
    const match = raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (match) {
      return match[0];
    }
  }
  return null;
}

function extractEmailFromJwt(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}
