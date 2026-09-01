// Boot: store → integrations → engine → channel adapters → fastify server.
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { InstagramAdapter } from './channels/instagram';
import { TelegramChannel } from './channels/telegram';
import type { StaffNotifier } from './channels/types';
import { WebWidgetChannel } from './channels/webwidget';
import { WhatsAppAdapter } from './channels/whatsapp';
import { config, enabledChannels } from './config';
import { hashPassword } from './console/auth';
import { registerConsoleRoutes, type SendToConversation } from './console/routes';
import { BookingService } from './core/booking';
import { auditBookingHeldInventory } from './core/bookingAudit';
import { metricsSummary } from './core/events';
import { Engine } from './core/engine';
import { RateLimiter } from './core/rateLimit';
import { startRetention } from './core/retention';
import { StubAmoCrm } from './integrations/amocrm';
import { createProviders } from './integrations/registry';
import { fetchVoucherNumber } from './integrations/exely/ibeBooking';
import { ExelyContentSync } from './knowledge/contentSync';
import { extractText } from './knowledge/documents';
import { SourceSync } from './knowledge/sourceSync';
import { StubPaymentGateway } from './integrations/payments';
import { createTranscriber } from './integrations/transcribe';
import { buildServer, handleWhatsAppItem, handleInstagramItem } from './server';
import type { InboundMessage } from './channels/types';
import { activeTenant } from './tenant';
import {
  CONFIRMATION_TTL_MS,
  newConfirmationToken,
  registerConfirmRoutes,
  type ConfirmationData,
} from './server/confirm';
import { registerChatfuelBridge } from './server/chatfuel';
import { Store } from './store';

/** Staff alerts: Telegram staff chat via raw Bot API when configured, console otherwise. */
function createStaffNotifier(store: {
  staffChatsFor?(p: string): Array<{ chatId: string; title: string }>;
  deactivateStaffChat?(chatId: string): boolean;
  recordEvent?(type: string, data?: { property?: string; payload?: unknown }): void;
}): StaffNotifier {
  const token = config.telegram.botToken;
  const fallbackChat = config.telegram.staffGroupChatId;
  const byProperty = config.telegram.staffChatByProperty ?? {};
  if (!token) return { notify: (text) => console.log('[staff]', text) };

  async function send(chatId: string, text: string): Promise<boolean> {
    // Transient Telegram errors (5xx / 429 / a dropped connection) must NOT silently lose a staff
    // notification — that is exactly the "сообщения в телеграм не приходят" complaint. Retry with
    // backoff; a 403 (bot blocked / chat not started) is permanent and deactivates the recipient.
    const delays = [400, 1500, 4000];
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        });
        if (res.ok) return true;
        // 403 — «бот заблокирован» или «диалог не начат»: само не пройдёт и на каждой заявке даёт
        // ошибку, за которой теряются настоящие сбои. Отключаем получателя и не ретраим.
        if (res.status === 403 && store.deactivateStaffChat?.(chatId)) {
          console.warn(`staff chat ${chatId} отключён: Telegram отвечает 403`);
          store.recordEvent?.('staff_chat_disabled', { payload: { chatId } });
          return false;
        }
        console.error(
          `staff notify failed: Telegram HTTP ${res.status} (chat ${chatId}) — попытка ${attempt + 1}`,
        );
        if ((res.status === 429 || res.status >= 500) && attempt < delays.length) {
          await new Promise((r) => setTimeout(r, delays[attempt]));
          continue;
        }
        return false;
      } catch (err) {
        console.error('staff notify failed:', err instanceof Error ? err.message : 'unknown error');
        if (attempt < delays.length) {
          await new Promise((r) => setTimeout(r, delays[attempt]));
          continue;
        }
        return false;
      }
    }
  }

  return {
    async notify(text, property) {
      // Заявка идёт менеджерам СВОЕГО отеля. Владелец получает копию только тогда,
      // когда у отеля нет ни одного получателя — иначе каждая мелочь падала бы ему,
      // а он именно об этом и просил не делать.
      const hotelChats = property ? (store.staffChatsFor?.(property) ?? []) : [];
      const targets = new Set(hotelChats.map((c) => c.chatId));
      if (property && !targets.size && byProperty[property]) targets.add(byProperty[property]);
      if (!targets.size && fallbackChat) targets.add(fallbackChat);

      // Ни одного адресата — заявка гостя не должна исчезнуть в тишине. Раньше пустой
      // Promise.all давал [], [].every() возвращал true, запасная ветка не срабатывала, и
      // обращение пропадало без единой строки где бы то ни было.
      if (targets.size === 0) {
        console.error(
          `ЗАЯВКА НЕ ДОСТАВЛЕНА: у отеля «${property ?? '—'}» нет ни одного получателя.\n${text}`,
        );
        store.recordEvent?.('staff_notify_no_recipients', {
          property,
          payload: { preview: text.slice(0, 200) },
        });
        return;
      }

      const results = await Promise.all([...targets].map((c) => send(c, text)));
      // Никто не получил — заявка гостя не должна пропасть молча.
      if (results.every((ok) => !ok) && fallbackChat && !targets.has(fallbackChat)) {
        await send(fallbackChat, `Не удалось доставить заявку менеджерам отеля.\n\n${text}`);
      }
    },
  };
}

