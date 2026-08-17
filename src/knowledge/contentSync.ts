// Keep the bot's hotel knowledge always fresh from Exely's Content API (the system of record).
// contentToKnowledge() turns the live catalog into the same sectioned knowledge text the static
// base uses; ExelyContentSync pulls every cabinet, caches per hotel, and never throws — a failed
// pull keeps the last good copy (and the engine falls back to the static string if nothing synced).
//
// SAFETY: the synced text is semi-trusted (hotel-managed via Exely) and is injected into the
// SYSTEM prompt. EVERY field routed into the prompt goes through clean(): HTML/entities stripped,
// ALL whitespace (incl. newlines) collapsed to single spaces — so no field can break out into its
// own directive line — price/currency tokens redacted, and length-bounded. Prices are quoted ONLY
// from check_availability; no number+currency amount from the catalog ever reaches the prompt.

/** Minimal shape of the Exely Content API response we read (extra fields ignored). */
export interface ExelyContent {
  name?: string;
  description?: string;
  stars?: number;
  contactInfo?: {
    address?: { addressLine?: string; cityName?: string };
    phones?: Array<{ phoneNumber?: string }>;
    emails?: string[];
  };
  policy?: { checkInTime?: string; checkOutTime?: string };
  roomTypes?: Array<{
    name?: string;
    description?: string;
    size?: { value?: number; unit?: string };
    occupancy?: { adultBed?: number; extraBed?: number; childWithoutBed?: number };
  }>;
  services?: Array<{ name?: string; status?: string }>;
  amenities?: Array<{ displayName?: string; chargeType?: string }>;
}

const MAX_ROOM_DESC = 200;
const MAX_PROP_DESC = 360;
const MAX_NAME = 90;
const MAX_FIELD = 120;
const MAX_ROOMS = 14;

/** Strip HTML tags, decode the entities Exely emits, and collapse ALL whitespace (incl. newlines). */
function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:laquo|raquo|ldquo|rdquo);/g, '"')
    .replace(/&(?:lsquo|rsquo|apos);/g, "'")
    .replace(/&(?:ndash|mdash);/g, '-')
    .replace(/&hellip;/g, '…')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x[0-9a-fA-F]+;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/&[a-zA-Z]+;/g, ' ') // any remaining named entity → space
    .replace(/\s+/g, ' ')
    .trim();
}

// Anything that looks like a nightly price/currency amount, in EITHER order (number-then-currency
// "9900 ₸" and currency-then-number "KZT 9900 / $50 / €100"). The bot quotes prices ONLY from
// check_availability, so no such token from the catalog may reach the prompt. A bare number with no
// currency ("от 15000") is left alone on purpose — it is indistinguishable from a size/year/count.
const CURRENCY = '(?:₸|тг\\.?|тенге|тнг|tenge|tg\\.?|kzt|₽|руб\\.?|rub|\\$|usd|eur|€)';
const PRICE_NUM_CUR = new RegExp(`\\d[\\d\\s.,]*\\s*${CURRENCY}`, 'gi');
const PRICE_CUR_NUM = new RegExp(`${CURRENCY}\\s*\\d[\\d\\s.,]*`, 'gi');
function redactPrices(s: string): string {
  return s
    .replace(PRICE_NUM_CUR, '')
    .replace(PRICE_CUR_NUM, '')
    .replace(/\(\s*(?:от|from)?\s*\)/gi, '') // tidy an emptied "(от …)" wrapper
    .replace(/\s+/g, ' ')
    .trim();
}

/** Clean + bound ANY Exely field before it enters the system prompt. */
function clean(input: string | undefined, max: number): string {
  const s = redactPrices(stripHtml(input ?? ''));
  return s.length > max ? s.slice(0, max).replace(/\s+\S*$/, '') + '…' : s;
}

function sizeText(size?: { value?: number; unit?: string }): string {
  if (!size || typeof size.value !== 'number') return '';
  return `${size.value} м²`;
}

function occText(occ?: { adultBed?: number; extraBed?: number; childWithoutBed?: number }): string {
  if (!occ) return '';
  const parts: string[] = [];
  const adults = occ.adultBed ?? 0;
  if (adults > 0) parts.push(`${adults} ${adults === 1 ? 'adult' : 'adults'}`);
  const extra = occ.extraBed ?? 0;
  if (extra > 0) parts.push(`${extra} extra bed${extra > 1 ? 's' : ''}`);
  const kids = occ.childWithoutBed ?? 0;
  if (kids > 0) parts.push(`${kids} ${kids === 1 ? 'child' : 'children'} without a bed`);
  return parts.length ? `up to ${parts.join(' + ')}` : '';
}

