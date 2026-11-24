import os from 'node:os';
import path from 'node:path';

export interface AppPaths {
  homeDir: string;
  vaultDir: string;
  profilesDir: string;
  indexFile: string;
  stateFiles: Array<{ key: string; path: string }>;
}

export function resolveAppPaths(homeDir = os.homedir(), vaultDirOverride?: string): AppPaths {
  const vaultDir = vaultDirOverride ?? path.join(homeDir, '.config', 'agy-account');
  return {
    homeDir,
    vaultDir,
    profilesDir: path.join(vaultDir, 'profiles'),
    indexFile: path.join(vaultDir, 'index.json'),
    stateFiles: [
      {
        key: 'desktop-user-scope',
        path: path.join(homeDir, 'Library', 'Application Support', 'Antigravity', 'credential-user-scope'),
      },
      {
        key: 'desktop-state',
        path: path.join(homeDir, '.gemini', 'antigravity', 'antigravity_state.pbtxt'),
      },
      {
        key: 'cli-state',
        path: path.join(homeDir, '.gemini', 'antigravity-cli', 'jetski_state.pbtxt'),
      },
    ],
  };
}
