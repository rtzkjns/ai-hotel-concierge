// Instagram token + subscription helper — "Instagram API with Instagram Login" path.
// Automates the fiddly, easy-to-forget setup steps (see docs/INSTAGRAM-GOLIVE.md):
//   exchange-code <CODE> <REDIRECT_URI>  authorization code → short-lived token (+ user_id)
//   long-lived    <SHORT_TOKEN>          short-lived → 60-day long-lived token
//   refresh       <LONG_TOKEN>           extend a long-lived token by another 60 days
//   subscribe     <IG_ID> <TOKEN>        POST /<IG_ID>/subscribed_apps (fields=messages) — REQUIRED
//                                         per account, or webhooks never arrive.
//
// App creds from env: INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET
// (falls back to WHATSAPP_APP_ID / WHATSAPP_APP_SECRET when one Meta app hosts both).
// Never prints secrets; prints the resulting token so you can paste it into .env.
import 'dotenv/config';

const API_BASE = process.env.INSTAGRAM_API_BASE ?? 'https://graph.instagram.com/v26.0';
const GRAPH_IG = 'https://graph.instagram.com'; // token endpoints are unversioned
const OAUTH = 'https://api.instagram.com/oauth/access_token';

const APP_ID = process.env.INSTAGRAM_APP_ID ?? process.env.WHATSAPP_APP_ID;
const APP_SECRET = process.env.INSTAGRAM_APP_SECRET ?? process.env.WHATSAPP_APP_SECRET;

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function asJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) die(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function exchangeCode(code: string, redirectUri: string): Promise<void> {
  if (!APP_ID || !APP_SECRET) die('set INSTAGRAM_APP_ID + INSTAGRAM_APP_SECRET (or WHATSAPP_*)');
  const body = new URLSearchParams({
    client_id: APP_ID,
    client_secret: APP_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code,
  });
  const j = await asJson(
    await fetch(OAUTH, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }),
  );
  console.log('short-lived token:', String(j.access_token));
  console.log('user_id (IG account id):', String(j.user_id ?? '(see full response)'));
  console.log('→ next: `long-lived <that token>`');
}

async function longLived(shortToken: string): Promise<void> {
  if (!APP_SECRET) die('set INSTAGRAM_APP_SECRET (or WHATSAPP_APP_SECRET)');
  const url =
    `${GRAPH_IG}/access_token?grant_type=ig_exchange_token` +
    `&client_secret=${encodeURIComponent(APP_SECRET)}&access_token=${encodeURIComponent(shortToken)}`;
  const j = await asJson(await fetch(url));
  console.log('long-lived token (~60 days):', String(j.access_token));
  console.log('expires_in (sec):', String(j.expires_in));
  console.log('→ put in .env as INSTAGRAM_ACCESS_TOKEN; schedule `refresh` every ~30-45 days.');
}

async function refresh(longToken: string): Promise<void> {
  const url =
    `${GRAPH_IG}/refresh_access_token?grant_type=ig_refresh_token` +
    `&access_token=${encodeURIComponent(longToken)}`;
  const j = await asJson(await fetch(url));
  console.log('refreshed token (~60 days):', String(j.access_token));
  console.log('expires_in (sec):', String(j.expires_in));
}

async function subscribe(igId: string, token: string): Promise<void> {
  const url = `${API_BASE}/${encodeURIComponent(igId)}/subscribed_apps`;
  const body = new URLSearchParams({ subscribed_fields: 'messages', access_token: token });
  const j = await asJson(
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }),
  );
  console.log('subscribed_apps:', JSON.stringify(j));
  console.log(
    j.success === true
      ? '✓ account subscribed to `messages` — webhooks will now arrive.'
      : '⚠ no success flag — check the response above.',
  );
}

const [cmd, a, b] = process.argv.slice(2);

async function run(): Promise<void> {
  switch (cmd) {
    case 'exchange-code':
      if (!a || !b) die('usage: exchange-code <CODE> <REDIRECT_URI>');
      return exchangeCode(a, b);
    case 'long-lived':
      if (!a) die('usage: long-lived <SHORT_TOKEN>');
      return longLived(a);
    case 'refresh':
      if (!a) die('usage: refresh <LONG_TOKEN>');
      return refresh(a);
    case 'subscribe':
      if (!a || !b) die('usage: subscribe <IG_ID> <TOKEN>');
      return subscribe(a, b);
    default:
      console.log('Instagram connect helper (see docs/INSTAGRAM-GOLIVE.md):');
      console.log('  exchange-code <CODE> <REDIRECT_URI>   authz code → short-lived token + user_id');
      console.log('  long-lived    <SHORT_TOKEN>           short → 60-day long-lived token');
      console.log('  refresh       <LONG_TOKEN>            extend a long-lived token 60 more days');
      console.log('  subscribe     <IG_ID> <TOKEN>         subscribe the account to `messages` (REQUIRED)');
      process.exit(cmd ? 1 : 0);
  }
}

run().catch((e) => die(e instanceof Error ? e.message : String(e)));
