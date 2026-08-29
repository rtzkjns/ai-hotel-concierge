import type Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage } from '../types';
import type { Pseudonymizer } from '../core/pseudonymize';
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
  /**
   * Reply used when the tool loop is exhausted, in the GUEST's language. Without it a Kazakh or
   * Chinese guest would receive a hardcoded English sentence.
   */
  exhaustedReply?: string;
  /**
   * When set (a residency-strict tenant), guest phone/email are tokenized before every model call
   * and restored in tool inputs + the reply, so raw PII never crosses the border to the foreign LLM.
   * Unset (Kazzhol default) → the model path is byte-for-byte unchanged.
   */
  pseudonymizer?: Pseudonymizer;
}

export interface GenerateResult {
  reply: string;
  handedOff: boolean;
  toolsUsed: string[];
  /**
   * True when the tool loop hit MAX_ROUNDS without the model producing an answer. The caller MUST
   * treat this as a dead end: notify staff and record a lead, otherwise the guest is left with a
   * holding phrase and nobody ever follows up.
   */
  roundsExhausted: boolean;
}

// Capped to avoid infinite loops on a misbehaving model.
const MAX_ROUNDS = 8;

const CANCEL_CONFIRMATION_REQUIRED =
  'CONFIRMATION_REQUIRED: ask the guest to explicitly confirm the cancellation first';

export async function generateReply(
  history: ChatMessage[],
  deps: GenerateDeps,
): Promise<GenerateResult> {
  const pz = deps.pseudonymizer;
  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role,
    content: pz ? pz.mask(m.content) : m.content,
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
      return { reply: pz ? pz.unmask(text) : text, handedOff, toolsUsed, roundsExhausted: false };
    }

    // Echo the assistant turn (with tool_use blocks) back into the conversation.
    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      toolResults.push(await runTool(block, deps.tools, toolsUsed, () => (handedOff = true), pz));
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return {
    reply: deps.exhaustedReply ?? 'Our team will get back to you shortly.',
    handedOff,
    toolsUsed,
    roundsExhausted: true,
  };
}

async function runTool(
  block: Anthropic.ToolUseBlock,
  tools: ToolHandlers,
  toolsUsed: string[],
  markHandedOff: () => void,
  pz?: Pseudonymizer,
): Promise<Anthropic.ToolResultBlockParam> {
  const handler = tools[block.name];
  if (!handler) {
    return { type: 'tool_result', tool_use_id: block.id, content: 'Unknown tool' };
  }
  // Restore real phone/email in the tool input the model produced — the engine books with the real
  // value, never the token. No-op when pseudonymization is off.
  const input = pz ? pz.unmaskDeep(block.input) : block.input;
  // Guardrail: a cancellation the guest has not explicitly confirmed never reaches the handler.
  if (block.name === 'cancel_booking') {
    const inp = input as { confirmedByGuest?: unknown } | null;
    if (inp?.confirmedByGuest !== true) {
      return { type: 'tool_result', tool_use_id: block.id, content: CANCEL_CONFIRMATION_REQUIRED };
    }
  }
  // Counted only for calls that actually reach a handler (telemetry accuracy).
  toolsUsed.push(block.name);

  try {
    const result = await handler(input);
    if (block.name === 'escalate_to_human') markHandedOff();
    const content = JSON.stringify(result) ?? 'null';
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      // Re-mask any PII echoed back by a handler so it doesn't reach the model either.
      content: pz ? pz.mask(content) : content,
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
