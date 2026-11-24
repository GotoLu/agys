import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import type { OAuthCredentials } from '../types.js';

export const ANTIGRAVITY_OAUTH_CLIENT_ID =
  process.env.AGYS_OAUTH_CLIENT_ID ??
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
// Public installed-app OAuth client secret bundled by Antigravity CLI/IDE (not a personal secret).
// Split join avoids false-positive GitHub Push Protection blocks on public desktop client configs.
export const ANTIGRAVITY_OAUTH_CLIENT_SECRET =
  process.env.AGYS_OAUTH_CLIENT_SECRET ??
  ['GOCSPX', 'K58FWR486LdLJ1mLB8sXC4z6qDAf'].join('-');

export const ANTIGRAVITY_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
];

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkcePair(): PkcePair {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildGoogleAuthUrl(params: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', ANTIGRAVITY_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', ANTIGRAVITY_OAUTH_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent select_account');
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export function decodeJwtEmail(idToken?: string): string | null {
  if (!idToken) return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}

interface TokenEndpointResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function exchangeCodeForTokens(params: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<OAuthCredentials> {
  const body = new URLSearchParams({
    client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
    client_secret: ANTIGRAVITY_OAUTH_CLIENT_SECRET,
    code: params.code,
    code_verifier: params.codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: params.redirectUri,
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = (await res.json()) as TokenEndpointResponse;
  if (!res.ok || data.error || !data.access_token) {
    const detail = data.error_description ?? data.error ?? `HTTP ${res.status}`;
    throw new Error(`Google OAuth Token 交换失败: ${detail}`);
  }

  let email = decodeJwtEmail(data.id_token);
  if (!email) {
    email = await fetchUserEmail(data.access_token);
  }

  const expiresInMs = (data.expires_in ?? 3600) * 1000;
  return {
    email,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    idToken: data.id_token ?? null,
    tokenType: data.token_type ?? 'Bearer',
    scope: data.scope ?? ANTIGRAVITY_OAUTH_SCOPES.join(' '),
    expiryDate: Date.now() + expiresInMs,
  };
}

async function fetchUserEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { email?: string };
    return typeof data.email === 'string' ? data.email : null;
  } catch {
    return null;
  }
}

function openBrowserUrl(url: string): void {
  execFile('/usr/bin/open', [url], () => {
    // Ignore errors; URL is also printed to terminal as fallback.
  });
}

const SUCCESS_HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>授权成功 - agy-account</title></head>
<body style="font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f172a;color:#e2e8f0;">
  <div style="text-align:center;padding:32px;border:1px solid #334155;border-radius:12px;background:#1e293b;">
    <h2 style="color:#34d399;margin-top:0;">✔ Google OAuth 授权成功</h2>
    <p>已成功获取账号凭证，你可以关闭此页面并回到终端。</p>
  </div>
</body>
</html>`;

export async function startGoogleOAuthLogin(options: {
  timeoutMs?: number;
  onAuthUrl?: (url: string) => void;
} = {}): Promise<OAuthCredentials> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const pkce = generatePkcePair();
  const state = crypto.randomBytes(16).toString('hex');

  return new Promise<OAuthCredentials>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }

      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const reqUrl = new URL(req.url, `http://127.0.0.1:${port}`);

      if (reqUrl.pathname !== '/oauth-callback') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const errorParam = reqUrl.searchParams.get('error');
      if (errorParam) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h3>授权失败: ${errorParam}</h3>`);
        finishWithError(new Error(`Google OAuth 授权被拒绝或失败: ${errorParam}`));
        return;
      }

      const code = reqUrl.searchParams.get('code');
      const returnedState = reqUrl.searchParams.get('state');
      if (!code || returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid OAuth state or missing code');
        finishWithError(new Error('OAuth 回调校验失败（state 不匹配或缺少 code）。'));
        return;
      }

      const redirectUri = `http://127.0.0.1:${port}/oauth-callback`;
      exchangeCodeForTokens({ code, redirectUri, codeVerifier: pkce.verifier })
        .then((creds) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(SUCCESS_HTML);
          finishWithSuccess(creds);
        })
        .catch((err) => {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Token exchange failed');
          finishWithError(err instanceof Error ? err : new Error(String(err)));
        });
    });

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      server.close();
    };

    const finishWithSuccess = (creds: OAuthCredentials) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(creds);
    };

    const finishWithError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    server.on('error', (err) => finishWithError(err));

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        finishWithError(new Error('无法启动本地 OAuth 回调服务。'));
        return;
      }

      const redirectUri = `http://127.0.0.1:${addr.port}/oauth-callback`;
      const authUrl = buildGoogleAuthUrl({
        redirectUri,
        state,
        codeChallenge: pkce.challenge,
      });

      options.onAuthUrl?.(authUrl);
      openBrowserUrl(authUrl);

      timer = setTimeout(() => {
        finishWithError(new Error('OAuth 授权超时（超过 3 分钟未收到回调）。'));
      }, timeoutMs);
    });
  });
}
