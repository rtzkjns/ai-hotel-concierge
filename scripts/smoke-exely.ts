// Manual live smoke test against the Exely Connect prod API (Almaty, propertyId 801).
// Usage: npx tsx scripts/smoke-exely.ts [checkIn] [checkOut] [adults]
//   e.g. npx tsx scripts/smoke-exely.ts 2026-08-10 2026-08-13 2
// Reads EXELY_CLIENT_ID / EXELY_CLIENT_SECRET (and optional EXELY_AUTH_URL /
// EXELY_BASE_URL) from .env. Read-only: only calls Search, never Reservation.
import 'dotenv/config';
import { ExelyHttp } from '../src/integrations/exely/http';
import { LiveAvailabilityProvider } from '../src/integrations/exely/live';
import { ExelyTokenManager } from '../src/integrations/exely/token';
import { properties } from '../src/knowledge';

const clientId = process.env.EXELY_CLIENT_ID;
const clientSecret = process.env.EXELY_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Missing EXELY_CLIENT_ID / EXELY_CLIENT_SECRET in the environment (.env).');
  process.exit(1);
}

const checkIn = process.argv[2] ?? '2026-08-10';
const checkOut = process.argv[3] ?? '2026-08-13';
const adults = Number(process.argv[4] ?? '2');
if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
  console.error('Dates must be YYYY-MM-DD, e.g.: npx tsx scripts/smoke-exely.ts 2026-08-10 2026-08-13 2');
  process.exit(1);
}

const tokens = new ExelyTokenManager({
  clientId,
  clientSecret,
  authUrl: process.env.EXELY_AUTH_URL ?? 'https://connect.hopenapi.com/auth/token',
});
const http = new ExelyHttp(
  { baseUrl: process.env.EXELY_BASE_URL ?? 'https://connect.hopenapi.com' },
  tokens,
);
const provider = new LiveAvailabilityProvider(http, (key) => properties[key]?.exelyPropertyId);

const result = await provider.checkAvailability({
  property: 'almaty',
  checkIn,
  checkOut,
  guests: adults,
});

console.log(`Exely search — almaty (${checkIn} → ${checkOut}, ${adults} adult(s))`);
if (result.unavailableReason) {
  console.log(`Unavailable: ${result.unavailableReason}`);
} else if (result.offers.length === 0) {
  console.log('No availability for these dates (empty roomStays — a normal answer).');
} else {
  console.table(
    result.offers.map((o) => ({
      roomType: o.roomType,
      ratePlan: o.ratePlanName,
      perNight: o.pricePerNight,
      total: o.totalPrice,
      currency: o.currency,
      placements: o.placements.join(','),
      checksum: o.checksum ? `${o.checksum.slice(0, 12)}…` : null,
      link: o.bookingFormLink,
    })),
  );
}
if (result.warnings && result.warnings.length > 0) {
  console.log('Warnings:', JSON.stringify(result.warnings, null, 2));
}
