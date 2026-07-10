/**
 * Style engine: turns one model reply into 1-3 messenger-sized messages with
 * human-feeling send delays. Deterministic on purpose (no Math.random) so both
 * tests and guest experience are reproducible.
 */

const MAX_PARTS = 3;
const MAX_PART_CHARS = 900;

/**
 * Split a reply on the '|||' marker the model was taught to use.
 * More than 3 parts are merged into the 3rd; any part longer than 900 chars is
 * split at the last sentence boundary before 900 (hard cut as a fallback).
 */
export function styleSplit(reply: string): string[] {
  const parts = reply
    .split('|||')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const capped =
    parts.length > MAX_PARTS
      ? [...parts.slice(0, MAX_PARTS - 1), parts.slice(MAX_PARTS - 1).join(' ')]
      : parts;

  return capped.flatMap(splitLongPart);
}

function splitLongPart(part: string): string[] {
  const out: string[] = [];
  let rest = part;
  while (rest.length > MAX_PART_CHARS) {
    const window = rest.slice(0, MAX_PART_CHARS);
    const cut = lastSentenceEnd(window) ?? MAX_PART_CHARS;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/** Index just past the last sentence-ending punctuation followed by whitespace, or null. */
function lastSentenceEnd(window: string): number | null {
  const re = /[.!?…](?=\s)/g;
  let cut: number | null = null;
  for (let m = re.exec(window); m !== null; m = re.exec(window)) cut = m.index + 1;
  return cut;
}

export interface DelayedPart {
  text: string;
  delayMs: number;
}

export interface HumanDelayOpts {
  /** Length of the guest's message: longer questions take longer to "read". */
  guestMsgLength?: number;
  /**
   * Channel scaling (default 1; web widget uses 0.6). Scaled delays re-clamp to
   * [200, 2500]. Pass URGENT_MULTIPLIER (0) for urgent flows: every delay becomes 0.
   */
  multiplier?: number;
}

/** Multiplier for urgent flows (complaints, guest in a hurry): no delays at all. */
export const URGENT_MULTIPLIER = 0;

/**
 * Deterministic human-feeling delays: the first message simulates reading the
 * guest and typing; subsequent ones simulate typing only.
 */
export function humanDelays(parts: string[], opts: HumanDelayOpts = {}): DelayedPart[] {
  const multiplier = opts.multiplier ?? 1;
  const guestMsgLength = opts.guestMsgLength ?? 0;

  return parts.map((text, i) => {
    const base =
      i === 0
        ? clamp(400 + text.length * 15 + guestMsgLength * 5, 400, 1200)
        : clamp(600 + text.length * 20, 600, 2500);
    const delayMs = multiplier === 0 ? 0 : Math.round(clamp(base * multiplier, 200, 2500));
    return { text, delayMs };
  });
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}
