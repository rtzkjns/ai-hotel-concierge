/**
 * Reading the sources a hotel drops into the admin panel.
 *
 * The owner pastes a link — a new promo page, an updated restaurant menu — and expects
 * the bot to know what is on it. The bot cannot browse, so something has to read the page
 * and put the text where the prompt can reach it. That is this module: fetch on a schedule,
 * reduce the page to plain text, hand it back for storage.
 *
 * Two constraints shape everything here:
 *
 *  - The URL is attacker-controlled in the security sense. Anyone with panel access can
 *    make this server issue a request, so a link to 169.254.169.254 or to an internal
 *    address must never be followed. Redirects are walked one hop at a time and every hop
 *    is re-checked, because a public host can redirect into a private one.
 *  - The result lands in a system prompt sent on every guest message. An unbounded page
 *    would make every reply slower and more expensive, so the text is capped hard.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const FETCH_TIMEOUT_MS = 12_000;
export const MAX_BYTES = 512 * 1024;
/** Roughly two A4 pages — enough for a promo or a menu, small enough to carry every turn. */
export const MAX_TEXT_CHARS = 6_000;
const MAX_REDIRECTS = 3;

export interface FetchedSource {
  ok: boolean;
  text?: string;
  /** Human-facing, shown to hotel staff in the panel — never a stack trace. */
  error?: string;
}

/**
 * Private, loopback, link-local and carrier-grade-NAT ranges. A page on any of these is
 * part of our own infrastructure, not hotel content, and fetching it on demand would turn
 * the panel into a probe for the internal network.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd')) return true;
    // IPv4-mapped (::ffff:10.0.0.1) carries a v4 address inside.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  if (v !== 4) return true; // not an address we can reason about → refuse
  const [a, b] = ip.split('.').map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/** Rejects anything that is not a public http(s) URL. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Ссылка не похожа на адрес страницы');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Поддерживаются только ссылки http и https');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('Эта ссылка ведёт во внутреннюю сеть');
    return url;
  }
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) {
    throw new Error('Эта ссылка ведёт во внутреннюю сеть');
  }
  const resolved = await lookup(host, { all: true }).catch(() => {
    throw new Error('Сайт не отвечает — проверьте адрес');
  });
  if (!resolved.length || resolved.some((r) => isPrivateAddress(r.address))) {
    throw new Error('Эта ссылка ведёт во внутреннюю сеть');
  }
  return url;
}

const BLOCK_TAGS = /<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;
/**
 * Navigation, header and footer are the single most dangerous thing to feed the bot from
 * a hotel site: on Kazzhol Seven's own page the menu links to ANOTHER hotel's restaurant
 * and fitness centre. Swallowed as "facts", that becomes a promise the hotel cannot keep.
 */
const CHROME_TAGS = /<(nav|header|footer|aside|form|select|button)\b[^>]*>[\s\S]*?<\/\1>/gi;
const CHROME_ATTR = /<(div|section|ul)\b[^>]*(class|id)="[^"]*(menu|nav|header|footer|breadcrumb|cookie|sidebar)[^"]*"[^>]*>[\s\S]*?<\/\1>/gi;
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»',
  mdash: '—', ndash: '–', hellip: '…', deg: '°', tenge: '₸',
};

/**
 * HTML → readable text. Deliberately a reducer, not a parser: the goal is the words a
 * guest would read, and every tag we keep is a token the model pays for.
 */
export function htmlToText(html: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const flat = body
    .replace(BLOCK_TAGS, ' ')
    .replace(CHROME_TAGS, ' ')
    .replace(CHROME_ATTR, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Block-level tags become line breaks so lists and prices do not run together.
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
  return dedupe(flat).slice(0, MAX_TEXT_CHARS).trim();
}

/**
 * Keeps the lines a guest would actually read. Menus survive as one-word lines repeated
 * in desktop and mobile markup, and on a hotel site those words are other hotels' venues —
 * exactly the kind of thing that must not reach the bot as fact.
 */
function dedupe(raw: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of raw.split('\n')) {
    const text = line.replace(/[ \t\u00a0]+/g, ' ').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(text);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Fetches one source page. Never throws: hotel staff get a sentence they can act on,
 * and a source that is down must not take the scheduler with it.
 */
export async function fetchSource(
  rawUrl: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<FetchedSource> {
  const doFetch = deps.fetchImpl ?? fetch;
  let target: URL;
  try {
    target = await assertPublicUrl(rawUrl);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ссылка не подошла' };
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await doFetch(target.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          // Some hotel CMSes serve a different (or empty) page to unknown agents.
          'User-Agent': 'KazzholBot/1.0 (+hotel knowledge sync)',
          Accept: 'text/html,text/plain;q=0.9',
          'Accept-Language': 'ru,kk;q=0.9,en;q=0.8',
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) return { ok: false, error: 'Страница переадресует в никуда' };
        // Re-check every hop: a public host is allowed to redirect into a private one.
        try {
          target = await assertPublicUrl(new URL(location, target).toString());
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : 'Переадресация не подошла' };
        }
        continue;
      }

      if (res.status === 404) return { ok: false, error: 'Страница не найдена (404)' };
      if (res.status === 403 || res.status === 401) {
        return { ok: false, error: 'Сайт закрыл доступ к странице' };
      }
      if (!res.ok) return { ok: false, error: `Сайт ответил ошибкой ${res.status}` };

      const type = res.headers.get('content-type') ?? '';
      if (type && !/text\/html|text\/plain|application\/xhtml/i.test(type)) {
        return { ok: false, error: 'По ссылке не страница с текстом (например, файл или картинка)' };
      }

      const raw = await readCapped(res);
      const text = type.includes('text/plain') ? raw.slice(0, MAX_TEXT_CHARS).trim() : htmlToText(raw);
      if (text.length < 40) {
        // Almost always a JS-rendered page: the HTML arrived, the words did not.
        return { ok: false, error: 'На странице не нашлось текста — возможно, он подгружается скриптом' };
      }
      return { ok: true, text };
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      return {
        ok: false,
        error: aborted ? 'Сайт не ответил за 12 секунд' : 'Не удалось открыть страницу',
      };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: 'Слишком много переадресаций' };
}

/** Reads at most MAX_BYTES so a huge page cannot exhaust memory. */
async function readCapped(res: Response): Promise<string> {
  const body = res.body;
  if (!body) return await res.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    chunks.push(value);
    if (total >= MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}
