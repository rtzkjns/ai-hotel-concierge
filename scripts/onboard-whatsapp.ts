#!/usr/bin/env node
/**
 * onboard-whatsapp.ts — the "360dialog-replacement" onboarding tool.
 *
 * Replicates, against Meta's PUBLIC Graph API, exactly what a BSP's backend
 * (e.g. 360dialog) does AFTER the hosted Embedded Signup step — so we onboard our
 * OWN WhatsApp number to the Cloud API via Coexistence without paying a BSP
 * (€0/mo instead of €49/mo). Full reverse-engineering: docs/REVERSE-360DIALOG.md.
 *
 * PREREQUISITE (the one real gate): our Meta app must be an APPROVED Tech Provider
 * — Business Verification + App Review Advanced Access on `whatsapp_business_management`
 * and `whatsapp_business_messaging`. This script DETECTS whether that gate is passed
 * (Step 2, granular_scopes) and stops early with a clear message if it is not, so we
 * never chase a silent "No WABA scope found in token" failure at pairing time.
 *
 * INPUT comes from the Embedded Signup page (scripts/onboard-whatsapp.html):
 *   --code <CODE>   the OAuth code the ES popup returned
 *   --waba <WABA>   the WABA id the ES 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' event reported
 *
 * ENV:
 *   WHATSAPP_APP_ID, WHATSAPP_APP_SECRET  (required — our Meta app)
 *   PUBLIC_BASE_URL                       (optional — printed as the webhook to set)
 *   GRAPH_VERSION                         (optional — defaults to v23.0)
 *
 * Usage:
 *   WHATSAPP_APP_ID=... WHATSAPP_APP_SECRET=... \
 *     npx tsx scripts/onboard-whatsapp.ts --code <CODE> --waba <WABA_ID>
 *
 * COEXISTENCE: this deliberately SKIPS `POST /{phone}/register`. The number is
 * already registered by the QR pairing; calling register would disrupt the live
 * WhatsApp Business App. We only subscribe our webhook and trigger the SMB sync.
 */

const GRAPH = `https://graph.facebook.com/${process.env.GRAPH_VERSION ?? 'v23.0'}`;

