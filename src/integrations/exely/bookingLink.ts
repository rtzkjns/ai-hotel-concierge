import type { Language } from '../../types';

/**
 * The booking form link is the ONLY booking path in production, so it has to be correct in two
 * ways Exely does not get right on its own. Both behaviours below were established by live
 * probing of the real widget (2026-08-14), not from documentation.
 *
 * 1) LANGUAGE. Exely always emits `/ru/…&tl-lng=ru`, so a Kazakh, English or Chinese guest was
 *    handed a Russian payment form — the contract requires all four languages to work equally.
 *    `tl-lng` is the primary lever: the site passes it straight into the Exely widget iframe as
 *    `language=` and it OVERRIDES the path prefix. The path prefix localises the page chrome, so
 *    both are rewritten. Traps found live: `tl-lng=kz` is NOT Kazakh (the widget silently falls
 *    back to English — the valid code is `kk`), and the paths `/kk/` and `/zh/` do not exist
 *    (404 → redirect to /ru/); the real prefixes are `/kz/` and `/cn/`.
 *
 * 3) ГДЕ ФОРМА. Ссылка Exely ведёт на kazzhol.com/ru/booking — а эта страница отеля показывает
 *    выбор отеля и плавающую корзину, но самой формы бронирования на ней нет: гость видит
 *    пустую страницу («че за фигня», дословно). Настоящий движок живёт на kz-ibe.hopenapi.com,
 *    и сайт грузит его во фрейм именно оттуда, перекладывая tl-параметры в свои. Мы собираем
 *    этот адрес сами, поэтому гость сразу попадает на выбор номера с уже подставленными
 *    датами, гостями и категорией.
 *
 * 2) ROOM TYPE. For "variant" room types Exely puts a DIFFERENT `room-type` in the link than the
 *    offer it just returned (observed: offer roomTypeId 5052704, link room-type 6154). The widget
 *    then shows «номер недоступен» / «САТЫЛЫП КЕТТІ» although the API reported availability — the
 *    guest hits a dead end on the payment step. Pinning the id from the offer fixes it.
 */

const PATH_SEGMENT: Record<Language, string> = { ru: 'ru', kk: 'kz', en: 'en', zh: 'cn' };
const TL_LNG: Record<Language, string> = { ru: 'ru', kk: 'kk', en: 'en', zh: 'zh-CN' };
/** Язык самого движка брони (параметр `language` во фрейме). */
const IBE_LNG: Record<Language, string> = { ru: 'ru', kk: 'kk', en: 'en', zh: 'zh-CN' };
const IBE_BASE = 'https://kz-ibe.hopenapi.com/booking2/hotel/index.gge.html';

/**
 * Прямой адрес формы бронирования.
 *
 * Собирается из тех же данных, что сайт перекладывает во фрейм: отель, категория, тариф,
 * дата заезда, число ночей и гостей. Возвращает null, если в исходной ссылке не хватает
 * главного — тогда остаётся прежний адрес, он хотя бы не ведёт в никуда.
 */
function directBookingForm(url: URL, lang: Language, roomTypeId?: string | null): string | null {
  const hotel = url.searchParams.get('hotel_id');
  const date = url.searchParams.get('tl-date');
  if (!hotel || !date) return null;
  const out = new URL(IBE_BASE);
  out.searchParams.set('providerId', hotel);
  out.searchParams.set('date', date);
  out.searchParams.set('nights', url.searchParams.get('tl-nights') ?? '1');
  out.searchParams.set('adults', url.searchParams.get('tl-adults') ?? '2');
  out.searchParams.set('currency', url.searchParams.get('tl-cur') ?? 'KZT');
  out.searchParams.set('language', IBE_LNG[lang]);
  const room = roomTypeId ?? url.searchParams.get('tl-room') ?? url.searchParams.get('room-type');
  if (room) out.searchParams.set('roomTypes', room);
  const rate = url.searchParams.get('tl-offer');
  if (rate) out.searchParams.set('ratePlans', rate);
  const children = url.searchParams.get('tl-children-age');
  if (children) out.searchParams.set('childAges', children);
  return out.toString();
}

export function localizeBookingLink(
  link: string | null | undefined,
  language: Language | null | undefined,
  roomTypeId?: string | null,
): string | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    const lang: Language = language ?? 'ru';
    // Touch ONLY links that are actually Exely booking links (they always carry tl-lng and a
    // language path segment). Anything else — a hotel page, a stub in tests — is left verbatim.
    const hasLangParam = url.searchParams.has('tl-lng');
    const hasLangPath = /^\/(ru|en|kz|cn)(?=\/|$)/.test(url.pathname);
    if (!hasLangParam && !hasLangPath) return link;
    if (hasLangPath) {
      url.pathname = url.pathname.replace(/^\/(ru|en|kz|cn)(?=\/|$)/, `/${PATH_SEGMENT[lang]}`);
    }
    if (hasLangParam) url.searchParams.set('tl-lng', TL_LNG[lang]);
    // Pin the room type Exely actually priced, so the form opens on a bookable offer.
    if (roomTypeId && url.searchParams.has('room-type')) {
      url.searchParams.set('room-type', roomTypeId);
    }
    // Гость видит эту ссылку целиком в мессенджере, поэтому в ней не должно быть
    // ничего, что на бронь не влияет: метка источника и пустые параметры только
    // удлиняют её и делают похожей на рекламную.
    for (const junk of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
      url.searchParams.delete(junk);
    }
    for (const [key, value] of [...url.searchParams.entries()]) {
      if (value === '') url.searchParams.delete(key);
    }
    // Прямая форма, если её удаётся собрать: страница отеля формы не содержит.
    return directBookingForm(url, lang, roomTypeId) ?? url.toString();
  } catch {
    // A link we cannot parse is still better than no link at all.
    return link;
  }
}
