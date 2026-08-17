import { describe, it, expect, vi } from 'vitest';
import { generateReply, type AnthropicLike, type ToolHandlers } from '../src/ai/orchestrator';
import { toolDefinitions } from '../src/ai/tools';
import { StubPaymentGateway } from '../src/integrations/payments';
import { StubAmoCrm } from '../src/integrations/amocrm';
import type { ChatMessage } from '../src/types';

const history: ChatMessage[] = [{ role: 'user', content: 'Where are you located?' }];

function fakeClient(responses: unknown[]): AnthropicLike {
  let i = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        if (i >= responses.length) throw new Error('fake client ran out of scripted responses');
        return responses[i++] as never;
      }),
    },
  };
}

function toolUse(name: string, input: unknown, id = 't1'): unknown {
  return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] };
}

const finalText = (text: string): unknown => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
});

const noTools: ToolHandlers = {};

describe('tool definitions', () => {
  it('declares the full TZ1 tool set', () => {
    const names = toolDefinitions.map((t) => t.name);
    expect(names).toEqual([
      'check_availability',
      'get_room_info',
      'create_booking',
      'get_booking_status',
      'cancel_booking',
      'check_promo_code',
      'create_payment',
      'submit_mice_request',
      // Гость оформляет бронь сам по ссылке, а Reservation-scope закрыт (403) — этот инструмент
      // единственный способ зафиксировать факт брони и подтвердить его гостю.
      'register_completed_booking',
      'capture_lead',
      'escalate_to_human',
    ]);
  });
});

