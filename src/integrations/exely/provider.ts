import type { AvailabilityQuery, AvailabilityResult } from './types';

export interface AvailabilityProvider {
  checkAvailability(query: AvailabilityQuery): Promise<AvailabilityResult>;
}
