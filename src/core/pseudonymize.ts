/**
 * Reversible pseudonymization of guest PII so raw identifiers do NOT cross the border to a foreign
 * LLM (a KZ data-residency requirement). Phones and emails are the regulated, regex-detectable
 * identifiers; they are swapped for stable tokens («[PHONE_1]») before the model call and restored
 * afterwards — in the tool inputs the model produces and in the outbound reply. The model never sees
 * the real number/email; the engine still books with the real value it holds.
 *
 * Scope (v1): phone + email. Names are out — reliable detection is an NLP problem and over-masking a
 * name breaks the bot's addressing. Digit runs shorter than a phone (prices, room counts, dates) are
 * left alone so the model can still reason about and quote them.
 *
 * Gated per tenant (residency-strict). OFF for Kazzhol → the model path is byte-for-byte unchanged.
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 10–15 digits with the usual separators (+7 776 412 63 53). The high floor keeps 4–7 digit prices
// («55 250», «395 000») and dates out of scope so quoting still works.
const PHONE_RE = /\+?\d(?:[ \-()]{0,2}\d){9,14}/g;

export class Pseudonymizer {
  private readonly toToken = new Map<string, string>();
  private readonly toValue = new Map<string, string>();
  private n = 0;

  private token(value: string, prefix: 'PHONE' | 'EMAIL'): string {
    const existing = this.toToken.get(value);
    if (existing) return existing;
    const tok = `[${prefix}_${++this.n}]`;
    this.toToken.set(value, tok);
    this.toValue.set(tok, value);
    return tok;
  }

  /** Replace phones/emails with stable tokens. Idempotent per value across the conversation. */
  mask(text: string): string {
    if (!text) return text;
    let out = text.replace(EMAIL_RE, (m) => this.token(m, 'EMAIL'));
    out = out.replace(PHONE_RE, (m) => this.token(m, 'PHONE'));
    return out;
  }

  /** Restore tokens to their real values — for tool inputs the model emits and for outbound text. */
  unmask(text: string): string {
    if (!text) return text;
    let out = text;
    for (const [tok, value] of this.toValue) out = out.split(tok).join(value);
    return out;
  }

  /** Deep-unmask an object (a tool-call input) — restores tokens in every string leaf. */
  unmaskDeep<T>(value: T): T {
    if (typeof value === 'string') return this.unmask(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => this.unmaskDeep(v)) as unknown as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.unmaskDeep(v);
      return out as T;
    }
    return value;
  }

  /** True once anything was actually tokenized (for telemetry / assertions). */
  get active(): boolean {
    return this.n > 0;
  }
}
