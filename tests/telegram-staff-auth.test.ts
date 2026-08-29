/**
 * Security regression: the Telegram «staff» deep-link must NOT enrol a chat into a hotel's
 * guest-handoff notifications (guest PII) without the owner's bind code. Before this fix, a bare
 * guessable «?start=staff-almaty» subscribed anyone in one tap — a confirmed B2B-readiness blocker.
 */
import { describe, it, expect } from 'vitest';
import { authorizeStaffDeepLink } from '../src/channels/telegram';

const KEYS = ['almaty', 'astana', 'park_almaty', 'seven'];
const CODE = 'AB12CD';

describe('authorizeStaffDeepLink — gate staff enrolment on the owner bind code', () => {
  it('REJECTS a bare, guessable link with no code (the closed hole)', () => {
    expect(authorizeStaffDeepLink('staff-almaty', KEYS, CODE)).toBeNull();
    expect(authorizeStaffDeepLink('staff_almaty', KEYS, CODE)).toBeNull();
  });

  it('REJECTS a wrong code', () => {
    expect(authorizeStaffDeepLink('staff-almaty-WRONG', KEYS, CODE)).toBeNull();
  });

  it('REJECTS an unknown hotel even with a valid code', () => {
    expect(authorizeStaffDeepLink('staff-nope-AB12CD', KEYS, CODE)).toBeNull();
  });

  it('fails closed when no bind code is configured', () => {
    expect(authorizeStaffDeepLink('staff-almaty-AB12CD', KEYS, undefined)).toBeNull();
    expect(authorizeStaffDeepLink('staff-almaty-', KEYS, '')).toBeNull();
  });

  it('ACCEPTS the correct hotel + code (owner panel link), case-insensitive', () => {
    expect(authorizeStaffDeepLink('staff-almaty-AB12CD', KEYS, CODE)).toBe('almaty');
    expect(authorizeStaffDeepLink('staff-almaty-ab12cd', KEYS, CODE)).toBe('almaty');
  });

  it('handles a hotel key that itself contains an underscore (park_almaty)', () => {
    expect(authorizeStaffDeepLink('staff-park_almaty-AB12CD', KEYS, CODE)).toBe('park_almaty');
  });

  it('ignores non-staff payloads', () => {
    expect(authorizeStaffDeepLink('', KEYS, CODE)).toBeNull();
    expect(authorizeStaffDeepLink('somethingelse', KEYS, CODE)).toBeNull();
  });
});