/** Turn a live Content API response into the bot's sectioned knowledge text. */
export function contentToKnowledge(c: ExelyContent, syncedAt?: string): string {
  const name = clean(c.name, MAX_NAME) || 'Hotel Kazzhol';
  const stars = typeof c.stars === 'number' && c.stars > 0 ? ` ${c.stars}★` : '';
  const lines: string[] = [];

  const desc = clean(c.description, MAX_PROP_DESC);
  lines.push(
    `PROPERTY: ${name}${stars}${desc ? ` — ${desc}` : ''} (Exely, live-synced${syncedAt ? ` ${syncedAt.slice(0, 10)}` : ''})`,
  );

  const addressLine = clean(c.contactInfo?.address?.addressLine, 160);
  if (addressLine) {
    const city = clean(c.contactInfo?.address?.cityName, 60);
    lines.push(`ADDRESS: ${addressLine}${city ? `, ${city}` : ''}. (Exely)`);
  }

  // Render each side only when Exely actually supplies it — never fabricate a time and label it Exely.
  const ci = clean(c.policy?.checkInTime, 12);
  const co = clean(c.policy?.checkOutTime, 12);
  if (ci && co) {
    lines.push(`CHECK-IN / CHECK-OUT: Check-in from ${ci}, check-out until ${co}. (Exely)`);
  } else if (ci) {
    lines.push(`CHECK-IN: from ${ci}. (Exely)`);
  } else if (co) {
    lines.push(`CHECK-OUT: until ${co}. (Exely)`);
  }

  const rooms = (c.roomTypes ?? []).slice(0, MAX_ROOMS).filter((r) => clean(r.name, MAX_NAME));
  if (rooms.length) {
    lines.push('ROOM CATEGORIES (Exely — names, sizes and capacity are live):');
    for (const r of rooms) {
      const rn = clean(r.name, MAX_NAME);
      const meta = [sizeText(r.size), occText(r.occupancy)].filter(Boolean).join(', ');
      const d = clean(r.description, MAX_ROOM_DESC);
      lines.push(`- ${rn}${meta ? ` — ${meta}` : ''}.${d ? ` ${d}` : ''}`);
    }
  }

  lines.push(
    'PRICES: never state a price yourself — quote ONLY what check_availability returns for the ' +
      "guest's exact dates. Any number in the text above is descriptive, not a quotable rate.",
  );

  const services = Array.from(
    new Set(
      (c.services ?? [])
        .filter((s) => (s.status ?? 'Active') === 'Active')
        .map((s) => clean(s.name, MAX_FIELD))
        .filter(Boolean),
    ),
  );
  if (services.length) lines.push(`MEALS & SERVICES (Exely): ${services.join(', ')}.`);

  const amenities = Array.from(
    new Set((c.amenities ?? []).map((a) => clean(a.displayName, MAX_FIELD)).filter(Boolean)),
  );
  if (amenities.length) lines.push(`AMENITIES (Exely): ${amenities.join(', ')}.`);

  const phones = Array.from(
    new Set((c.contactInfo?.phones ?? []).map((p) => clean(p.phoneNumber, 40)).filter(Boolean)),
  );
  const emails = Array.from(
    new Set(
      (c.contactInfo?.emails ?? [])
        .map((e) => (typeof e === 'string' ? clean(e, 80) : ''))
        .filter(Boolean),
    ),
  );
  const contactBits = [
    phones.length ? `phone ${phones.join(', ')}` : '',
    emails.length ? `email ${emails.join(', ')}` : '',
  ].filter(Boolean);
  if (contactBits.length) lines.push(`CONTACT: ${contactBits.join('; ')}. (Exely)`);

  lines.push('LANGUAGES SPOKEN BY STAFF: Kazakh, Russian, English.');
  lines.push(
    'BOOKING: this assistant sends a personal secure booking link — the guest completes it on the ' +
      "hotel's Exely page, and Exely creates the booking and emails them the confirmation and documents.",
  );

  return lines.join('\n');
}

export interface KnowledgeSnapshot {
  knowledge: string;
  syncedAt: string;
}

export interface ExelyContentSyncDeps {
  /** Property keys that have a live Exely cabinet. */
  properties: string[];
  /** Pull the raw Content API response for a hotel (undefined = no cabinet). */
  contentFor: (property: string) => Promise<unknown> | undefined;
  /** Injectable clock (tests). */
  now?: () => string;
}

/** True only for a substantive Content payload — an empty {}, an array, or an error-shaped 2xx
 *  body must NOT overwrite good knowledge with garbage. */
function isUsableContent(v: unknown): v is ExelyContent {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const c = v as ExelyContent;
  if (typeof c.name !== 'string' || c.name.trim() === '') return false;
  return (c.roomTypes?.length ?? 0) > 0 || (c.services?.length ?? 0) > 0;
}

/** Pulls each hotel's catalog on demand / on a schedule and caches the derived knowledge text. */
export class ExelyContentSync {
  private readonly cache = new Map<string, KnowledgeSnapshot>();
  private readonly now: () => string;

  constructor(private readonly deps: ExelyContentSyncDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /** Latest synced knowledge for a hotel, or undefined if never synced (caller falls back to static). */
  knowledgeFor(property: string): string | undefined {
    return this.cache.get(property)?.knowledge;
  }

  syncedAt(property: string): string | undefined {
    return this.cache.get(property)?.syncedAt;
  }

  /** Last-synced status for every known hotel (for the console). */
  status(): Array<{ property: string; syncedAt: string | null }> {
    return this.deps.properties.map((p) => ({ property: p, syncedAt: this.cache.get(p)?.syncedAt ?? null }));
  }

  /** Pull one hotel. Returns false (keeping the last good copy) on any failure — never throws. */
  async refresh(property: string): Promise<boolean> {
    const pending = this.deps.contentFor(property);
    if (!pending) return false;
    try {
      const content = await pending;
      if (!isUsableContent(content)) return false; // never overwrite good knowledge with an empty/partial body
      const syncedAt = this.now();
      this.cache.set(property, { knowledge: contentToKnowledge(content, syncedAt), syncedAt });
      return true;
    } catch {
      return false; // a Content outage must never break the bot
    }
  }

  /** Pull every configured hotel concurrently. */
  async refreshAll(): Promise<{ updated: string[]; failed: string[] }> {
    const results = await Promise.all(
      this.deps.properties.map(async (p) => [p, await this.refresh(p)] as const),
    );
    return {
      updated: results.filter(([, ok]) => ok).map(([p]) => p),
      failed: results.filter(([, ok]) => !ok).map(([p]) => p),
    };
  }
}
