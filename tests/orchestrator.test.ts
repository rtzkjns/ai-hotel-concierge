import { describe, it, expect, vi } from 'vitest';
import { generateReply, type AnthropicLike } from '../src/ai/orchestrator';
import type { ChatMessage } from '../src/types';

const history: ChatMessage[] = [{ role: 'user', content: 'Where are you located?' }];

function fakeClient(responses: any[]): AnthropicLike {
  let i = 0;
  return { messages: { create: vi.fn(async () => responses[i++]) } };
}

describe('generateReply', () => {
  it('returns plain text when Claude does not call a tool', async () => {
    const client = fakeClient([
      {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'We are 10 minutes from Bayterek.' }],
      },
    ]);
    const result = await generateReply(history, {
      client,
      model: 'm',
      systemPrompt: 's',
      onBookingLead: vi.fn(),
      onEscalate: vi.fn(),
      checkAvailability: vi.fn(async () => ({ property: '', checkIn: '', checkOut: '', offers: [], source: 'stub' as const })),
    });
    expect(result.reply).toBe('We are 10 minutes from Bayterek.');
    expect(result.handedOff).toBe(false);
  });

  it('runs capture_booking_lead then returns the follow-up text', async () => {
    const onBookingLead = vi.fn();
    const client = fakeClient([
      {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'capture_booking_lead',
            input: {
              checkIn: '2026-07-01',
              checkOut: '2026-07-03',
              guests: 2,
              roomType: 'Comfort',
              contactName: 'Aibek',
              contactPhone: '+7700',
            },
          },
        ],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Thank you! Our team will confirm.' }] },
    ]);
    const result = await generateReply(history, {
      client,
      model: 'm',
      systemPrompt: 's',
      onBookingLead,
      onEscalate: vi.fn(),
      checkAvailability: vi.fn(async () => ({ property: '', checkIn: '', checkOut: '', offers: [], source: 'stub' as const })),
    });
    expect(onBookingLead).toHaveBeenCalledWith(expect.objectContaining({ contactName: 'Aibek' }));
    expect(result.reply).toBe('Thank you! Our team will confirm.');
    expect(result.handedOff).toBe(false);
  });

  it('marks handedOff when escalate_to_human is called', async () => {
    const onEscalate = vi.fn();
    const client = fakeClient([
      {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 't2',
            name: 'escalate_to_human',
            input: { reason: 'complaint', summary: 'Guest unhappy with noise' },
          },
        ],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'A team member will reply shortly.' }] },
    ]);
    const result = await generateReply(history, {
      client,
      model: 'm',
      systemPrompt: 's',
      onBookingLead: vi.fn(),
      onEscalate,
      checkAvailability: vi.fn(async () => ({ property: '', checkIn: '', checkOut: '', offers: [], source: 'stub' as const })),
    });
    expect(onEscalate).toHaveBeenCalledWith('complaint', 'Guest unhappy with noise');
    expect(result.handedOff).toBe(true);
  });
});
