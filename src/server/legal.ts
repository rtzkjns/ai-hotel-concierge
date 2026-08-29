// Public legal pages served by the bot itself: a privacy policy and terms of
// service. Meta App Review requires a public Privacy Policy URL for a WhatsApp
// Business app; hosting it on the bot's own domain is the correct place for it.
// Brand name and website come from the active tenant so a second tenant's guests
// never see another brand's legal pages.
import type { FastifyInstance } from 'fastify';
import { activeTenant } from '../tenant';

const UPDATED = '2026-08-30';
const brand = activeTenant.brand;

function page(title: string, bodyHtml: string): string {
  return (
    `<!doctype html><html lang="ru"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${title} — ${brand.displayName} AI</title>` +
    `<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:0 auto;` +
    `padding:32px 20px;color:#1c2430;line-height:1.6}h1{font-size:24px}h2{font-size:18px;margin-top:28px}` +
    `a{color:#1b74e4}small{color:#5b6b7d}</style></head><body>${bodyHtml}` +
    `<hr><small>Обновлено: ${UPDATED}. ${brand.displayName} AI — ассистент бронирования сети отелей ${brand.displayName}.</small>` +
    `</body></html>`
  );
}

const PRIVACY = page(
  'Политика конфиденциальности',
  `<h1>Политика конфиденциальности</h1>
<p>Этот сервис («${brand.displayName} AI», «ассистент») — автоматизированный помощник по бронированию для
сети отелей ${brand.displayName}. Он общается с гостями в мессенджерах (WhatsApp, Instagram, Telegram) и на
сайте, помогает узнать наличие и цены номеров, оформить бронирование и ответить на вопросы.</p>

<h2>Какие данные обрабатываются</h2>
<p>Для обработки запроса гостя сервис получает: сообщения гостя, имя и номер телефона при
оформлении брони, даты и параметры проживания. Эти данные используются исключительно для ответа
гостю и оформления бронирования в системе управления отелем.</p>

<h2>Как используются данные</h2>
<p>Данные передаются только в системы, необходимые для брони (система управления отелем и
платёжный провайдер отеля), и сотрудникам отеля для обработки запроса. Данные не продаются и не
передаются третьим лицам в рекламных целях.</p>

<h2>Автоматическая обработка и передача поставщику ИИ</h2>
<p>Чтобы формировать ответы, текст сообщений гостя обрабатывается сторонним поставщиком технологий
искусственного интеллекта, серверы которого могут находиться за пределами Республики Казахстан.
Передаётся содержание переписки, необходимое для ответа; оно не используется поставщиком для
собственной рекламы. Пользуясь чатом, гость соглашается на такую автоматическую обработку. Если
гость не согласен на трансграничную обработку, он может продолжить бронирование напрямую по
телефону или на сайте отеля.</p>

<h2>Хранение и защита</h2>
<p>Переписка и служебные логи хранятся не дольше 90 дней и затем удаляются. Персональные данные
(телефоны, документы) маскируются в служебных уведомлениях и логах. Передача данных защищена
шифрованием (TLS).</p>

<h2>Права гостя</h2>
<p>Гость может запросить удаление своих персональных данных, написав об этом в чат или на
контактную почту отеля. Запрос обрабатывается сотрудниками отеля.</p>

<h2>Контакты</h2>
<p>По вопросам обработки данных: reservations-отдел соответствующего отеля ${brand.displayName}
(контакты — на <a href="https://${brand.website}">${brand.website}</a>).</p>`,
);

const TERMS = page(
  'Условия использования',
  `<h1>Условия использования</h1>
<p>${brand.displayName} AI — вспомогательный сервис для общения с гостями и бронирования номеров сети отелей
${brand.displayName}. Пользуясь чатом, вы соглашаетесь с настоящими условиями.</p>

<h2>Назначение</h2>
<p>Сервис предоставляет справочную информацию, актуальные наличие и цены (из системы бронирования
отеля) и помогает оформить бронь. Итоговое подтверждение брони и оплаты выполняется через системы
отеля.</p>

<h2>Ограничения</h2>
<p>Сервис — автоматизированный ассистент. В сложных или спорных случаях к диалогу подключается
сотрудник отеля. Цены и наличие подтверждаются на момент бронирования.</p>

<h2>Ответственность</h2>
<p>Оператор стремится к точности информации, но окончательные условия проживания определяются
правилами конкретного отеля ${brand.displayName} и договором с гостем.</p>

<h2>Контакты</h2>
<p>Контакты отелей — на <a href="https://${brand.website}">${brand.website}</a>.</p>`,
);

/** Register /privacy and /terms — required for Meta App Review and generally for the product. */
export function registerLegalRoutes(app: FastifyInstance): void {
  app.get('/privacy', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(PRIVACY),
  );
  app.get('/terms', async (_req, reply) => reply.type('text/html; charset=utf-8').send(TERMS));
}
