export interface Property {
  key: string;
  name: string;
  /** Exely Connect property id, when this hotel is wired to the live API. */
  exelyPropertyId?: string;
  /** Guest-facing WhatsApp number. */
  whatsapp?: string;
  knowledge: string;
}

// Addresses, restaurant names, amenities, and WhatsApp numbers below are taken from the
// official kazzhol.com pages. Indicative rates are public-research estimates kept only as a
// rough fallback anchor; real prices always come from the live availability tool.

const astana: Property = {
  key: 'astana',
  name: 'Hotel Kazzhol Astana',
  whatsapp: '+7 776 412 6353',
  knowledge: `
PROPERTY: Hotel Kazzhol Astana — a modern business hotel for business travelers and tourists,
with cosy rooms, high service, a restaurant and a location near the capital's business and
administrative centers. (public site)

ADDRESS: pr. Balkantau 213, Astana. Roughly 10 minutes by car from the Bayterek monument.
CHECK-IN / CHECK-OUT: Check-in from 14:00, check-out until 12:00. (unconfirmed — Almaty turned
out to be 15:00; verify with staff.)
ROOM CATEGORIES (from the public site kazzhol.com/ru/astana; sizes/capacity public, confirm live):
- Standard — 25 m², up to 2 guests.
- Comfort — 31 m², up to 2 guests.
- Junior Suite (Полулюкс) — 33 m², up to 2 guests.
- Suite (Люкс) — 45 m², up to 2 guests.
- Business Suite (Бизнес-Люкс) — 70 m², up to 3 guests.
- Family Comfort — 40 m², up to 4 guests.
PRICES: always confirm via the live availability tool (check_availability); the indicative
anchor is about 25,000 KZT (~USD 55) per night for a Standard — approximate only, never a quote.
DINING: On-site restaurant "Fergana" (Фергана).
WELLNESS: swimming pool, sauna, massage, and a modern gym. (public site)
AMENITIES: free Wi-Fi, breakfast available, conference / meeting halls of various capacities
(good for events and conferences), parking, 24-hour front desk.
CONTACT: WhatsApp +7 776 412 6353; reservations email reservationastana@hotelkazzhol.kz.
LANGUAGES SPOKEN BY STAFF: Kazakh, Russian, English.
BOOKING: This assistant books directly (or sends a personal secure payment link); the
reservations team confirms special cases by message or phone.
`.trim(),
};

const almaty: Property = {
  key: 'almaty',
  name: 'Hotel Kazzhol Almaty',
  exelyPropertyId: '801',
  whatsapp: '+7 708 709 3000',
  // Facts below marked (Exely) are VERIFIED against the live Exely Content API on 2026-07-12.
  knowledge: `
PROPERTY: Hotel Kazzhol Almaty — a modern 4-star business hotel in the heart of Almaty,
Kazakhstan, combining comfort, national character and a high level of service. (Exely)

ADDRESS: Gogol Street 127/1, Almaty (050000). Near the business and cultural center. (Exely)
CHECK-IN / CHECK-OUT: Check-in from 15:00, check-out until 12:00. (Exely)
ROOM CATEGORIES (Exely; sizes and capacity verified):
- Standard Double / Standard Twin — 20 m², up to 2 adults. Renovated modern rooms.
- Comfort DLux Double / Twin — 28 m², 2 adults + extra bed (twin also fits kids 0-12).
  Located in the new nine-storey building.
- Deluxe Apartments — 32 m², spacious apartment-style, up to 2 adults + extra.
- Deluxe Terrace — 28 m², room with its own terrace, up to 2 adults.
- Junior Suite (King bed or 2 Queen beds) — 32 m², brand-new suites, fits families
  (2 adults + children 0-12 + extra bed).
- Family Room — 32 m², two large beds, made for families with children.
- Business Lux — 60 m², two-room suite, quiet luxury, up to 2 adults + extra.
PRICES: always confirm via the live availability tool (check_availability); indicative anchor
is about 28,000 KZT (~USD 60) per night for a Standard — approximate only, never a quote.
The Best Available Rate includes breakfast and fitness-center access. (Exely)
DINING: Restaurant "Salt" — Kazakhstani and European cuisine. Bar. Room service. Half-board
(lunch or dinner) can be added. (Exely)
WELLNESS: AquaFit complex — swimming pool (free for guests), sauna (free), gym and fitness.
(Exely)
AMENITIES: free Wi-Fi, FREE parking, conference halls, laundry & dry-cleaning, luggage room,
ATM, registration of foreign citizens, smoking and non-smoking rooms, elevator, video
surveillance, 24-hour front desk. (Exely)
EXTRAS & TOURS bookable via the hotel: airport/city transfer; day tours — "BUGGY" (Zailiyskiy
Alatau peaks), trekking to Kok-Zhailau, evening Almaty city tour (3.5h, daily from 18:00);
fruit & dessert plate to the room. Prices on request — capture a lead, the team confirms.
CONTACT: WhatsApp +7 708 709 3000; reservations email booking@hotelkazzhol.kz;
phone +7 (727) 338-38-98. (Exely)
LANGUAGES SPOKEN BY STAFF: Kazakh, Russian, English.
BOOKING: This assistant books directly (or sends a personal secure payment link); the
reservations team confirms special cases by message or phone.
`.trim(),
};

const parkAlmaty: Property = {
  key: 'park_almaty',
  name: 'Hotel Kazzhol Park Almaty',
  whatsapp: '+7 708 906 0661',
  knowledge: `
PROPERTY: Hotel Kazzhol Park Almaty — a comfortable business hotel in Almaty with stylish
rooms, high service and a restaurant, near business centers and city attractions. (public site)

ADDRESS: ul. Nauryzbai Batyra 108, Almaty. (public site)
CHECK-IN / CHECK-OUT: Check-in from 14:00, check-out until 12:00. (unconfirmed — verify; Almaty
is 15:00.)
ROOM CATEGORIES (from the public site kazzhol.com/ru/almaty-park; sizes/capacity public, confirm live):
- Standard — 26 m², up to 2 guests.
- Junior Suite — 45 m², up to 4 guests.
- Business Suite (Бизнес Люкс) — 65 m², up to 3 guests.
- Family Room — 50 m², up to 5 guests.
- Two-level LWB (Двухэтажный) — 65 m², up to 4 guests.
PRICES: always confirm via the live availability tool (check_availability); the indicative
anchor is about 38,000 KZT (~USD 83) per night — approximate only, never a quote.
DINING: On-site restaurant "Sapori Veri" (varied cuisine).
AMENITIES: free Wi-Fi, breakfast available, conference / meeting halls of various capacities,
parking, 24-hour front desk.
CONTACT: WhatsApp +7 708 906 0661; reservations email park1@kazzhol.com.
LANGUAGES SPOKEN BY STAFF: Kazakh, Russian, English.
BOOKING: This assistant books directly (or sends a personal secure payment link); the
reservations team confirms special cases by message or phone.
`.trim(),
};

export const properties: Record<string, Property> = { astana, almaty, park_almaty: parkAlmaty };
export const propertyList: Property[] = [astana, almaty, parkAlmaty];