/** The research-backed texting style guide, embedded into every system prompt. */
function loadStyleGuide(): string | undefined {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    return readFileSync(join(root, 'docs', 'STYLE-GUIDE.md'), 'utf8');
  } catch {
    console.warn('docs/STYLE-GUIDE.md not found — running on the prompt-embedded style rules only.');
    return undefined;
  }
}

async function main(): Promise<void> {
  const store = new Store(config.dbPath);
  // Refuse to boot if this DB belongs to another tenant — enforces one-DB-per-tenant in code so a
  // mis-set DB_PATH can't silently pool two brands' guest data.
  store.assertTenant(activeTenant.id);
  // Code-enforced data-residency contract: a tenant that must keep guest data in-country will not
  // boot until the deploy explicitly confirms the DB_PATH points at an in-country volume. Turns a
  // silent hosting assumption into a hard startup check (KZ Law 94-V and similar).
  if (activeTenant.dataResidency?.inCountry && process.env.DATA_RESIDENCY_CONFIRMED !== 'true') {
    throw new Error(
      `Tenant "${activeTenant.id}" requires in-country data residency, but DATA_RESIDENCY_CONFIRMED ` +
        'is not set. Point DB_PATH at an in-country volume and set DATA_RESIDENCY_CONFIRMED=true.',
    );
  }

  // First boot: seed the console admin account from env, if configured.
  if (store.countStaff() === 0 && config.console.adminPassword) {
    store.createStaff(config.console.adminLogin, hashPassword(config.console.adminPassword), 'admin');
    console.log('console admin seeded');
  }

  const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

  // Each hotel routes to its OWN Exely cabinet (Astana & Park Almaty are separate accounts).
  // A hotel with no cabinet falls back to stub; a hotel listed in MANUAL_PROPERTIES (no PMS API)
  // is served by the manual/handoff provider — that is what lets a non-Exely hotel onboard.
  const cabinets = createProviders(config.exelyByProperty, {
    manualProperties: (process.env.MANUAL_PROPERTIES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  });
  const availabilityProvider = cabinets.availability;

  // Keep the bot's hotel knowledge (rooms, services, policies) fresh from Exely's Content API —
  // the system of record. Prices stay live via Search; this covers the static catalog.
  const contentSync = new ExelyContentSync({
    properties: Object.keys(config.exelyByProperty),
    contentFor: cabinets.contentFor,
  });
  // Ссылки, которые отель кладёт в панель, вычитываются фоном и складываются в базу
  // знаний. Не на лету: страница может лечь, а ответ гостю ждать её не должен.
  const sourceSync = new SourceSync(store, {
    readPdf: (buf, filename) =>
      extractText(buf, filename, { client: anthropic, model: config.anthropicModel }),
  });

  const bookingService = new BookingService({
    store,
    provider: availabilityProvider,
    reservationFor: cabinets.reservationFor,
    bookingEnabledFor: cabinets.bookingEnabledFor,
    propertyIdResolver: cabinets.propertyIdResolver,
  });

  const phoneNumberIdToProperty: Record<string, string> = Object.fromEntries(
    Object.entries(config.whatsapp.phoneNumberIds).map(([property, id]) => [id, property]),
  );

  const staffNotifier = createStaffNotifier(store);

  // Кладёт заявку под случайный токен и отдаёт ссылку на страницу подтверждения.
  // Токен, а не номер по порядку: ссылку гость пересылает, и подобрать чужую заявку
  // перебором быть не должно.
  // Без внешнего адреса ссылку собрать не из чего — тогда страницы просто нет, и бот
  // оформляет бронь по «подтверждаю» прямо в чате. Молча деградировать нельзя: это
  // заметное изменение поведения, и в логе загрузки оно должно быть видно.
  const publicBase = config.server.publicBaseUrl?.replace(/\/+$/, '');
  if (!publicBase) {
    console.warn(
      'PUBLIC_BASE_URL не задан — страница подтверждения отключена, бронь оформляется прямо в чате.',
    );
  }
  const confirmationLink = publicBase
    ? (data: ConfirmationData): string => {
        const token = newConfirmationToken();
        store.saveConfirmation({
          token,
          conversationId: data.conversationId,
          property: data.property,
          data,
          expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString(),
        });
        return `${publicBase}/b/${token}`;
      }
    : undefined;

  const engine = new Engine({
    store,
    client: anthropic,
    model: config.anthropicModel,
    availabilityProvider,
    bookingService,
    paymentGateway: new StubPaymentGateway(),
    crm: new StubAmoCrm((type, data) => store.recordEvent(type, { payload: data })),
    transcriber: createTranscriber(config.openaiApiKey),
    staffNotifier,
    rateLimiter: new RateLimiter(),
    phoneNumberIdToProperty,
    styleGuide: loadStyleGuide(),
    knowledgeFor: (property) => contentSync.knowledgeFor(property),
    confirmationLink,
    // Ссылка ведёт в панель, а не в Instagram: точную ссылку на конкретную переписку
    // Instagram не отдаёт (ни ник гостя, ни id треда), а панель показывает весь разговор
    // и отвечает в тот канал, откуда гость пришёл, — одинаково для всех каналов.
    chatLink: publicBase
      ? (conversationId) => `${publicBase}/console/chats/${encodeURIComponent(conversationId)}`
      : undefined,
  });

  // Initial pull so the bot boots on the freshest catalog. Bounded + non-fatal: if Exely Content
  // is unreachable, the static knowledge in src/knowledge stays in place and we retry on schedule.
  try {
    const { updated, failed } = await contentSync.refreshAll();
    engine.rebuildPrompts();
    console.log(
      `Exely content synced: ${updated.join(', ') || 'none'}` +
        (failed.length ? ` (fell back to static: ${failed.join(', ')})` : ''),
    );
  } catch (err) {
    console.warn(
      'Exely content sync failed at boot — using static knowledge:',
      err instanceof Error ? err.message : err,
    );
  }

  const channels = enabledChannels();

  const adapters: { whatsapp?: WhatsAppAdapter; instagram?: InstagramAdapter } = {};
  if (channels.includes('whatsapp') && config.whatsapp.accessToken) {
    adapters.whatsapp = new WhatsAppAdapter({
      accessToken: config.whatsapp.accessToken,
      phoneNumberIds: config.whatsapp.phoneNumberIds,
      provider: config.whatsapp.provider,
    });
  }
  // Create the IG adapter when EITHER a single fallback token OR per-account tokens exist —
  // the Instagram Login path issues a separate token per hotel account (no single accessToken),
  // so gating only on accessToken left adapters.instagram undefined and silently dropped every DM.
  if (
    channels.includes('instagram') &&
    (config.instagram.accessToken || Object.keys(config.instagram.tokens ?? {}).length > 0)
  ) {
    adapters.instagram = new InstagramAdapter({
      accessToken: config.instagram.accessToken,
      igIds: config.instagram.igIds,
      tokens: config.instagram.tokens,
      baseUrl: config.instagram.baseUrl,
    });
  }

  const widget = new WebWidgetChannel({ engine, store });

  // Staff replies from the console go out through whatever channel the
  // conversation lives on; assigned below once the Telegram channel exists.
  let telegram: TelegramChannel | undefined;
  const sendToConversation: SendToConversation = async (convo, text) => {
    const parts = [{ text, delayMs: 0 }];
    switch (convo.channel) {
      case 'whatsapp':
        if (!adapters.whatsapp) return { ok: false, error: 'WhatsApp is not configured' };
        await adapters.whatsapp.send(convo.senderId, parts);
        return { ok: true };
      case 'telegram':
        if (!telegram) return { ok: false, error: 'Telegram is not running' };
        await telegram.bot.telegram.sendMessage(Number(convo.senderId), text);
        return { ok: true };
      case 'webwidget':
        return widget.pushToGuest(convo.senderId, text)
          ? { ok: true }
          : { ok: false, error: 'guest offline (widget closed)' };
      case 'instagram':
        if (!adapters.instagram) return { ok: false, error: 'Instagram is not configured' };
        await adapters.instagram.send(convo.senderId, parts);
        return { ok: true };
      default:
        return { ok: false, error: 'unknown channel' };
    }
  };

  // Фоновая отправка рассылки: читаем получателей пачками, шлём текст через тот же канал, что и у
  // диалога; в Telegram при наличии файла — нативно (фото/видео/док/аудио). Для WhatsApp/Instagram
  // ещё раз проверяем окно 24ч на момент отправки (оно могло закрыться) и медиа НЕ шлём (v1).
  const BROADCAST_MEDIA_DIR = './data/broadcasts';
  const runBroadcast = (broadcastId: number): void => {
    void (async () => {
      const b = store.getBroadcast?.(broadcastId);
      if (!b) return;
      let mediaBuf: Buffer | null = null;
      if (b.mediaPath) {
        try {
          mediaBuf = readFileSync(b.mediaPath);
        } catch {
          mediaBuf = null;
        }
      }
      const text = (b.body ?? '').trim();
      const WINDOW = 24 * 60 * 60 * 1000;
      for (;;) {
        const batch = store.nextPendingRecipients(broadcastId, 20);
        if (batch.length === 0) break;
        for (const r of batch) {
          try {
            const convo = store.getConversation(r.conversationId);
            if (!convo) {
              store.markRecipient(r.id, 'skipped', 'conversation_gone');
              continue;
            }
            if (
              (convo.channel === 'whatsapp' || convo.channel === 'instagram') &&
              Date.now() - Date.parse(convo.updatedAt) >= WINDOW
            ) {
              store.markRecipient(r.id, 'skipped', 'outside_24h_window');
              continue;
            }
            if (convo.channel === 'telegram' && mediaBuf && telegram && b.mediaPath) {
              const chatId = Number(convo.senderId);
              const src = { source: mediaBuf, filename: basename(b.mediaPath) };
              const cap = text ? { caption: text } : {};
              if (b.mediaKind === 'image') await telegram.bot.telegram.sendPhoto(chatId, src, cap);
              else if (b.mediaKind === 'video') await telegram.bot.telegram.sendVideo(chatId, src, cap);
              else if (b.mediaKind === 'audio') await telegram.bot.telegram.sendAudio(chatId, src, cap);
              else await telegram.bot.telegram.sendDocument(chatId, src, cap);
              store.markRecipient(r.id, 'sent');
            } else if (text) {
              const res = await sendToConversation(convo, text);
              store.markRecipient(r.id, res.ok ? 'sent' : 'failed', res.error);
            } else {
              // Медиа-рассылка без текста в не-Telegram канал — в v1 не отправляем.
              store.markRecipient(r.id, 'skipped', 'media_telegram_only');
            }
          } catch (err) {
            store.markRecipient(r.id, 'failed', err instanceof Error ? err.message : 'error');
          }
          await new Promise((res) => setTimeout(res, 700)); // темп ~1 сообщение/сек на чат
        }
      }
      store.setBroadcastStatus(broadcastId, 'done');
    })().catch(() => {});
  };

  if (process.env.WEBHOOK_OBSERVE_ONLY === 'true') {
    console.warn(
      'WEBHOOK_OBSERVE_ONLY=true — подпись вебхуков ПРОВЕРЯЕТСЯ, но несовпадение НЕ отклоняется. ' +
        'Пока флаг стоит, вебхук принимает запросы от кого угодно. Снимать его можно только ' +
        'после того, как в журнале живая доставка Meta пройдёт без строки «подпись не совпала».',
    );
  }

  const app = await buildServer({
    engine,
    adapters,
    store,
    config,
    notifyStaff: async (text, property) => {
      await staffNotifier.notify(text, property);
    },
    extraRoutes: [
      (a) => widget.register(a),
      (a) =>
        registerConfirmRoutes(a, {
          store,
          createBooking: (args) => bookingService.createBooking(args),
          saveRequest: (lead) => store.saveLead(lead),
          chatLink: publicBase
            ? (id) => `${publicBase}/console/chats/${encodeURIComponent(id)}`
            : undefined,
          // Сверка склада: единственный признак настоящей брони, который движок не
          // может нарисовать. Расхождение зовёт людей, а не разворачивает гостя.
          auditBooking: (a) => {
            void auditBookingHeldInventory(
              {
                provider: availabilityProvider,
                recordEvent: (type, data) => store.recordEvent(type, data),
                notifyStaff: async (text, property) => {
                  await staffNotifier.notify(text, property);
                },
              },
              a,
            ).catch(() => undefined);
          },
          // Догоняем короткий номер Exely и досылаем его менеджерам: искать бронь по
          // служебному номеру бесполезно, а он — единственное, что есть сразу.
          resolveHotelNumber: ({ number, voucherUrl, property, hotelName }) => {
            void fetchVoucherNumber(voucherUrl, { delaysMs: [20_000, 30_000, 60_000] })
              .then(async (hotelNumber) => {
                if (!hotelNumber) return;
                store.setBookingHotelNumber(number, hotelNumber);
                await staffNotifier.notify(
                  `Бронь ${number} — номер в Exely: ${hotelNumber}\n${hotelName}\nПо нему бронь и ищется.`,
                  property,
                );
              })
              .catch(() => undefined);
          },
          // Подтверждение уходит гостю в тот же канал, откуда он писал.
          notifyGuest: async (conversationId, text) => {
            const convo = store.getConversation(conversationId);
            if (!convo) return;
            const res = await sendToConversation(convo, text);
            if (!res.ok) {
              // Бронь на месте, но гость остался без номера на руках и не знает об этом.
              // Отель должен узнать сразу и отправить подтверждение сам.
              store.recordEvent('guest_confirmation_failed', {
                conversationId,
                property: convo.property,
                payload: { error: res.error },
              });
              await staffNotifier.notify(
                `Гостю НЕ доставлено подтверждение брони (${res.error ?? 'причина неизвестна'}).\n` +
                  `Канал: ${convo.channel}. Диалог: ${conversationId}.\n` +
                  `Отправьте гостю подтверждение вручную:\n\n${text}`,
                convo.property,
              );
            }
          },
          notifyStaff: async (text, property) => {
            await staffNotifier.notify(text, property);
          },
        }),
      (a) =>
        registerConsoleRoutes(a, {
          store,
          metricsSummary,
          sendToConversation,
          knowledgeStatus: () => contentSync.status(),
          refreshKnowledge: async () => {
            await contentSync.refreshAll();
            engine.rebuildPrompts();
          },
          refreshSource: (entry) => sourceSync.refreshOne(entry),
          botUsername: config.telegram.botUsername,
          notifyStaff: async (text, property) => { await staffNotifier.notify(text, property); },
          publicBaseUrl: config.server.publicBaseUrl,
          runBroadcast,
          broadcastMediaDir: BROADCAST_MEDIA_DIR,
          // Служебный вопрос из панели: тот же движок и та же база знаний, но
          // отдельный разговор с префиксом console-test — он не попадает во «Входящие».
          askBot: async (property, question) => {
            const senderId = `console-test:${property}`;
            const convo = store.getOrCreateConversation('webwidget', senderId);
            store.resetConversation(convo.id);
            store.setProperty(convo.id, property);
            const parts = await engine.handle({
              channel: 'webwidget',
              senderId,
              text: question,
            });
            return (parts ?? []).map((p) => p.text).join(' ').trim();
          },
          // PDF и фотографии читает сама модель — один раз, при загрузке.
          extractFile: (buf, filename) =>
            extractText(buf, filename, { client: anthropic, model: config.anthropicModel }),
        }),
      // Chatfuel bridge — temporary IG tenant path (answers all guests while our App Review pends).
      (a) => {
        if (Object.keys(config.chatfuelBots).length > 0) {
          registerChatfuelBridge(a, {
            engine,
            bots: config.chatfuelBots,
            inboundTimeoutMs: Number(process.env.CHATFUEL_INBOUND_TIMEOUT_MS) || undefined,
          });
        }
      },
    ],
  });
  await app.listen({ port: config.server.port, host: '0.0.0.0' });
  startRetention(store);

  // Recover guest messages a previous crash/deploy left journalled but not finished (the durable
  // intake gap). Replays each once; the markReplying gate means a message already answered before
  // the crash is closed without re-sending. A message that keeps failing is parked 'dead' + flagged.
  const INBOUND_GRACE_MS = 60_000;
  const INBOUND_MAX_ATTEMPTS = 5;
  const inboundDeps = { engine, adapters, store, config };
  const sweepInbound = async (): Promise<void> => {
    for (const row of store.reclaimStaleInbound(INBOUND_GRACE_MS)) {
      if (row.attempts >= INBOUND_MAX_ATTEMPTS) {
        store.markInboundDead(row.id);
        void Promise.resolve(
          staffNotifier.notify(`Входящее сообщение не удалось обработать (${row.channel}). Ответьте вручную.`),
        ).catch(() => {});
        continue;
      }
      if (!store.reclaimInbound(row.id)) continue;
      if (row.repliedAt) {
        store.markInboundDone(row.id); // answered before the crash → close, never re-send
        continue;
      }
      const p = row.payload as {
        inbound: InboundMessage;
        phoneNumberId?: string;
        audioMediaId?: string;
        audioMime?: string;
      };
      try {
        if (row.channel === 'whatsapp' && adapters.whatsapp) {
          await handleWhatsAppItem(
            inboundDeps,
            phoneNumberIdToProperty,
            adapters.whatsapp,
            {
              inbound: p.inbound,
              phoneNumberId: p.phoneNumberId ?? '',
              audioMediaId: p.audioMediaId,
              audioMime: p.audioMime,
            },
            row.id,
          );
        } else if (row.channel === 'instagram' && adapters.instagram) {
          await handleInstagramItem(inboundDeps, adapters.instagram, p.inbound, row.id);
        } else {
          store.markInboundDone(row.id); // that channel isn't configured on this instance
        }
      } catch {
        // leave the row 'processing' → the next sweep retries it
      }
    }
  };
  await sweepInbound();
  const inboundSweep = setInterval(() => void sweepInbound(), INBOUND_GRACE_MS);
  inboundSweep.unref();

  // Resume any broadcast a crash/restart left mid-send (status 'sending' with pending recipients).
  for (const broadcastId of store.resumableBroadcasts()) runBroadcast(broadcastId);

  // Twice-daily catalog refresh so room/service/policy changes made in Exely reach the bot with
  // no redeploy (staff can also force it from the console). unref() so it never holds the process up.
  const knowledgeTimer = setInterval(
    () => {
      contentSync
        .refreshAll()
        .then(() => engine.rebuildPrompts())
        .catch(() => undefined);
    },
    12 * 60 * 60 * 1000,
  );
  knowledgeTimer.unref();

  // Источники отеля: читаем на старте и раз в час проверяем, не устарели ли.
  // Сама вычитка бережная — только то, что старше 6 часов, и по одной странице.
  void sourceSync
    .refreshDue()
    .then((r) => {
      if (r.checked) console.log(`Источники отеля: прочитано ${r.updated}, не удалось ${r.failed}`);
    })
    .catch(() => undefined);
  const sourceTimer = setInterval(
    () => {
      sourceSync.refreshDue().catch(() => undefined);
    },
    60 * 60 * 1000,
  );
  sourceTimer.unref();

  if (channels.includes('telegram') && config.telegram.botToken) {
    const tg = new TelegramChannel({
      botToken: config.telegram.botToken,
      engine,
      store,
      bindCode: () => store.bindCode(),
      onBindChanged: (property, chatId, previous) => {
        // Молчаливая перепривязка означала бы, что отель перестал получать заявки
        // и не узнал об этом. Сообщаем владельцу и прежней группе.
        void staffNotifier.notify(
          `Чат заявок отеля ${property} изменён. Новый чат: ${chatId}` +
            (previous ? `, прежний: ${previous}` : ''),
        );
      },
    });
    telegram = tg;
    tg.launch();
    console.log('Telegram channel: running');
    process.once('SIGINT', () => tg.stop('SIGINT'));
    process.once('SIGTERM', () => tg.stop('SIGTERM'));
  }

  console.log(
    `Kazzhol AI server listening on :${config.server.port} — channels: ${channels.join(', ')}`,
  );

  // Graceful shutdown. Without it systemd waits the full 90s TimeoutStopSec and then SIGKILLs:
  // in-flight guest replies die mid-send and the SQLite handle is never closed. Stop accepting
  // new webhooks first, let the current turns finish, then close the database.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received — shutting down gracefully`);
    try {
      await app.close();
    } catch (err) {
      console.error('http close failed:', err instanceof Error ? err.message : err);
    }
    try {
      store.close?.();
    } catch (err) {
      console.error('store close failed:', err instanceof Error ? err.message : err);
    }
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('boot failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
