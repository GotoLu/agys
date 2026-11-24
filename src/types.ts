export interface KeychainEntryMeta {
  service: string;
  account: string;
}

export interface KeychainEntry extends KeychainEntryMeta {
  secret: string;
}

export interface StateFileSnapshot {
  key: string;
  targetPath: string;
  contentBase64: string;
}

export interface OAuthCredentials {
  email: string | null;
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  tokenType: string;
  scope: string;
  expiryDate: number;
}

export interface AccountSnapshot {
  version: 1;
  alias: string;
  email: string | null;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  oauth?: OAuthCredentials;
  keychainEntries: KeychainEntry[];
  stateFiles: StateFileSnapshot[];
}

export interface AccountMeta {
  alias: string;
  email: string | null;
  hasOAuth?: boolean;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
}

export interface VaultIndex {
  version: 1;
  activeAlias: string | null;
  previousAlias: string | null;
  accounts: Record<string, AccountMeta>;
}

export interface EncryptedPayload {
  version: 1;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface KeychainAdapter {
  listEntriesByServices(services: string[]): KeychainEntryMeta[];
  getSecret(service: string, account: string): string | null;
  setSecret(service: string, account: string, secret: string): void;
  deleteSecret(service: string, account: string): boolean;
}
