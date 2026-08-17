# WhatsApp go-live runbook — 360dialog Coexistence (+7 708 709 3000)

Точный пошаговый план подключения WhatsApp через 360dialog coexistence. Наш webhook
готов: `https://kazzhol.167-233-200-30.sslip.io/webhooks/whatsapp`. Собрано ресёрчем 2026-08.

## Вердикт (проверено)
- **KZ +7 — не заблокирован** (360dialog блок-лист: только Крым/Донецк/Луганск/Куба/Иран/КНДР/Сирия). KZ 70x/77x проходят. Но гейт **per-number**: первый сигнал go/no-go — появится ли на телефоне промпт **«Connect to the Business Platform»**.
- **Бернер сегодня — скорее всего НЕТ.** Coexistence создаёт СВЕЖИЙ WABA под выбранным портфелем, не трогает старый WABA Бернера `1363377080731255`. Бернер нужен ТОЛЬКО если выскочит «This number is registered to an existing WhatsApp account — disconnect it» (тогда + пауза Meta 1-2 мес → сегодня не закончим). **Ничего заранее не удаляем.**
- **Линчпин:** на шаге портфеля Meta выбрать **СВОЙ портфель владельца**, НЕ Бернера (`373990573160727`). Выбор необратим.

## Часть A — аккаунт 360dialog (удалённо, сейчас)
1. **app.360dialog.com** → Email + Password → Continue.
2. Выбрать **Direct API Access** (не Marketplace/Plug&Play) — только он даёт сырой D360-API-KEY.
3. Подтвердить почту (письмо от support@360dialog.com → «Verify Your Account»).
4. Company Info: **Country = Kazakhstan** + Accept ToS.
5. Pricing Plan → Billing Info → **привязать карту (Visa/MC/AMEX, обязательна до добавления номера)**.
6. Проверка: кнопка **«Add number»** активна.

Нужно: карта, бизнес-email, реквизиты компании (юр.название/адрес/город/индекс).

## Часть B — на месте у телефона ресепшена: QR
**B0. Подготовка телефона ДО запуска:**
- WhatsApp Business App **≥ 2.24.17**.
- Номер живой в приложении сейчас (шлёт/принимает).
- **Финальные фото профиля + бизнес-название выставить сейчас** (после — блокируются).
- Settings → Account → Business Platform: если «Connected» → **Disconnect** (безопасно). Если пусто — не трогать.
- ⛔ **«Delete my account» НЕ нажимать никогда.**

**B1. В Hub (ноутбук):** Add number → тариф → ввести **+7 708 709 3000** → «номер используется?» → **«Yes, Business App»** → «есть Facebook?» → Yes → **Open Meta Signup**.

**B2. Окно Meta:** login → Get started → **выбрать СВОЙ портфель (НЕ Бернера!)** → дать Meta создать **НОВЫЙ WABA** → номер → **«Connect a WhatsApp Business App»**.
⚠️ Если шлёт SMS/6-значный код — это НЕ тот путь, назад → снова «Yes, Business App».

**B3. QR (главное):** это НЕ «Связанные устройства». Это поток **«Connect to the Business Platform»**:
- На ноуте появляется QR.
- На телефоне за ~1 мин приходит сообщение от Meta/Facebook Business → открыть → **Connect → Connect to the Business Platform** (или вручную Settings → Business tools → Business Platform).
- Выбор истории: **Share all chats** → Confirm.
- Открывается камера → навести на QR с ноута. Пэйринг 2-3 мин, телефон разблокирован, Wi-Fi стабильный.
- Дожать Confirm/Finish → в Hub номер = **Connected**.

**GO/NO-GO для KZ:** если промпт «Connect to the Business Platform» не появился — номер не прошёл per-number проверку (нужно несколько дней активности, повтор).

## Часть C — я подключаю нашу сторону
1. Забираю **D360-API-KEY** (Hub → Channels → канал → API Settings → Generate API Key, показывается 1 раз).
2. Ставлю webhook (ключ ДО webhook):
   `POST https://waba-v2.360dialog.io/v1/configs/webhook` (header `D360-API-KEY`, body `{"url":"https://kazzhol.167-233-200-30.sslip.io/webhooks/whatsapp"}`) → жду 201.
3. `.env` на VPS: `WHATSAPP_PROVIDER=d360`, `WHATSAPP_ACCESS_TOKEN=<D360-API-KEY>`, `WHATSAPP_PHONE_ID_ALMATY=<новый phone_number_id>`, `WHATSAPP_APP_SECRET=` (ПУСТО — d360 не подписывает Meta-подписью).
4. Перезапуск бота → тест входящего (с другого телефона на номер → POST в логах) → тест исходящего.

Код уже готов (провайдер d360 в `src/channels/whatsapp.ts`: POST `waba-v2.360dialog.io/messages`, header D360-API-KEY; парсер ловит `smb_message_echoes` от ручных ответов ресепшена).

## Playbook ошибок
| Ошибка | Фикс | Бернер? |
|---|---|---|
| «registered to an existing WhatsApp account — disconnect it» | app → Settings → Account → Business Platform → Disconnect, ~3 мин, повтор; иначе отвязать от старого WABA | ДА (+пауза 1-2 мес) |
| «Country/region not supported» | форсировать нельзя; повтор после дня активности; иначе fallback | нет |
| промпт «Connect to Business Platform» не появился | несколько дней реальной переписки, повтор | нет |
| «max partners already assigned» | убедиться что выбран «Yes, Business App» (свежий WABA) | нет |
| «cannot onboard customers at this time» | Integrated Onboarding / саппорт 360dialog | нет |
| экран шлёт SMS-код | назад → «Yes, Business App» | нет |
| «Error while pairing / No WABA scope» после QR | повтор / саппорт 360dialog | нет |

⚠️ «disconnect from existing account» ≠ «Delete my account» в приложении. Delete — НИКОГДА.

## Что нужно от владельца, чтобы начать сегодня
1. Карта (Visa/MC/AMEX).
2. Бизнес-email + реквизиты компании.
3. Телефон ресепшена сегодня в руках (обновлённый app, номер живой, фото/название выставлены).
4. Использовать СВОЙ портфель Meta (не Бернера).
5. Бернер на связи — только как fallback на ошибку «disconnect it».