interface GraphError {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
}

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** One Graph call. Throws a readable error on non-2xx (never leaks the token). */
async function graph(
  path: string,
  opts: { method?: 'GET' | 'POST'; token?: string; query?: Record<string, string>; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  const url = new URL(`${GRAPH}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & GraphError;
  if (!res.ok) {
    const e = json.error;
    throw new Error(
      `Graph ${opts.method ?? 'GET'} ${path} → HTTP ${res.status}` +
        (e?.message ? `: ${e.message} (code ${e.code ?? '?'}/${e.error_subcode ?? '?'})` : ''),
    );
  }
  return json;
}

async function main(): Promise<void> {
  const appId = process.env.WHATSAPP_APP_ID;
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  const code = arg('code');
  const wabaId = arg('waba');

  if (!appId || !appSecret) fail('Set WHATSAPP_APP_ID and WHATSAPP_APP_SECRET (our Meta app).');
  if (!code) fail('Missing --code (the OAuth code from the Embedded Signup page).');
  if (!wabaId) fail('Missing --waba (the WABA id from the Embedded Signup FINISH event).');

  console.log(`\n=== WhatsApp self-onboarding (Coexistence, no BSP) — ${GRAPH} ===`);

  // Step 1 — exchange the ES code for an access token.
  console.log('\n[1/6] Exchanging OAuth code for a token…');
  const tokenRes = await graph('/oauth/access_token', {
    query: { client_id: appId, client_secret: appSecret, code },
  });
  const token = tokenRes.access_token;
  if (typeof token !== 'string') fail('No access_token in the exchange response.');
  console.log('      ✓ token acquired');

  // Step 2 — THE GATE. debug_token must show both WhatsApp granular scopes.
  // If Meta stripped them, the app is not an approved Tech Provider yet and the
  // Coexistence pairing will silently fail — stop here with a clear message.
  console.log('\n[2/6] Checking Tech-Provider gate (granular_scopes)…');
  const dbg = (await graph('/debug_token', {
    query: { input_token: token as string, access_token: `${appId}|${appSecret}` },
  })) as { data?: { granular_scopes?: Array<{ scope?: string }>; scopes?: string[] } };
  const granular = dbg.data?.granular_scopes?.map((g) => g.scope) ?? [];
  const flat = dbg.data?.scopes ?? [];
  const scopes = new Set([...granular, ...flat].filter((s): s is string => typeof s === 'string'));
  const need = ['whatsapp_business_management', 'whatsapp_business_messaging'];
  const missing = need.filter((s) => !scopes.has(s));
  if (missing.length > 0) {
    fail(
      `GATE NOT PASSED — token is missing: ${missing.join(', ')}.\n` +
        `  Meta strips these until the app is an APPROVED Tech Provider.\n` +
        `  → Complete Business Verification + App Review (Advanced Access on both\n` +
        `    whatsapp_business_* permissions), then re-run. Until then, use the\n` +
        `    360dialog fallback (WHATSAPP_PROVIDER=d360). See docs/REVERSE-360DIALOG.md.`,
    );
  }
  console.log(`      ✓ gate passed — scopes present: ${need.join(', ')}`);

  // Step 3 — discover the phone number on this WABA.
  console.log('\n[3/6] Discovering phone number…');
  const phones = (await graph(`/${wabaId}/phone_numbers`, { token: token as string })) as {
    data?: Array<{ id?: string; display_phone_number?: string; verified_name?: string }>;
  };
  const phone = phones.data?.[0];
  if (!phone?.id) fail('No phone number found on this WABA.');
  console.log(
    `      ✓ ${phone.display_phone_number ?? '(number)'} — ${phone.verified_name ?? ''} (phone_number_id ${phone.id})`,
  );

  // Step 4 — Coexistence: DO NOT call POST /{phone}/register. The QR pairing
  // already registered the number; register would disrupt the live Business App.
  console.log('\n[4/6] Skipping /register (Coexistence — number already registered) ✓');

  // Step 5 — subscribe OUR app (our webhook) to the WABA.
  console.log('\n[5/6] Subscribing our app/webhook to the WABA…');
  await graph(`/${wabaId}/subscribed_apps`, { method: 'POST', token: token as string });
  console.log('      ✓ subscribed');

  // Step 6 — trigger the SMB state + history sync (contacts, and up to 6mo history).
  console.log('\n[6/6] Triggering SMB app state + history sync…');
  for (const sync_type of ['smb_app_state_sync', 'history'] as const) {
    try {
      await graph(`/${phone.id}/smb_app_data`, {
        method: 'POST',
        token: token as string,
        body: { messaging_product: 'whatsapp', sync_type },
      });
      console.log(`      ✓ ${sync_type} requested`);
    } catch (err) {
      console.log(`      ⚠ ${sync_type} not available (${err instanceof Error ? err.message : 'error'})`);
    }
  }

  // Done — print the exact .env to flip the bot onto Meta-direct (BSP removed).
  console.log('\n=== DONE — Coexistence onboarding complete. €0/mo, no BSP. ===');
  console.log('\nPut these in .env (replace ALMATY with the right hotel key):');
  console.log('  WHATSAPP_PROVIDER=meta');
  console.log(`  WHATSAPP_PHONE_ID_ALMATY=${phone.id}`);
  console.log('  WHATSAPP_ACCESS_TOKEN=<create a permanent System User token — see the doc>');
  if (process.env.PUBLIC_BASE_URL) {
    console.log(`\nWebhook (set in App Dashboard → WhatsApp → Configuration):`);
    console.log(`  ${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/webhooks/whatsapp`);
    console.log('  Subscribe fields: messages, smb_message_echoes, smb_app_state_sync, history, account_update');
  }
  console.log(
    '\nNOTE: the ES token above is short-lived. For production, create a System User\n' +
      'permanent token (Business Settings → System Users) and use THAT as WHATSAPP_ACCESS_TOKEN.\n',
  );
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
