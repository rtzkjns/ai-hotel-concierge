/**
 * Onboarding tooling: scaffold a new tenant so adding a hotel is a guided step, not hand-authored
 * JSON + guesswork. Writes a valid tenants/<id>.json (accepted by loadTenantsFromDir) and prints the
 * per-instance env + deploy checklist.
 *
 *   npx tsx scripts/scaffold-tenant.mts <id> "<Brand Name>" <website> [propertyKey]
 *   e.g. npx tsx scripts/scaffold-tenant.mts grandhotel "Grand Hotel" grandhotel.com main
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertValidTenant, type TenantConfig } from '../src/tenant';

const [, , id, displayName, website, propertyKey = 'main'] = process.argv;

if (!id || !displayName || !website) {
  console.error('Usage: tsx scripts/scaffold-tenant.mts <id> "<Brand Name>" <website> [propertyKey]');
  process.exit(1);
}

const tenant: TenantConfig = {
  id,
  brand: { displayName, website },
  // Persona/currency/languages are sensible defaults — edit to taste. A female persona keeps the
  // Russian gender rule; set gender:'neutral' to drop it.
  persona: { name: 'Alia', gender: 'female' },
  currency: { code: 'USD', symbol: '$', scrubPattern: '\\$|USD\\b' },
  languages: ['en'],
  // One property to start. Add more; each key becomes the env prefix (KEY.toUpperCase()) for creds.
  properties: [
    {
      key: propertyKey,
      name: `${displayName}`,
      city: 'city',
      bookable: true,
      knowledge:
        `PROPERTY: ${displayName} — describe the hotel here.\n` +
        'ADDRESS: …\nCHECK-IN / CHECK-OUT: …\nROOM CATEGORIES: …\n' +
        'PRICES: never state a price yourself — quote ONLY what check_availability returns.\n' +
        'AMENITIES: …\nCONTACT: …',
    },
  ],
  // No regionPack → none of the Kazakh/CIS blocks. Set 'kz-cis' for a CIS hotel.
  regionPack: null,
  // Uncomment for a jurisdiction that requires in-country data storage (e.g. KZ):
  // dataResidency: { inCountry: true, pseudonymizePII: true },
};

// Fail loudly if the skeleton is somehow invalid, before writing.
assertValidTenant(tenant);

const dir = process.env.TENANTS_DIR ?? './tenants';
mkdirSync(dir, { recursive: true });
const file = join(dir, `${id}.json`);
if (existsSync(file)) {
  console.error(`Refusing to overwrite existing ${file}`);
  process.exit(1);
}
writeFileSync(file, JSON.stringify(tenant, null, 2) + '\n');

const KEY = propertyKey.toUpperCase();
console.log(`\n✅ Wrote ${file}\n`);
console.log('NEXT — this tenant runs as its own instance (one DB per tenant). On that instance:\n');
console.log(`  1. Fill in ${file}: real persona, currency, languages, and each property's knowledge.`);
console.log(`  2. Set env for the instance:`);
console.log(`       TENANT=${id}`);
console.log(`       DB_PATH=/path/in-region/${id}.db        # per-tenant DB (boot enforces this)`);
console.log(`       ANTHROPIC_API_KEY=…  CONSOLE_ADMIN_PASSWORD=…`);
console.log(`     Availability — choose ONE per property:`);
console.log(`       • Exely:  EXELY_${KEY}_CLIENT_ID / _CLIENT_SECRET / _PROPERTY_ID`);
console.log(`                 (optional) EXELY_${KEY}_INTEGRATION_KEY / EXELY_${KEY}_RETURN_URL`);
console.log(`       • No PMS: MANUAL_PROPERTIES=${propertyKey}   # manual/handoff mode`);
console.log(`     Channels (as configured): WHATSAPP_PHONE_ID_${KEY} / INSTAGRAM_IG_ID_${KEY} / …`);
console.log(`     Staff Telegram: STAFF_CHAT_ID_${KEY}`);
console.log(`  3. If the jurisdiction requires in-country data: uncomment dataResidency in the JSON`);
console.log(`     and set DATA_RESIDENCY_CONFIRMED=true (boot refuses otherwise).`);
console.log(`  4. Deploy the instance (deploy/deploy.sh) and verify: TENANT=${id} npm test.\n`);
