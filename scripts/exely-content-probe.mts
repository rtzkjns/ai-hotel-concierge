// Read-only probe: what does Exely Content API return for each configured cabinet?
// Tells us exactly which hotel facts we can auto-sync (rooms, services, meals, policies).
import { writeFileSync } from 'node:fs';
import { buildExelyCabinets } from '../src/config';
import { ExelyTokenManager } from '../src/integrations/exely/token';
import { ExelyHttp } from '../src/integrations/exely/http';

function summarize(label: string, val: unknown, depth = 0): void {
  const pad = '  '.repeat(depth);
  if (Array.isArray(val)) {
    console.log(`${pad}${label}: array[${val.length}]`);
    if (val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
      console.log(`${pad}  keys of [0]: ${Object.keys(val[0] as object).join(', ')}`);
    }
  } else if (val && typeof val === 'object') {
    console.log(`${pad}${label}: { ${Object.keys(val as object).join(', ')} }`);
  } else {
    const s = String(val);
    console.log(`${pad}${label}: ${s.length > 80 ? s.slice(0, 80) + '…' : s}`);
  }
}

const cabinets = buildExelyCabinets(process.env);
console.log(`Cabinets configured: ${Object.keys(cabinets).join(', ')}\n`);

for (const [key, cab] of Object.entries(cabinets)) {
  console.log(`\n========== ${key} (property ${cab.propertyId}) ==========`);
  try {
    const tokens = new ExelyTokenManager({
      clientId: cab.clientId,
      clientSecret: cab.clientSecret,
      authUrl: cab.authUrl,
    });
    const http = new ExelyHttp({ baseUrl: cab.baseUrl }, tokens);
    const content = (await http.content(cab.propertyId)) as Record<string, unknown>;
    writeFileSync(
      `/private/tmp/claude-501/-Users-abzalm/e2a5b7d4-6047-4996-becc-aa5308e0fe1e/scratchpad/exely-content-${key}.json`,
      JSON.stringify(content, null, 2),
    );
    console.log(`TOP-LEVEL KEYS: ${Object.keys(content).join(', ')}`);
    // Drill into the sections we care about for the knowledge base.
    for (const k of Object.keys(content)) {
      summarize(k, content[k], 1);
    }
    // Peek at room types / rate plans specifically.
    for (const section of ['roomTypes', 'rooms', 'ratePlans', 'services', 'meals', 'property', 'policies']) {
      const v = (content as Record<string, unknown>)[section];
      if (Array.isArray(v) && v.length) {
        console.log(`\n  --- sample ${section}[0] ---`);
        console.log('  ' + JSON.stringify(v[0]).slice(0, 600));
      } else if (v && typeof v === 'object') {
        console.log(`\n  --- ${section} keys ---`);
        console.log('  ' + JSON.stringify(v).slice(0, 600));
      }
    }
  } catch (err) {
    console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log('\n(full JSON per cabinet written to scratchpad/exely-content-*.json)');
