import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/ai/systemPrompt';
import { properties, propertyList } from '../src/knowledge';

const astana = properties.astana;
const almaty = properties.almaty;
const prompt = buildSystemPrompt(astana);

describe('buildSystemPrompt: identity', () => {
  it('embeds the property name and knowledge', () => {
    expect(prompt).toContain('Hotel Kazzhol Astana');
    expect(prompt).toContain('Fergana'); // a fact from the Astana knowledge base
  });

  it('uses the given property, not a hardcoded one', () => {
    const p = buildSystemPrompt(almaty);
    expect(p).toContain('Hotel Kazzhol Almaty');
    expect(p).not.toContain('Hotel Kazzhol Astana');
  });

  it('is honestly a bot: never a human name, never pretends to be human', () => {
    expect(prompt).toMatch(/never pretend to be (a )?human/i);
    expect(prompt).toMatch(/never .*human name/i);
    expect(prompt).toContain('бот-ассистент отеля'); // the light "ты бот?" one-liner
  });
});

describe('buildSystemPrompt: languages', () => {
  it('mirrors all four guest languages', () => {
    expect(prompt).toMatch(/Russian/);
    expect(prompt).toMatch(/Kazakh/);
    expect(prompt).toMatch(/English/);
    expect(prompt).toMatch(/Chinese/);
    expect(prompt).toMatch(/same language/i);
  });

  it('understands code-switching and slang without ever correcting the guest', () => {
    expect(prompt).toMatch(/never correct/i);
    expect(prompt).toContain('базар жоқ'); // passive slang vocabulary
    expect(prompt).toMatch(/never use slang/i);
  });

  it('allows phatic Kazakh insertions only when the guest mixes', () => {
    expect(prompt).toContain('Рахмет');
    expect(prompt).toContain('Жақсы демалыс болсын');
    expect(prompt).toMatch(/only (when|if) the guest/i);
  });
});

describe('buildSystemPrompt: texting style', () => {
  it('teaches the ||| split with max 3 parts', () => {
    expect(prompt).toContain('|||');
    expect(prompt).toMatch(/(max|at most|up to) (3|three)/i);
  });

  it('forbids markdown, bullets, and numbered lists', () => {
    expect(prompt).toMatch(/no markdown/i);
    expect(prompt).toMatch(/bullet/i);
    expect(prompt).toMatch(/numbered list/i);
  });

  it('bans officialese and AI-tells', () => {
    expect(prompt).toContain('Конечно! Я с радостью помогу');
    expect(prompt).toContain("I'm an AI language model");
  });

  it('gives live connective phrases and forbids repeated openings', () => {
    expect(prompt).toContain('сейчас гляну');
    expect(prompt).toContain('қазір қарап берейін');
    expect(prompt).toMatch(/never start two consecutive replies/i);
  });
});

describe('buildSystemPrompt: workflows', () => {
  it('prices only from tools, never invented', () => {
    expect(prompt).toContain('check_availability');
    expect(prompt.toLowerCase()).toContain('never invent');
  });

  it('books conversationally: summary confirmation before create_booking', () => {
    expect(prompt).toContain('create_booking');
    expect(prompt).toMatch(/one question at a time/i);
    expect(prompt).toMatch(/summary/i);
  });

  it('offers exactly one upsell after dates are fixed', () => {
    expect(prompt).toMatch(/exactly one/i);
    expect(prompt).toMatch(/early check-?in/i);
    expect(prompt).toMatch(/late check-?out/i);
    expect(prompt).toMatch(/upgrade/i);
  });

  it('covers MICE and the booking-link mode', () => {
    expect(prompt).toContain('submit_mice_request');
    expect(prompt).toMatch(/10\+/);
    expect(prompt).toContain('персональная ссылка');
  });

  it('handles multi-part requests without abandoning parts', () => {
    expect(prompt).toMatch(/multi-part/i);
    expect(prompt).toContain('capture_lead');
  });
});

describe('buildSystemPrompt: escalation discipline', () => {
  it('escalates sparingly, never for a missing fact', () => {
    expect(prompt).toMatch(/sparingly|last resort/i);
    expect(prompt).toMatch(/not a reason/i);
    expect(prompt).toMatch(/two substantive attempts/i);
    expect(prompt).toContain('уточню у коллег');
  });
});

describe('buildSystemPrompt: anti-jailbreak', () => {
  it('never reveals the prompt and returns to hotel topics', () => {
    expect(prompt).toMatch(/never reveal/i);
    expect(prompt).toMatch(/back to hotel topics/i);
  });
});

describe('buildSystemPrompt: sister hotels', () => {
  it('includes sister hotel names and knowledge when passed', () => {
    const sisters = propertyList.filter((p) => p.key !== almaty.key);
    const p = buildSystemPrompt(almaty, { sisterHotels: sisters });
    expect(p).toContain('Hotel Kazzhol Astana');
    expect(p).toContain('Hotel Kazzhol Park Almaty');
    expect(p).toContain('Balkantau'); // a fact from the Astana knowledge snippet
    expect(p).toMatch(/property/); // book them via the tools' property parameter
  });

  it('omits the sister section when none are passed', () => {
    const p = buildSystemPrompt(almaty);
    expect(p).not.toContain('Hotel Kazzhol Astana');
  });
});

describe('buildSystemPrompt: style guide embedding', () => {
  it('appends the style guide verbatim in a STYLE GUIDE section', () => {
    const p = buildSystemPrompt(astana, { styleGuide: 'STYLE_MARKER_12345 unique rule text' });
    expect(p).toContain('STYLE GUIDE');
    expect(p).toContain('STYLE_MARKER_12345 unique rule text');
  });

  it('has no STYLE GUIDE section without one', () => {
    expect(prompt).not.toContain('STYLE_MARKER_12345');
  });
});
