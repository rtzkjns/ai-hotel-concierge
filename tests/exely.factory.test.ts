import { describe, it, expect } from 'vitest';
import { createAvailabilityProvider } from '../src/integrations/exely';
import { StubAvailabilityProvider } from '../src/integrations/exely/stub';
import { LiveAvailabilityProvider } from '../src/integrations/exely/live';

const authUrl = 'https://connect.hopenapi.com/auth/token';
const baseUrl = 'https://connect.hopenapi.com';
const resolver = (): string | undefined => undefined;

describe('createAvailabilityProvider', () => {
  it('returns the stub when no credentials are configured', () => {
    const provider = createAvailabilityProvider({ authUrl, baseUrl }, resolver);
    expect(provider).toBeInstanceOf(StubAvailabilityProvider);
  });

  it('returns the live provider when credentials ARE set', () => {
    const provider = createAvailabilityProvider(
      { clientId: 'id', clientSecret: 'secret', authUrl, baseUrl },
      resolver,
    );
    expect(provider).toBeInstanceOf(LiveAvailabilityProvider);
  });
});
