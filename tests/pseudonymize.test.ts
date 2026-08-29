import { describe, it, expect } from 'vitest';
import { Pseudonymizer } from '../src/core/pseudonymize';

describe('Pseudonymizer — reversible PII masking for cross-border LLM calls', () => {
  it('masks phone + email, leaves prices/dates/counts alone (model can still quote)', () => {
    const p = new Pseudonymizer();
    const masked = p.mask('тел +7 776 412 6353, почта ivan@mail.kz, номер 55 250 ₸ на 2 гостей 2026-09-10');
    expect(masked).not.toContain('776 412 6353');
    expect(masked).not.toContain('ivan@mail.kz');
    expect(masked).toMatch(/\[PHONE_\d+\]/);
    expect(masked).toMatch(/\[EMAIL_\d+\]/);
    expect(masked).toContain('55 250'); // price survives
    expect(masked).toContain('2 гостей'); // count survives
    expect(masked).toContain('2026-09-10'); // date survives
  });

  it('is reversible: unmask restores the original text', () => {
    const p = new Pseudonymizer();
    const orig = 'phone +7 776 412 6353 email a@b.kz';
    expect(p.unmask(p.mask(orig))).toBe(orig);
  });

  it('same value → same stable token across the conversation', () => {
    const p = new Pseudonymizer();
    const t1 = p.mask('call +7 776 412 6353')!.match(/\[PHONE_\d+\]/)![0];
    const t2 = p.mask('again +7 776 412 6353')!.match(/\[PHONE_\d+\]/)![0];
    expect(t1).toBe(t2);
  });

  it('unmaskDeep restores tokens inside a tool-call input object', () => {
    const p = new Pseudonymizer();
    const masked = p.mask('phone +7 776 412 6353 email x@y.kz');
    const phoneTok = masked.match(/\[PHONE_\d+\]/)![0];
    const emailTok = masked.match(/\[EMAIL_\d+\]/)![0];
    expect(p.unmaskDeep({ guestPhone: phoneTok, guestEmail: emailTok, guests: 2 })).toEqual({
      guestPhone: '+7 776 412 6353',
      guestEmail: 'x@y.kz',
      guests: 2,
    });
  });
});
