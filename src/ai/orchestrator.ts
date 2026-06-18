import type Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage } from '../types';
import { toolDefinitions, type BookingLeadArgs, type EscalateArgs } from './tools';

export interface AnthropicLike {
  messages: {
    create: (body: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;
  };
}

export interface GenerateDeps {
  client: AnthropicLike;
  model: string;
  systemPrompt: string;
  onBookingLead: (args: BookingLeadArgs) => Promise<void> | void;
  onEscalate: (reason: string, summary: string) => Promise<void> | void;
}

export async function generateReply(
  history: ChatMessage[],
  deps: GenerateDeps,
): Promise<{ reply: string; handedOff: boolean }> {
  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let handedOff = false;

  // Tool-use loop: keep going until Claude stops requesting tools.
  // Capped to avoid infinite loops on a misbehaving model.
  for (let turn = 0; turn < 5; turn++) {
    const response = await deps.client.messages.create({
      model: deps.model,
      max_tokens: 1024,
      system: deps.systemPrompt,
      tools: toolDefinitions,
      messages,
    });

    if (response.stop_reason !== 'tool_use') {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return { reply: text, handedOff };
    }

    // Echo the assistant turn (with tool_use blocks) back into the conversation.
    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      if (block.name === 'capture_booking_lead') {
        await deps.onBookingLead(block.input as BookingLeadArgs);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Lead saved.' });
      } else if (block.name === 'escalate_to_human') {
        const args = block.input as EscalateArgs;
        await deps.onEscalate(args.reason, args.summary);
        handedOff = true;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'Escalated to staff.',
        });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return { reply: 'Our team will get back to you shortly.', handedOff };
}
