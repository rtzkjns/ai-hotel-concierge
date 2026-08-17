# Instagram Direct — рануук запуска

**Статус кода: ГОТОВ.** Приём/отправка DM, вебхук `/webhooks/instagram` (verify + проверка подписи),
мульти-аккаунт (один IG на отель → маршрутизация в нужный отель), byte-safe разбивка длинных ответов,
`is_echo`-guard, 229 тестов зелёные. Ядро ИИ + Exely — те же, что в WhatsApp (канало-независимы).

**Что осталось — не код, а подключение Meta + App Review.** Ниже — точные шаги. Путь 2026:
**«Instagram API with Instagram Login»**, host `graph.instagram.com`, Graph **v26.0** (v23/v24 отключены).
Facebook-страница НЕ нужна — только профессиональный (Business/Creator) IG-аккаунт отеля.

---

## Часть A. Что можно сделать УЖЕ СЕЙЧАС (без App Review, бесплатно)

На **Standard Access** (по умолчанию) бот полностью работает с аккаунтами, у которых есть роль в приложении
(Admin/Developer/**Instagram Tester**, до 25 шт). Значит **весь сквозной сценарий и демо владельцу можно
показать сегодня** на аккаунте отеля + тестерах. Реальным гостям (не-тестерам) бот начнёт отвечать только
после Advanced Access (Часть D).

Локально, без Meta вообще: `ANTHROPIC_API_KEY=… npx tsx scripts/instagram-sandbox.mts` — реальный движок,
мок-адаптер, видно ответы бота на тестовый DM.

---

## Часть B. Настройка Meta (владелец, полный доступ к portfolio есть)

1. **Meta-приложение** на developers.facebook.com → тип **Business**. (Можно то же приложение, что для WhatsApp.)
2. **Продукт «Instagram»** → **Instagram → API setup with Instagram business login**.
2b. **⚠️ Скопировать Instagram App ID + Instagram App Secret** из «Set up Instagram business login → Business
   login settings» — это ОТДЕЛЬНЫЕ значения, **НЕ** Meta App ID `3752237891585459` (иначе OAuth падает 400).
   Прописать в `.env` как `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET`; там же добавить OAuth Redirect URI.
3. **Подключить аккаунт (по одному на отель, ×4):** «Add account» → всплывает instagram.com → войти под логином
   ИМЕННО этого отеля → пройти checkpoint (код с почты/SMS, если попросят) → нажать «Allow». Аккаунты:
   `Kazzhol_almaty_hotel`, `Kazzholpark_almaty_hotel`, `kazzhol_astana_hotel`, `kazzhol_seven_almaty`.
   Scopes: **`instagram_business_basic` + `instagram_business_manage_messages`**.
   ⚠️ **Логин делать ВРУЧНУЮ в браузере владельца — НЕ headless-скриптом** (Meta детектит ботов и может
   заблокировать аккаунты отелей). Лайфхак: сперва зайди в каждый аккаунт обычным образом на том же
   устройстве/IP — тогда popup часто пропускает пароль, остаётся только «Allow».
4. **Токен:** взять сгенерированный токен → прогнать нашим скриптом до 60-дневного (Часть C).
5. **Вебхук** (App Dashboard → Webhooks, объект **Instagram**):
   - Callback URL: `https://<наш-домен>/webhooks/instagram`
   - Verify Token: значение `WHATSAPP_VERIFY_TOKEN` (вебхук IG делит verify-token и app-secret с WhatsApp — одно приложение)
   - Подписаться на поле **`messages`** (опц. `messaging_postbacks`).
6. **⚠️ Подписать приложение на КАЖДЫЙ аккаунт** (пункт, который все забывают — без него события не приходят):
   `scripts/instagram-connect.mts subscribe <IG_ID> <TOKEN>` (делает `POST /<IG_ID>/subscribed_apps`).
7. **⚠️ Тумблер на самом IG-аккаунте:** приложение Instagram → Настройки → Сообщения → Message controls →
   Connected Tools → **«Allow access to messages» = ВКЛ**. Если выкл — DM молча не приходят.
8. **Тестеры (dev-фаза):** App Roles → Instagram Tester → ввести username → тестер принимает инвайт в приложении Instagram.

---

## Часть C. Что вписать в наш `.env` (VPS)

```
INSTAGRAM_ACCESS_TOKEN=<долгоживущий IG user token>
INSTAGRAM_IG_ID_ALMATY=<ig id аккаунта Алматы>
INSTAGRAM_IG_ID_ASTANA=<ig id аккаунта Астаны>
INSTAGRAM_IG_ID_PARK_ALMATY=<ig id аккаунта Park>
# INSTAGRAM_API_BASE=https://graph.instagram.com/v26.0   # дефолт, менять не нужно
```
`recipient.id` из вебхука (= id аккаунта отеля) сам маршрутизирует диалог в нужный отель. `WHATSAPP_VERIFY_TOKEN`
и `WHATSAPP_APP_SECRET` уже используются вебхуком IG (одно Meta-приложение) — **обязательно задать app-secret**,
иначе подпись не проверяется. Перезапустить бота — канал `instagram` включится автоматически (`enabledChannels`).

**Помощник по токенам** (`scripts/instagram-connect.mts`, читает `INSTAGRAM_APP_ID`/`INSTAGRAM_APP_SECRET`,
с фолбэком на `WHATSAPP_APP_ID`/`WHATSAPP_APP_SECRET`):
```
npx tsx scripts/instagram-connect.mts exchange-code <CODE> <REDIRECT_URI>   # code → короткий токен + user_id
npx tsx scripts/instagram-connect.mts long-lived     <SHORT_TOKEN>          # короткий → 60-дневный
npx tsx scripts/instagram-connect.mts refresh        <LONG_TOKEN>           # продлить на 60 дней
npx tsx scripts/instagram-connect.mts subscribe      <IG_ID> <TOKEN>        # подписать аккаунт на messages
```

---

## Часть D. App Review — для публичного запуска (реальные гости)

Как только бот пишет **не-тестеру**, нужен **Advanced Access на `instagram_business_manage_messages`**:
- **App Review**: письменное обоснование юзкейса (B2C-поддержка гостей отеля) + **скринкаст реального диалога**
  поддержки через бота + живой проверенный вебхук.
- **Business Verification** портфолио — обязательна до одобрения Advanced Access.
- Перевести приложение в **Live mode**.
- Срок: официально ~5–10 раб. дней, по свежим отчётам Meta сигналит **~20 дней** — **запускать ревью заранее.**
- Частые отказы: личный (не Business) аккаунт в демо; лишние права; невнятный скринкаст без реального диалога;
  неживой вебхук.

---

## Часть E. Эксплуатация

- **Refresh токена — критично.** 60-дневный токен НЕ обновляется сам; пролежал >60 дней → умирает навсегда.
  Поставить крон каждые ~30–45 дней: `npx tsx scripts/instagram-connect.mts refresh <LONG_TOKEN>` → вписать
  новый токен в `.env` → рестарт. (По образцу `deploy/kazzhol-backup.timer`.)
- **Окно 24 часа:** бот отвечает только в пределах 24ч с последнего сообщения гостя. Наш бот **только отвечает**
  (никогда не пишет первым) → в окне всегда, ничего доделывать не надо. Холодные рассылки в IG запрещены.
- **Rate limit:** авто-сообщения ~200/час на аккаунт, ~2 req/сек. Для DM отеля с запасом; при 429 — backoff.

---

## Топ причин «DM не приходят» (по убыванию частоты)
1. Тумблер «Allow access to messages» на IG-аккаунте ВЫКЛ.
2. Аккаунт всё ещё Personal, а не Professional/Business.
3. Не вызван `subscribed_apps` для аккаунта (галочки поля в дашборде мало) → шаг B6.
4. GET-верификация вебхука провалена (несовпадение verify-token / не-HTTPS).
5. Отправка не-тестеру на Standard Access (нужен Advanced Access → Часть D).
6. Просроченный 60-дневный токен без refresh.

---

## Итог
- **Сегодня:** подключаем аккаунты отелей (Часть B), вписываем env (Часть C) → бот **живой в dev-mode**,
  отвечает тестерам end-to-end. Демо владельцу — готово.
- **Параллельно:** App Review + Business Verification (Часть D) — единственный внешний блокер до обслуживания
  реальных гостей. ~20 дней → **начинать сразу.**
