export interface Property {
  key: string;
  name: string;
  knowledge: string;
}

// Addresses, restaurant names, amenities, and WhatsApp numbers below are taken from the
// official kazzhol.com pages. PRICES are public-research estimates and MUST be confirmed with
// the owner before the live pitch.

const astana: Property = {
  key: 'astana',
  name: 'Hotel Kazzhol Astana',
  knowledge: `
PROPERTY: Hotel Kazzhol Astana — a 4-star business hotel in Astana, Kazakhstan.

ADDRESS: pr. Balkantau 213, Astana. Roughly 10 minutes by car from the Bayterek monument.
CHECK-IN / CHECK-OUT: Check-in from 14:00, check-out until 12:00.
ROOMS: Standard, Comfort, and Suite rooms. Indicative rates from about 25,000 KZT (~USD 55)
per night; exact prices depend on dates and room type.
DINING: On-site restaurant "Fergana".
AMENITIES: Free Wi-Fi throughout, breakfast available, conference / meeting halls, parking,
24-hour front desk.
CONTACT: WhatsApp +7 776 412 6353; reservations email reservationastana@hotelkazzhol.kz.
LANGUAGES SPOKEN BY STAFF: Kazakh, Russian, English.
BOOKING: For specific dates and live availability the reservations team confirms by message
or phone. This assistant can take a booking request and the team will confirm availability.
`.trim(),
};

const almaty: Property = {
  key: 'almaty',
  name: 'Hotel Kazzhol Almaty',
  knowledge: `
PROPERTY: Hotel Kazzhol Almaty — a modern business hotel in the heart of Almaty, Kazakhstan.

ADDRESS: Gogol Street 127/1, Almaty.
CHECK-IN / CHECK-OUT: Check-in from 14:00, check-out until 12:00.
ROOMS: Standard, Comfort, and Suite rooms. Indicative rates from about 28,000 KZT (~USD 60)
per night; exact prices depend on dates and room type.
DINING: On-site restaurant serving Kazakh and European cuisine.
AMENITIES: AquaFit wellness complex with a swimming pool, free Wi-Fi, breakfast available,
conference / meeting halls, parking, 24-hour front desk.
CONTACT: WhatsApp +7 708 709 3000; reservations email booking@hotelkazzhol.kz.
LANGUAGES SPOKEN BY STAFF: Kazakh, Russian, English.
BOOKING: For specific dates and live availability the reservations team confirms by message
or phone. This assistant can take a booking request and the team will confirm availability.
`.trim(),
};

const parkAlmaty: Property = {
  key: 'park_almaty',
  name: 'Hotel Kazzhol Park Almaty',
  knowledge: `
PROPERTY: Hotel Kazzhol Park Almaty — a 4-star hotel in Almaty, Kazakhstan, with 112 rooms.

LOCATION: Almaty.
CHECK-IN / CHECK-OUT: Check-in from 14:00, check-out until 12:00.
ROOMS: 112 rooms across Standard, Comfort, and Suite categories. Indicative rates from about
38,000 KZT (~USD 83) per night; exact prices depend on dates and room type.
DINING: On-site restaurant.
AMENITIES: Free Wi-Fi, breakfast available, conference / meeting rooms, parking,
24-hour front desk.
CONTACT: WhatsApp +7 708 906 0661; reservations email park1@kazzhol.com.
LANGUAGES SPOKEN BY STAFF: Kazakh, Russian, English.
BOOKING: For specific dates and live availability the reservations team confirms by message
or phone. This assistant can take a booking request and the team will confirm availability.
`.trim(),
};

export const properties: Record<string, Property> = { astana, almaty, park_almaty: parkAlmaty };
export const propertyList: Property[] = [astana, almaty, parkAlmaty];
