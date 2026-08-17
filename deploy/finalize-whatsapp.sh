#!/usr/bin/env bash
# finalize-whatsapp.sh <D360-API-KEY> <phone_number_id> [test_recipient_msisdn]
#
# Run this AFTER the 360dialog coexistence onboarding is done (number Connected in
# the 360dialog Hub). It wires the already-deployed bot to WhatsApp in one shot:
#   1. sets OUR webhook in 360dialog, 2. flips .env to the d360 provider,
#   3. restarts the bot, 4. health-checks, 5. (optional) sends a test message.
# See docs/WHATSAPP-GOLIVE-RUNBOOK.md.
set -euo pipefail

KEY="${1:?usage: finalize-whatsapp.sh <D360-API-KEY> <phone_number_id> [test_recipient]}"
PHONE_ID="${2:?need the phone_number_id shown in the 360dialog Hub}"
TEST="${3:-}"
ENV=/opt/kazzhol-ai/.env
WEBHOOK="https://kazzhol.167-233-200-30.sslip.io/webhooks/whatsapp"

echo "==> 1/5 set webhook in 360dialog"
curl -fsS -X POST https://waba-v2.360dialog.io/v1/configs/webhook \
  -H "D360-API-KEY: $KEY" -H "Content-Type: application/json" \
  -d "{\"url\":\"$WEBHOOK\"}" && echo " ...webhook set"

echo "==> 2/5 update .env (d360 provider)"
sed -i '/^WHATSAPP_PROVIDER=/d;/^WHATSAPP_ACCESS_TOKEN=/d;/^WHATSAPP_PHONE_ID_ALMATY=/d;/^WHATSAPP_APP_SECRET=/d' "$ENV"
{
  echo "WHATSAPP_PROVIDER=d360"
  echo "WHATSAPP_ACCESS_TOKEN=$KEY"
  echo "WHATSAPP_PHONE_ID_ALMATY=$PHONE_ID"
  echo "WHATSAPP_APP_SECRET="
} >> "$ENV"
chown kazzhol:kazzhol "$ENV"; chmod 600 "$ENV"

echo "==> 3/5 restart bot"
systemctl restart kazzhol-bot
sleep 5
echo " ...active: $(systemctl is-active kazzhol-bot)"

echo "==> 4/5 health"
curl -fsS http://127.0.0.1:3000/healthz && echo " ...ok"

echo "==> 5/5 test outbound (optional)"
if [ -n "$TEST" ]; then
  curl -fsS -X POST https://waba-v2.360dialog.io/messages \
    -H "D360-API-KEY: $KEY" -H "Content-Type: application/json" \
    -d "{\"messaging_product\":\"whatsapp\",\"to\":\"$TEST\",\"type\":\"text\",\"text\":{\"body\":\"Kazzhol: WhatsApp подключён ✅\"}}" \
    && echo " ...test message sent to $TEST"
else
  echo " (no test recipient given — skip)"
fi
echo "DONE — WhatsApp is live on the bot."
