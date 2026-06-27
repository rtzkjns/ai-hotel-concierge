import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/ai/systemPrompt';
import { properties } from '../src/knowledge';

describe('buildSystemPrompt', () => {
  const astana = properties.astana;
  const prompt = buildSystemPrompt(astana.name, astana.knowledge);

  it('embeds the property name and knowledge', () => {
    expect(prompt).toContain('Hotel Kazzhol Astana');
    expect(prompt).toContain('Fergana'); // a fact from the Astana knowledge base
  });

  it('uses the given property name, not a hardcoded one', () => {
    const almaty = properties.almaty;
    const p = buildSystemPrompt(almaty.name, almaty.knowledge);
    expect(p).toContain('Hotel Kazzhol Almaty');
    expect(p).not.toContain('Hotel Kazzhol Astana');
  });

  it('instructs language mirroring for the three languages', () => {
    expect(prompt).toMatch(/Russian/i);
    expect(prompt).toMatch(/Kazakh/i);
    expect(prompt).toMatch(/English/i);
    expect(prompt).toMatch(/same language/i);
  });

  it('forbids inventing facts and prices', () => {
    expect(prompt).toMatch(/do not (make up|invent)/i);
  });

  it('tells the bot to escalate sparingly, not for missing facts', () => {
    expect(prompt).toMatch(/sparingly/i);
    expect(prompt).toMatch(/not a reason to escalate/i);
  });

  it('tells the bot to capture special requests instead of abandoning big requests', () => {
    expect(prompt).toMatch(/specialRequests/);
    expect(prompt).toMatch(/multi-part/i);
  });
});