describe('generateReply', () => {
  it('returns plain text when the model does not call a tool', async () => {
    const client = fakeClient([finalText('We are 10 minutes from Bayterek.')]);
    const result = await generateReply(history, {
      client,
      model: 'm',
      systemPrompt: 's',
      tools: noTools,
    });
    expect(result.reply).toBe('We are 10 minutes from Bayterek.');
    expect(result.handedOff).toBe(false);
    expect(result.toolsUsed).toEqual([]);
  });

  it('round-trips a tool call: handler input passed through, result JSON fed back', async () => {
    const captureLead = vi.fn(async () => ({ ok: true, leadId: 42 }));
    const client = fakeClient([
      toolUse('capture_lead', { summary: 'Guest asks about pets', contactName: 'Aibek' }),
      finalText('Уточню у коллег, вернусь.'),
    ]);
    const result = await generateReply(history, {
      client,
      model: 'm',
      systemPrompt: 's',
      tools: { capture_lead: captureLead },
    });
    expect(captureLead).toHaveBeenCalledWith({ summary: 'Guest asks about pets', contactName: 'Aibek' });
    expect(result.reply).toBe('Уточню у коллег, вернусь.');
    expect(result.toolsUsed).toEqual(['capture_lead']);

    // Second model call must carry the JSON.stringify'd handler result as tool_result.
    const create = client.messages.create as ReturnType<typeof vi.fn>;
    const secondCall = create.mock.calls[1][0];
    const lastMsg = secondCall.messages.at(-1);
    expect(lastMsg.content[0].type).toBe('tool_result');
    expect(lastMsg.content[0].tool_use_id).toBe('t1');
    expect(lastMsg.content[0].content).toBe(JSON.stringify({ ok: true, leadId: 42 }));
  });

  it('handles multiple tool_use blocks in one assistant turn (multi-part requests)', async () => {
    const checkAvailability = vi.fn(async () => ({ offers: [] }));
    const getRoomInfo = vi.fn(async () => ({ rooms: 'Standard, Comfort' }));
    const client = fakeClient([
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'a', name: 'check_availability', input: { checkIn: '2026-08-01', checkOut: '2026-08-03', guests: 2 } },
          { type: 'tool_use', id: 'b', name: 'get_room_info', input: { topic: 'rooms' } },
        ],
      },
      finalText('По датам вот что.'),
    ]);
    const result = await generateReply(history, {
      client,
      model: 'm',
      systemPrompt: 's',
      tools: { check_availability: checkAvailability, get_room_info: getRoomInfo },
    });
    expect(checkAvailability).toHaveBeenCalledTimes(1);
    expect(getRoomInfo).toHaveBeenCalledTimes(1);
    expect(result.toolsUsed).toEqual(['check_availability', 'get_room_info']);
    const create = client.messages.create as ReturnType<typeof vi.fn>;
    const results = create.mock.calls[1][0].messages.at(-1).content;
    expect(results).toHaveLength(2);
  });

  it('a throwing handler becomes an is_error tool_result and the reply still arrives', async () => {
    const boom = vi.fn(async () => {
      throw new Error('Exely timeout');
    });
    const client = fakeClient([
      toolUse('check_availability', { checkIn: '2026-08-01', checkOut: '2026-08-03', guests: 2 }),
      finalText('Секунду, что-то с системой — сейчас перепроверю.'),
    ]);
    const result = await generateReply(history, {
      client,
      model: 'm',
      systemPrompt: 's',
      tools: { check_availability: boom },
    });
    expect(result.reply).toBe('Секунду, что-то с системой — сейчас перепроверю.');
    const create = client.messages.create as ReturnType<typeof vi.fn>;
    const toolResult = create.mock.calls[1][0].messages.at(-1).content[0];
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toBe(JSON.stringify({ error: 'Exely timeout' }));
  });

  it('blocks cancel_booking without guest confirmation BEFORE the handler runs', async () => {
    const cancel = vi.fn(async () => ({ ok: true }));
    const client = fakeClient([
      toolUse('cancel_booking', { bookingNumber: 'B-1', reason: 'plans changed', confirmedByGuest: false }),
      finalText('Подтвердите, пожалуйста, что точно отменяем.'),
    ]);
    const result = await generateReply(history, {
      client,
      model: 'm',
      systemPrompt: 's',
      tools: { cancel_booking: cancel },
    });
    expect(cancel).not.toHaveBeenCalled();
    const create = client.messages.create as ReturnType<typeof vi.fn>;
    const toolResult = create.mock.calls[1][0].messages.at(-1).content[0];
    expect(String(toolResult.content)).toContain('CONFIRMATION_REQUIRED');
    expect(result.reply).toBe('Подтвердите, пожалуйста, что точно отменяем.');
  });

  it('runs cancel_booking when the guest has confirmed', async () => {
    const cancel = vi.fn(async () => ({ ok: true, status: 'cancelled' }));
    const client = fakeClient([
      toolUse('cancel_booking', { bookingNumber: 'B-1', reason: 'plans changed', confirmedByGuest: true }),
      finalText('Готово, бронь отменил.'),
    ]);
    await generateReply(history, {
      client,
      model: 'm',
      systemPrompt: 's',
      tools: { cancel_booking: cancel },
    });
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({ bookingNumber: 'B-1', confirmedByGuest: true }),
    );
  });

  it('marks handedOff after escalate_to_human runs', async () => {
    const escalate = vi.fn(async () => ({ ok: true }));
    const client = fakeClient([
      toolUse('escalate_to_human', {
        reason: 'complaint',
        summary: 'Guest unhappy with noise',
        type: 'complaint',
      }),
      finalText('Передал коллегам, сейчас подключатся.'),
    ]);
    const result = await generateReply(history, {
      client,
      model: 'm',
      systemPrompt: 's',
      tools: { escalate_to_human: escalate },
    });
    expect(escalate).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'complaint', type: 'complaint' }),
    );
    expect(result.handedOff).toBe(true);
    expect(result.toolsUsed).toEqual(['escalate_to_human']);
  });

  it('answers an unknown tool with "Unknown tool" and keeps going', async () => {
    const client = fakeClient([
      toolUse('do_magic', { spell: 'abracadabra' }),
      finalText('Могу помочь с отелем — что подсказать?'),
    ]);
    const result = await generateReply(history, {
      client,
      model: 'm',
      systemPrompt: 's',
      tools: noTools,
    });
    const create = client.messages.create as ReturnType<typeof vi.fn>;
    const toolResult = create.mock.calls[1][0].messages.at(-1).content[0];
    expect(toolResult.content).toBe('Unknown tool');
    expect(result.reply).toBe('Могу помочь с отелем — что подсказать?');
    expect(result.toolsUsed).toEqual([]);
  });

  it('caps the tool loop at 8 rounds', async () => {
    const responses = Array.from({ length: 10 }, (_, i) =>
      toolUse('get_room_info', { topic: 'rooms' }, `t${i}`),
    );
    const client = fakeClient(responses);
    const result = await generateReply(history, {
      client,
      model: 'm',
      systemPrompt: 's',
      tools: { get_room_info: async () => ({ rooms: [] }) },
    });
    expect((client.messages.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(8);
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.toolsUsed).toHaveLength(8);
  });
});

describe('integration stubs', () => {
  it('StubPaymentGateway is honestly unconfigured', async () => {
    const gw = new StubPaymentGateway();
    await expect(gw.createPayment('B-1', 50000)).resolves.toEqual({
      ok: false,
      error: 'PAYMENT_GATEWAY_NOT_CONFIGURED',
    });
    await expect(gw.checkStatus('p1')).resolves.toEqual({
      ok: false,
      error: 'PAYMENT_GATEWAY_NOT_CONFIGURED',
    });
  });

  it('StubAmoCrm records a crm_lead_stub event and reports ok', async () => {
    const recordEvent = vi.fn();
    const crm = new StubAmoCrm(recordEvent);
    await expect(crm.createLead('mice', { peopleCount: 50 })).resolves.toEqual({ ok: true });
    expect(recordEvent).toHaveBeenCalledWith('crm_lead_stub', {
      kind: 'mice',
      data: { peopleCount: 50 },
    });
    await expect(crm.updateStatus('c1', 'won')).resolves.toEqual({ ok: true });
  });
});
