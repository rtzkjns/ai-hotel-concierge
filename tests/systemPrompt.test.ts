import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/ai/systemPrompt';
import { astanaKnowledge } from '../src/knowledge/astana';

describe('buildSystemPrompt', () => {
  const prompt = buildSystemPrompt(astanaKnowledge);

  it('embeds the property knowledge', () => {
    expect(prompt).toContain('Hotel Kazzhol Astana');
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
});
