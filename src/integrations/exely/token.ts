// src/integrations/exely/token.ts
export interface ExelyTokenConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
}

interface TokenDeps {
  fetchFn?: typeof fetch;
  now?: () => number;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

// Refetch this many ms before the real expiry, to avoid using a token mid-flight as it dies.
const EXPIRY_SKEW_MS = 60_000;

export class ExelyTokenManager {
  private cached: CachedToken | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly cfg: ExelyTokenConfig, deps: TokenDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.now = deps.now ?? (() => Date.now());
  }

  async getToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAtMs - EXPIRY_SKEW_MS) {
      return this.cached.token;
    }
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    });
    const res = await this.fetchFn(this.cfg.authUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new Error(`Exely auth failed: ${res.status}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new Error('Exely auth failed: no access_token in response');
    }
    const ttlMs = (json.expires_in ?? 900) * 1000;
    this.cached = { token: json.access_token, expiresAtMs: this.now() + ttlMs };
    return this.cached.token;
  }
}
