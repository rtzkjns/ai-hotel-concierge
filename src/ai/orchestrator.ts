import type Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage } from '../types';
import { toolDefinitions } from './tools';

export interface AnthropicLike {
  messages: {
    create: (body: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;
  };
}

/** Tool handlers are injected generically so the orchestrator stays integration-free. */
export type ToolHandlers = Record<string, (input: unknown) => Promise<unknown>>;

export interface GenerateDeps {
  client: AnthropicLike;
  model: string;
  systemPrompt: string;
  tools: ToolHandlers;
}

export interface GenerateResult {
  reply: string;
  handedOff: boolean;
  toolsUsed: string[];
}

// Capped to avoid infinite loops on a misbehaving model.
const MAX_ROUNDS = 8;

const CANCEL_CONFIRMATION_REQUIRED =
  'CONFIRMATION_REQUIRED: ask the guest to explicitly confirm the cancellation first';

export async function generateReply(
  history: ChatMessage[],
  deps: GenerateDeps,
): Promise<GenerateResult> {
  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let handedOff = false;
  const toolsUsed: string[] = [];

  for (let round = 0; round < MAX_ROUNDS; round++) {
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
      return { reply: text, handedOff, toolsUsed };
    }

    // Echo the assistant turn (with tool_use blocks) back into the conversation.
    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      toolResults.push(await runTool(block, deps.tools, toolsUsed, () => (handedOff = true)));
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return { reply: 'Our team will get back to you shortly.', handedOff, toolsUsed };
}

async function runTool(
  block: Anthropic.ToolUseBlock,
  tools: ToolHandlers,
  toolsUsed: string[],
  markHandedOff: () => void,
): Promise<Anthropic.ToolResultBlockParam> {
  const handler = tools[block.name];
  if (!handler) {
    return { type: 'tool_result', tool_use_id: block.id, content: 'Unknown tool' };
  }
  // Guardrail: a cancellation the guest has not explicitly confirmed never reaches the handler.
  if (block.name === 'cancel_booking') {
    const input = block.input as { confirmedByGuest?: unknown } | null;
    if (input?.confirmedByGuest !== true) {
      return { type: 'tool_result', tool_use_id: block.id, content: CANCEL_CONFIRMATION_REQUIRED };
    }
  }
  // Counted only for calls that actually reach a handler (telemetry accuracy).
  toolsUsed.push(block.name);

  try {
    const result = await handler(block.input);
    if (block.name === 'escalate_to_human') markHandedOff();
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: JSON.stringify(result) ?? 'null',
    };
  } catch (err) {
    // Feed the failure back so the model can apologize like a human and try another way.
    const message = err instanceof Error ? err.message : String(err);
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: JSON.stringify({ error: message }),
      is_error: true,
    };
  }
}
