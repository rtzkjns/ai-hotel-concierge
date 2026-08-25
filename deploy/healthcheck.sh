#!/usr/bin/env bash
# Ежедневная проверка живости всех внешних зависимостей бота.
# Молчит, когда всё хорошо; пишет в Telegram персоналу, когда что-то отвалилось.
# Смысл: токены Instagram и доступы могут умереть тихо (блокировка приложения, отзыв прав,
# протухший ключ) — и мы узнаем об этом от гостя, а не от системы. Теперь узнаем сразу.
set -uo pipefail
cd /opt/kazzhol-ai || exit 1
ENV=/opt/kazzhol-ai/.env
PROBLEMS=""

add() { PROBLEMS="${PROBLEMS}
• $1"; }

# --- Instagram: токен жив и право на отправку не отозвано ---
#
# Пустой ответ и отвергнутый токен — РАЗНЫЕ вещи, и путать их нельзя. Meta периодически
# глушит запросы на часы и просто не отвечает; сторож называл это «токен НЕ работает» и
# поднимал владельца среди дня из-за сетевой заминки. Токены при этом были живы — проверено.
# Поэтому: одна повторная попытка, и тревога только когда Meta ЯВНО что-то ответила.
IG_USERNAME='import sys,json
try: print(json.load(sys.stdin).get("username",""))
except Exception: print("")'
IG_ERROR='import sys,json
try: print(json.load(sys.stdin).get("error",{}).get("message",""))
except Exception: print("")'
IG_SUBS='import sys,json
try: print("ok" if json.load(sys.stdin).get("data") else "no")
except Exception: print("skip")'

for H in ALMATY ASTANA PARK_ALMATY SEVEN; do
  T=$(grep "^INSTAGRAM_TOKEN_${H}=" "$ENV" | cut -d= -f2-)
  [ -z "$T" ] && continue

  ME=$(curl -s -m 20 "https://graph.instagram.com/v26.0/me?fields=username&access_token=${T}")
  U=$(printf '%s' "$ME" | python3 -c "$IG_USERNAME" 2>/dev/null)
  if [ -z "$U" ]; then
    sleep 15
    ME=$(curl -s -m 20 "https://graph.instagram.com/v26.0/me?fields=username&access_token=${T}")
    U=$(printf '%s' "$ME" | python3 -c "$IG_USERNAME" 2>/dev/null)
  fi

  if [ -z "$U" ]; then
    ERR=$(printf '%s' "$ME" | python3 -c "$IG_ERROR" 2>/dev/null)
    if [ -n "$ERR" ]; then
      add "Instagram ${H}: токен отвергнут — ${ERR}"
    else
      add "Instagram ${H}: Meta не ответила дважды подряд — проверьте, отвечает ли бот в директе"
    fi
    continue
  fi

  SUB=$(curl -s -m 20 "https://graph.instagram.com/v26.0/me/subscribed_apps?access_token=${T}" | python3 -c "$IG_SUBS" 2>/dev/null)
  # «skip» — это тоже отсутствие ответа, а не слетевшая подписка.
  if [ "$SUB" = "no" ]; then
    add "Instagram ${H} (${U}): ПОДПИСКА НА ВХОДЯЩИЕ СЛЕТЕЛА — гости пишут, бот не видит"
  fi
done

# --- Exely: авторизация по каждому кабинету ---
exely() {
  local K=$1 S=$2 N=$3
  [ -z "$K" ] && return
  TOK=$(curl -s -m 20 -X POST https://connect.hopenapi.com/auth/token \
    -d grant_type=client_credentials -d "client_id=${K}" -d "client_secret=${S}" \
    | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("access_token",""))
except Exception: print("")' 2>/dev/null)
  [ -z "$TOK" ] && add "Exely ${N}: авторизация НЕ проходит — цены и ссылки на бронь недоступны"
}
exely "$(grep '^EXELY_CLIENT_ID=' "$ENV" | cut -d= -f2-)" "$(grep '^EXELY_CLIENT_SECRET=' "$ENV" | cut -d= -f2-)" "Алматы"
exely "$(grep '^EXELY_ASTANA_CLIENT_ID=' "$ENV" | cut -d= -f2-)" "$(grep '^EXELY_ASTANA_CLIENT_SECRET=' "$ENV" | cut -d= -f2-)" "Астана"
exely "$(grep '^EXELY_PARK_ALMATY_CLIENT_ID=' "$ENV" | cut -d= -f2-)" "$(grep '^EXELY_PARK_ALMATY_CLIENT_SECRET=' "$ENV" | cut -d= -f2-)" "Park"

# --- Модель: без неё бот молчит ---
AK=$(grep '^ANTHROPIC_API_KEY=' "$ENV" | cut -d= -f2-)
AC=$(curl -s -m 25 -o /dev/null -w '%{http_code}' -X POST https://api.anthropic.com/v1/messages \
  -H "x-api-key: ${AK}" -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-5","max_tokens":4,"messages":[{"role":"user","content":"hi"}]}')
[ "$AC" != "200" ] && add "Anthropic API: HTTP ${AC} — бот не сможет отвечать (кончились средства или ключ отозван)"

# --- Сам сервис и сайт ---
systemctl is-active --quiet kazzhol-bot || add "Сервис kazzhol-bot НЕ запущен"
HC=$(curl -s -m 15 -o /dev/null -w '%{http_code}' https://kazzhol.128-140-86-176.sslip.io/healthz)
[ "$HC" != "200" ] && add "Сайт бота не отвечает: HTTP ${HC}"

# Caddy — единственный вход снаружи. Если он лёг, недоступны вебхуки каналов, админ-панель
# и ссылки на подтверждение брони, уже разосланные гостям. Сам бот при этом жив и молчит.
if ! systemctl is-active --quiet caddy; then
  add "Caddy НЕ запущен — снаружи недоступно ВСЁ: вебхуки, панель, ссылки на бронь"
fi

# Отказ отправки Meta не виден проверкой токена: токен жив, а отправлять запрещено.
# Ловим по журналу самой службы — лишних запросов к Meta это не добавляет.
#
# Окно НАМЕРЕННО узкое — час, а не сутки. Скользящие сутки означают, что уже
# исправленная поломка кричит ещё двадцать четыре часа, и на этом фоне перестаёшь
# верить тревогам вообще. Час отвечает на вопрос «происходит ли это ПРЯМО СЕЙЧАС».
FAILS=$(journalctl -u kazzhol-bot --since -1h --no-pager 2>/dev/null | grep -c "НЕ доставлен\|send failed" || true)
if [ "${FAILS:-0}" -gt 0 ]; then
  add "Ответы гостям не доставлялись за последний час: ${FAILS} раз — проверьте журнал"
fi

# Про подпись вебхуков ТРЕВОГИ НЕТ намеренно.
#
# Она звучала как «секрет приложения неверный», но секрет верный — владелец подтвердил его
# дважды, и другого у проекта нет. Почему Meta подписывает иначе, выяснить пока не удалось;
# на форуме Meta есть тред ровно с этим симптомом без ответа. Это открытый вопрос, а не
# поломка: гости отвечаются, брони проходят. Слать владельцу каждые полчаса тревогу, по
# которой он ничего не может сделать, — верный способ добиться, чтобы он перестал читать и
# настоящие. Несовпадения по-прежнему пишутся в журнал и в события, и их видно по запросу.

# --- Отчёт ---
if [ -n "$PROBLEMS" ]; then
  TG=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV" | cut -d= -f2-)
  CHAT=$(grep '^STAFF_GROUP_CHAT_ID=' "$ENV" | cut -d= -f2-)
  MSG="🚨 Kazzhol AI — проверка показала проблемы:${PROBLEMS}

Проверено: $(date -u '+%Y-%m-%d %H:%M') UTC"
  echo "$MSG"
  if [ -n "$TG" ] && [ -n "$CHAT" ]; then
    curl -s -m 20 -X POST "https://api.telegram.org/bot${TG}/sendMessage" \
      --data-urlencode "chat_id=${CHAT}" --data-urlencode "text=${MSG}" >/dev/null
  fi
  exit 1
fi
echo "все внешние зависимости живы"
