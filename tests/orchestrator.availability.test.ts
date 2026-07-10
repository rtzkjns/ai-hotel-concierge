import { describe, it, expect, vi } from 'vitest';
import { generateReply } from '../src/ai/orchestrator';
import type { AnthropicLike } from '../src/ai/orchestrator';
import type { AvailabilityResult } from '../src/integrations/exely/types';

// A fake Anthropic client: first call requests check_availability, second returns text.
function fakeClient(): AnthropicLike {
  let call = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return {
            stop_reason: 'tool_use',
            content: [
              {
                type: 'tool_use',
                id: 'tool_1',
                name: 'check_availability',
                input: { checkIn: '2026-08-01', checkOut: '2026-08-03', guests: 2 },
              },
            ],
          } as never;
        }
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Standard rooms are available.' }],
        } as never;
      }),
    },
  };
}

describe('generateReply with check_availability', () => {
  it('calls the injected handler and feeds the availability JSON back to the model', async () => {
    const result: AvailabilityResult = {
      property: 'astana',
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      offers: [
        {
          roomType: 'Standard',
          available: true,
          pricePerNight: 25000,
          currency: 'KZT',
          roomTypeId: null,
          ratePlanId: null,
          ratePlanName: null,
          totalPrice: null,
          checksum: null,
          placements: [],
          bookingFormLink: null,
        },
      ],
      source: 'stub',
    };
    const checkAvailability = vi.fn(async () => result);
    const client = fakeClient();

    const out = await generateReply([{ role: 'user', content: 'Rooms for Aug 1-3?' }], {
      client,
      model: 'test-model',
      systemPrompt: 'sp',
      tools: { check_availability: checkAvailability },
    });

    expect(checkAvailability).toHaveBeenCalledWith({
      checkIn: '2026-08-01',
      checkOut: '2026-08-03',
      guests: 2,
    });
    expect(out.reply).toBe('Standard rooms are available.');
    expect(out.toolsUsed).toEqual(['check_availability']);
    // The second model call must include a tool_result carrying the availability JSON.
    const secondCallArgs = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[1][0];
    const lastMsg = secondCallArgs.messages.at(-1);
    const toolResult = lastMsg.content[0];
    expect(toolResult.type).toBe('tool_result');
    expect(String(toolResult.content)).toContain('Standard');
  });
});
