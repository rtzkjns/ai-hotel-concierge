import { describe, expect, it } from 'vitest';
import { WhatsAppAdapter } from '../src/channels/whatsapp';

// Coexistence-only webhook shapes: staff replies echoed from the WhatsApp Business
// app (message_echoes) and account lifecycle events (account_update). These must be
// parsed by the dedicated methods and NEVER leak into parseWebhook's guest stream.
const adapter = new WhatsAppAdapter({ accessToken: 'x', phoneNumberIds: { almaty: 'PID1' } });

const echoBody = {
  entry: [
    {
      changes: [
        {
          field: 'smb_message_echoes',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: 'PID1' },
            message_echoes: [
              { to: '77010001122', id: 'wamid.ECHO1', type: 'text', text: { body: 'Здравствуйте, номер свободен!' } },
            ],
          },
        },
      ],
    },
  ],
};

const accountUpdateBody = {
  entry: [
    {
      changes: [
        {
          field: 'account_update',
          value: { event: 'PARTNER_REMOVED', metadata: { phone_number_id: 'PID1' } },
        },
      ],
    },
  ],
};

describe('WhatsApp Coexistence parsing', () => {
  it('parseSmbEchoes extracts a staff reply echoed from the Business app', () => {
    const echoes = adapter.parseSmbEchoes(echoBody);
    expect(echoes).toEqual([
      { phoneNumberId: 'PID1', guestWaId: '77010001122', text: 'Здравствуйте, номер свободен!', echoId: 'wamid.ECHO1' },
    ]);
  });

  it('parseSmbEchoes also reads the message_echoes alias and tolerates junk', () => {
    expect(adapter.parseSmbEchoes({})).toEqual([]);
    expect(adapter.parseSmbEchoes({ entry: [{ changes: [{ value: { message_echoes: 'nope' } }] }] })).toEqual([]);
    // An echo missing `to` is skipped, not thrown on.
    const partial = { entry: [{ changes: [{ value: { metadata: { phone_number_id: 'PID1' }, message_echoes: [{ id: 'x' }] } }] }] };
    expect(adapter.parseSmbEchoes(partial)).toEqual([]);
  });

  it('parseAccountUpdates surfaces PARTNER_REMOVED', () => {
    expect(adapter.parseAccountUpdates(accountUpdateBody)).toEqual([
      { event: 'PARTNER_REMOVED', phoneNumberId: 'PID1' },
    ]);
    expect(adapter.parseAccountUpdates({})).toEqual([]);
  });

  it('parseWebhook (guest stream) ignores echoes and account updates', () => {
    expect(adapter.parseWebhook(echoBody)).toEqual([]);
    expect(adapter.parseWebhook(accountUpdateBody)).toEqual([]);
  });
});
