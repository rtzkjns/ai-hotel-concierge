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

import { lookup as dnsLookup } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
// Берём и Agent, и fetch из одного пакета: встроенный в Node fetch не принимает
// dispatcher чужой версии undici («invalid onRequestStart method»).
import { Agent, fetch as undiciFetch } from 'undici';

export const FETCH_TIMEOUT_MS = 12_000;
export const MAX_BYTES = 512 * 1024;
/** Roughly two A4 pages — enough for a promo or a menu, small enough to carry every turn. */
export const MAX_TEXT_CHARS = 6_000;
const MAX_REDIRECTS = 3;

export interface FetchedSource {
  ok: boolean;
  text?: string;
  /** Ссылка вела на PDF: байты, которые прочитает модель. */
  pdf?: Buffer;
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
  if (v === 4) return isPrivateV4(ip);
  if (v !== 6) return true; // не адрес — отказываем
  const words = expandV6(ip);
  if (!words) return true;

  // IPv4-mapped и 6to4 несут внутри адрес IPv4 — проверяем именно его.
  // Разбор обязан работать и с шестнадцатеричной записью: браузерный парсер
  // превращает [::ffff:127.0.0.1] в [::ffff:7f00:1], и точечной формы здесь уже нет.
  const isMapped = words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff;
  if (isMapped) return isPrivateV4(v4FromWords(words[6], words[7]));
  if (words[0] === 0x2002) return isPrivateV4(v4FromWords(words[1], words[2])); // 6to4
  if (words[0] === 0x0064 && words[1] === 0xff9b) {
    return isPrivateV4(v4FromWords(words[6], words[7])); // NAT64
  }

  const allZero = words.every((w) => w === 0);
  if (allZero) return true; // ::
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true; // ::1
  const first = words[0];
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (устаревший)
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 и 192.0.2.0/24
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function v4FromWords(hi: number, lo: number): string {
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
}

/** «::ffff:7f00:1» → восемь 16-битных слов; null, если запись непонятна. */
export function expandV6(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  // Хвост в точечной форме (::ffff:127.0.0.1) переводим в слова.
  const dotted = /^(.*:)((\d+)\.(\d+)\.(\d+)\.(\d+))$/.exec(text);
  if (dotted) {
    const octets = [dotted[3], dotted[4], dotted[5], dotted[6]].map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${dotted[1]}${hi}:${lo}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
  } else if (fill < 0) return null;
  const words = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail].map((w) =>
    parseInt(w || '0', 16),
  );
  if (words.length !== 8 || words.some((w) => Number.isNaN(w) || w < 0 || w > 0xffff)) return null;
  return words;
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
    .replace(/&#(\d+);/g, (m, n: string) => codePoint(Number(n), m))
    .replace(/&#x([0-9a-f]+);/gi, (m, n: string) => codePoint(parseInt(n, 16), m))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
  return dedupe(flat).slice(0, MAX_TEXT_CHARS).trim();
}

/** Одна битая сущность на странице не должна навсегда выключать источник. */
function codePoint(code: number, original: string): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return original;
  if (code >= 0xd800 && code <= 0xdfff) return original; // суррогаты
  return String.fromCodePoint(code);
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
 * Проверка адреса в МОМЕНТ соединения, а не только до него.
 *
 * Проверить имя заранее недостаточно: между проверкой и запросом DNS может ответить
 * иначе и увести соединение на внутренний адрес (DNS rebinding). Здесь подменяется
 * резолвер самого соединения, поэтому решение принимается по тому адресу, на который
 * реально идёт подключение.
 */
export const guardedAgent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dnsLookup(hostname, options as never, (err, address, family) => {
        if (err) return callback(err, address as never, family as never);
        const list = Array.isArray(address) ? address : [{ address, family }];
        const bad = list.find((a) => isPrivateAddress(a.address));
        if (bad) {
          return callback(
            new Error(`SSRF_BLOCKED:${bad.address}`),
            undefined as never,
            undefined as never,
          );
        }
        return callback(null, address as never, family as never);
      });
    },
  },
});

/**
 * Fetches one source page. Never throws: hotel staff get a sentence they can act on,
 * and a source that is down must not take the scheduler with it.
 */
export async function fetchSource(
  rawUrl: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<FetchedSource> {
  const doFetch = deps.fetchImpl ?? (undiciFetch as unknown as typeof fetch);
  let target: URL;
  try {
    target = await assertPublicUrl(rawUrl);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ссылка не подошла' };
  }

  // Бюджет на ВСЮ вычитку: таймер на каждый переход давал до 48 секунд ожидания,
  // и всё это время владелец смотрел на замерший экран.
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const left = deadline - Date.now();
    if (left <= 0) return { ok: false, error: 'Сайт не ответил за 12 секунд' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), left);
    try {
      const res = await doFetch(target.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        // Собственный резолвер: адрес перепроверяется при подключении.
        ...(deps.fetchImpl ? {} : { dispatcher: guardedAgent }),
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

      // Требуем ЯВНЫЙ текстовый тип: пустой заголовок раньше проходил как HTML,
      // а его не ставят как раз самописные внутренние сервисы.
      const type = res.headers.get('content-type') ?? '';
      // PDF по ссылке — обычное дело у отелей (меню, прайс). Отдаём байты наверх,
      // там их прочитает модель, как и загруженный вручную файл.
      if (/application\/pdf/i.test(type)) {
        const bytes = await readCappedBytes(res);
        return { ok: true, pdf: bytes };
      }
      if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) {
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
      const blocked = err instanceof Error && /SSRF_BLOCKED/.test(String(err.cause ?? err.message));
      return {
        ok: false,
        error: blocked
          ? 'Эта ссылка ведёт во внутреннюю сеть'
          : aborted
            ? 'Сайт не ответил за 12 секунд'
            : 'Не удалось открыть страницу',
      };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: 'Слишком много переадресаций' };
}

/** Reads at most MAX_BYTES so a huge page cannot exhaust memory. */
async function readCapped(res: Response): Promise<string> {
  return new TextDecoder('utf-8').decode(await readCappedBytes(res));
}

async function readCappedBytes(res: Response): Promise<Buffer> {
  const body = res.body;
  if (!body) return Buffer.from(await res.arrayBuffer());
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
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}
