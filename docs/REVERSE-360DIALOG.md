# Реверс 360dialog: как обойти BSP и подключиться к WhatsApp самим ($0/мес)

Разбор, что именно 360dialog делает поверх Meta, и **набор в репо, который это заменяет**.
Итог многораундового реверс-инжиниринга с адверсариальной проверкой (2026-07).

## Вердикт
**360dialog обходится на 100% ($0/мес recurring) — проприетарного в нём ничего нет.** Это тонкая
обёртка над публичным механизмом Meta (Embedded Signup + Cloud API + Coexistence): каждый шаг ложится
на документированный Graph API вызов, а €49/мес — это наценка за удобство.

**Но есть ОДИН реальный гейт — и это Meta, а не 360dialog:** чтобы QR-спаривание Coexistence физически
завершилось, наше приложение должно быть **одобренным Tech Provider** = Business Verification + App Review
на Advanced Access для `whatsapp_business_management` и `whatsapp_business_messaging`. Бесплатно и self-serve,
но разовый барьер на **дни–недели** с риском отказа. Подтверждено полевыми провалами (Chatwoot
#13471/#13899/#14690: неодобренные собственные приложения доходят до QR и падают — Meta молча вырезает
WABA-скоупы из токена → «No WABA scope found in token»; заработало «после того как стали Tech Provider»).

Вывод: мы заменяем 360dialog, **становясь Tech Provider сами**, а не пропуская этот статус.

## Реверс по слоям (что реплицируем vs барьер)

| Слой 360dialog | Что это на Meta | Наша реплика |
|---|---|---|
| «Pre-approved Tech Provider» | Business Verification + App Review (2 whatsapp-скоупа) | **Единственный барьер.** Проходим сами, бесплатно |
| Хостинг Embedded Signup + `config_id` | `FB.login()` с нашим config_id | `scripts/onboard-whatsapp.html` — $0 |
| QR-спаривание | Только внутри iframe Meta ES (нет Graph-эндпоинта) | Встраиваем компонент Meta — $0, не актив 360dialog |
| Прокси `waba-v2.360dialog.io/messages` | Зеркало Cloud API (заголовок `D360-API-KEY`) | Устранён — бот шлёт напрямую `graph.facebook.com/.../messages` с `Bearer` (уже в `whatsapp.ts`) |
| Backend: OAuth, discovery, подписка, sync | `GET /oauth/access_token`, `GET /{WABA}/phone_numbers`, `POST /{WABA}/subscribed_apps`, `POST /{PHONE}/smb_app_data` | `scripts/onboard-whatsapp.ts` — $0 |
| Биллинг в тенге / кредитная линия | Только BSP держит постоплату в локальной валюте | Привязываем свою карту в WhatsApp Manager (Meta списывает **без наценки**; теряем лишь инвойс в KZT) |
| Support / SLA | Не техническая способность | Self-support + Meta Direct |

**Ключ Coexistence:** `POST /{PHONE}/register` **НЕ вызывается** («номер уже зарегистрирован» — QR-пейринг
это сделал), поэтому Business App остаётся живым (нулевой простой). Доп. вебхук-поля: `smb_message_echoes`
(ответы персонала из приложения зеркалятся к нам), `smb_app_state_sync` (контакты), `history` (до 6 мес).

## Что уже собрано в репо (кит-замена)

- **`scripts/onboard-whatsapp.ts`** (`npm run onboard -- --code <CODE> --waba <WABA>`) — повторяет backend
  360dialog: обмен code→token → **детектор гейта** (`debug_token.granular_scopes`: если скоупы вырезаны —
  стоп с понятным сообщением) → discovery номера → **пропуск `/register`** → `subscribed_apps` (наш вебхук)
  → `smb_app_data` sync → печать готового `.env`.
- **`scripts/onboard-whatsapp.html`** — своя Embedded Signup страница (`FB.login` с нашим `config_id`),
  ловит `code` + `waba_id`, показывает команду. Секрет приложения в браузер не попадает.
- **`src/channels/whatsapp.ts`** — `parseSmbEchoes()` + `parseAccountUpdates()` (+ тесты
  `tests/whatsapp.coexistence.test.ts`): эхо ответов персонала и `PARTNER_REMOVED` теперь распознаются
  и не теряются; в движок как гостевые сообщения не попадают.
- **`.env.example`** — `WHATSAPP_APP_ID`, `WHATSAPP_ES_CONFIG_ID`, `GRAPH_VERSION`.

Провайдер-агностичность (`WHATSAPP_PROVIDER=meta|d360`) уже была — путь отправки Meta-direct готов.

## Что нужно от owner (разово)
- Meta-приложение типа Business в портфолио Kazzhol (продукты WhatsApp + Facebook Login for Business),
  создать ES-конфигурацию с кастомизацией «Onboarding WhatsApp Business app users (Coexistence)» → `config_id`.
- Документы для **Business Verification** + подать **App Review** (Advanced Access на 2 whatsapp-скоупа).
- Живой **скан QR** на телефоне с +7 708 709 3000; карта в WhatsApp Manager.
- **Бизнес Berner (373990573160727)**, владелец старой WABA `1363377080731255`, — доступ приложению Kazzhol.
- **System User** permanent-токен (Business Settings → System Users) → это `WHATSAPP_ACCESS_TOKEN`.

## Оставшиеся риски (номер-специфичные, не про деньги)
1. **Поддержка Казахстана (+7) для Coexistence не подтверждена** — крупнейший бинарный риск (Meta может не
   поддерживать KZ или спутать +7 с РФ). Проверить по live country-checker ДО онбординга.
2. **Легаси ON_PREMISE-хвост** на WABA Бернера → возможная «already registered» + карантин 1–2 мес
   (Coexistence чеканит свежую WABA и, вероятно, обходит; если нет — `POST /{OLD_PHONE}/deregister`).
3. **Периодический backend-блок** Meta «can't onboard customers at the moment» — бьёт даже одобренных TP.

## Рекомендация — параллельно, без риска для линии
1. **Сейчас:** прод на **360dialog** (`WHATSAPP_PROVIDER=d360`) — доверенный floor, отель уходит в бой.
   *(Или дорожка ценности Telegram+веб — вообще без Meta, см. `GO-LIVE-RUNBOOK.md`.)*
2. **Параллельно бесплатно:** проходим self-Tech-Provider App Review (цель миграции).
3. **1-часовой спайк ДО любой резки:** прогнать ES-flow на реальном +7 708 709 3000 → проверить
   `granular_scopes` (шаг 2 скрипта) + KZ-country + `is_on_biz_app`.
4. **Когда TP одобрен и спайк зелёный:** флип `.env` `d360→meta`, отключить 360dialog. **€49 → €0.**
   Деградация обратно к 360dialog — без правок кода (путь `d360` уже в `whatsapp.ts`).

**Не** планировать резку главной линии в расчёте «просто заработает»: режимы отказа тут онбординг-специфичны
и завязаны на конкретный номер, а не на бюджет. Дешёвого доверенного BSP-fallback не существует (Dualhook $12
технически подходит, но нулевая репутация — только пилот на выброшенном номере).
