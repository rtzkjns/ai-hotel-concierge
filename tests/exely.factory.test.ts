import { describe, it, expect } from 'vitest';
import { createAvailabilityProvider } from '../src/integrations/exely';
import { StubAvailabilityProvider } from '../src/integrations/exely/stub';

const authUrl = 'https://connect.hopenapi.com/auth/token';

describe('createAvailabilityProvider', () => {
  it('returns the stub when no credentials are configured', () => {
    const provider = createAvailabilityProvider({ authUrl });
    expect(provider).toBeInstanceOf(StubAvailabilityProvider);
  });

  it('throws a clear not-implemented error when credentials ARE set (real client = follow-up plan)', () => {
    expect(() =>
      createAvailabilityProvider({ clientId: 'id', clientSecret: 'secret', authUrl }),
    ).toThrow(/not implemented/i);
  });
});
