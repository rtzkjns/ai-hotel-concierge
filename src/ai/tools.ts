import type Anthropic from '@anthropic-ai/sdk';

/**
 * Anthropic tool definitions for the Kazzhol hotel assistant.
 * Handlers are injected into the orchestrator as a generic ToolHandlers map,
 * so this module stays free of integration imports.
 */

export type PropertyKey = 'astana' | 'almaty' | 'park_almaty';

export type UpsellKind = 'early_checkin' | 'late_checkout' | 'upgrade';

export type EscalationType = 'complaint' | 'human_requested' | 'cannot_help' | 'data_deletion';

export interface CheckAvailabilityInput {
  checkIn: string;
  checkOut: string;
  guests: number;
  childAges?: number[];
  promoCode?: string;
  property?: PropertyKey;
}

export interface GetRoomInfoInput {
  topic?: string;
  property?: PropertyKey;
}

export interface CreateBookingInput {
  checkIn: string;
  checkOut: string;
  guests: number;
  roomTypeId: string;
  ratePlanId: string;
  guestFirstName: string;
  guestLastName: string;
  guestPhone: string;
  guestEmail?: string;
  comment?: string;
  upsellAccepted?: UpsellKind[];
  childAges?: number[];
  property?: PropertyKey;
}

export interface GetBookingStatusInput {
  bookingNumber: string;
}

export interface CancelBookingInput {
  bookingNumber: string;
  reason: string;
  confirmedByGuest: boolean;
}

export interface CheckPromoCodeInput {
  code: string;
}

export interface CreatePaymentInput {
  bookingNumber: string;
  amountKzt: number;
}

export interface SubmitMiceRequestInput {
  eventDate: string;
  peopleCount: number;
  halls?: string;
  catering?: string;
  budget?: string;
  contactName: string;
  contactPhone: string;
  notes?: string;
}

export interface CaptureLeadInput {
  summary: string;
  contactName?: string;
  contactPhone?: string;
}

export interface EscalateInput {
  reason: string;
  summary: string;
  type: EscalationType;
}

const propertySchema = {
  type: 'string' as const,
  enum: ['astana', 'almaty', 'park_almaty'],
  description:
    "Hotel key. Defaults to the hotel this conversation belongs to; pass the other hotel's " +
    'key when the guest asks about a sister Kazzhol hotel.',
};

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'check_availability',
    description:
      'Look up LIVE room availability and prices for specific dates. Always call this before ' +
      'quoting any price or saying whether rooms are free — never guess and never quote from ' +
      'memory. Returns room offers with prices in KZT.',
    input_schema: {
      type: 'object',
      properties: {
        checkIn: { type: 'string', description: 'Check-in date, YYYY-MM-DD' },
        checkOut: { type: 'string', description: 'Check-out date, YYYY-MM-DD' },
        guests: { type: 'number', description: 'Number of ADULT guests' },
        childAges: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Ages of children on the stay, if any, e.g. [5, 9]. Hotels price children by age, so ' +
            'pass this whenever the guest mentions kids — do NOT fold children into the adult count.',
        },
        // promoCode was declared here but never read anywhere in the code: the model believed the
        // discount had been applied while the search ran at full price. Exely applies promo codes
        // on the booking form itself, so the field is removed rather than faked — the prompt tells
        // the guest to enter the code there, and check_promo_code records it for the team.
        property: propertySchema,
      },
      required: ['checkIn', 'checkOut', 'guests'],
    },
  },
  {
    name: 'get_room_info',
    description:
      "Get the hotel's STATIC reference info (room categories, descriptions, amenities, services). " +
      'Use when the guest asks what rooms exist, what they include, or about hotel amenities. This ' +
      'is NOT live pricing or availability — for those always call check_availability.',
    input_schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: "Optional topic filter, e.g. 'rooms', 'services', a room category name.",
        },
        property: propertySchema,
      },
      required: [],
    },
  },
  {
    name: 'create_booking',
    description:
      'Create a real booking. Call ONLY after the guest has confirmed a summary of all details ' +
      '(dates, room, rate, name, phone) in chat. Never call it before that explicit confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        checkIn: { type: 'string', description: 'Check-in date, YYYY-MM-DD' },
        checkOut: { type: 'string', description: 'Check-out date, YYYY-MM-DD' },
        guests: { type: 'number', description: 'Number of ADULT guests' },
        childAges: {
          type: 'array',
          items: { type: 'number' },
          description: 'Ages of children on the stay, if any, e.g. [5, 9]. Same as in check_availability.',
        },
        roomTypeId: { type: 'string', description: 'Room type id from a check_availability offer' },
        ratePlanId: { type: 'string', description: 'Rate plan id from a check_availability offer' },
        guestFirstName: { type: 'string', description: 'Guest first name' },
        guestLastName: { type: 'string', description: 'Guest last name' },
        guestPhone: { type: 'string', description: 'Guest phone number' },
        guestEmail: { type: 'string', description: 'Guest email, if given' },
        comment: { type: 'string', description: 'Special requests / notes for the hotel' },
        upsellAccepted: {
          type: 'array',
          items: { type: 'string', enum: ['early_checkin', 'late_checkout', 'upgrade'] },
          description: 'Upsells the guest accepted, if any.',
        },
        property: propertySchema,
      },
      required: [
        'checkIn',
        'checkOut',
        'guests',
        'roomTypeId',
        'ratePlanId',
        'guestFirstName',
        'guestLastName',
        'guestPhone',
      ],
    },
  },
  {
    name: 'get_booking_status',
    description: 'Look up the current status of an existing booking by its booking number.',
    input_schema: {
      type: 'object',
      properties: {
        bookingNumber: { type: 'string', description: 'Booking number' },
      },
      required: ['bookingNumber'],
    },
  },
  {
    name: 'cancel_booking',
    description:
      'Cancel an existing booking. The guest must explicitly confirm the cancellation in chat ' +
      'first — set confirmedByGuest=true only after that confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        bookingNumber: { type: 'string', description: 'Booking number to cancel' },
        reason: { type: 'string', description: 'Why the guest cancels' },
        confirmedByGuest: {
          type: 'boolean',
          description: 'True only after the guest explicitly confirmed the cancellation in chat.',
        },
      },
      required: ['bookingNumber', 'reason', 'confirmedByGuest'],
    },
  },
  {
    name: 'check_promo_code',
    description: 'Check whether a promo code is valid and what it gives.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The promo code as the guest wrote it' },
      },
      required: ['code'],
    },
  },
  {
    name: 'create_payment',
    description:
      'Create an online payment for a booking. If the gateway is not configured, direct the ' +
      'guest to the personal booking link instead.',
    input_schema: {
      type: 'object',
      properties: {
        bookingNumber: { type: 'string', description: 'Booking number to pay for' },
        amountKzt: { type: 'number', description: 'Amount in KZT' },
      },
      required: ['bookingNumber', 'amountKzt'],
    },
  },
  {
    name: 'submit_mice_request',
    description:
      'Submit a MICE request: banquets, conferences, corporate events, or group stays of 10+ ' +
      'people. Collect the essentials conversationally first.',
    input_schema: {
      type: 'object',
      properties: {
        eventDate: { type: 'string', description: 'Event date or date range' },
        peopleCount: { type: 'number', description: 'Expected number of people' },
        halls: { type: 'string', description: 'Halls / rooms requested, if discussed' },
        catering: { type: 'string', description: 'Catering / coffee breaks, if discussed' },
        budget: { type: 'string', description: 'Budget expectations, if shared' },
        contactName: { type: 'string', description: 'Contact person name' },
        contactPhone: { type: 'string', description: 'Contact phone number' },
        notes: { type: 'string', description: 'Anything else the MICE manager should know' },
      },
      required: ['eventDate', 'peopleCount', 'contactName', 'contactPhone'],
    },
  },
  {
    name: 'register_completed_booking',
    description:
      'Record a booking the GUEST completed themselves on the Exely booking form, after they send ' +
      'you the booking number from their confirmation e-mail. Use this the moment a guest reports ' +
      'they finished booking, or sends a number that looks like a reservation number. It links ' +
      'the booking to this chat, tells the staff, and lets you confirm receipt to the guest. ' +
      'NEVER call it with a number you invented or assumed — only one the guest actually gave.',
    input_schema: {
      type: 'object',
      properties: {
        bookingNumber: {
          type: 'string',
          description: 'The reservation number exactly as the guest sent it',
        },
        guestName: { type: 'string', description: 'Guest name, if known' },
        checkIn: { type: 'string', description: 'Check-in date YYYY-MM-DD, if known' },
        checkOut: { type: 'string', description: 'Check-out date YYYY-MM-DD, if known' },
        property: propertySchema,
      },
      required: ['bookingNumber'],
    },
  },
  {
    name: 'capture_lead',
    description:
      'Save an interest the conversation could not finish: a question to confirm with the team, ' +
      'an undecided guest, a request outside the knowledge base. Never invent an answer — ' +
      'capture it and tell the guest you will get back to them.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One-line summary of what the guest needs' },
        contactName: { type: 'string', description: 'Guest name, if known' },
        contactPhone: { type: 'string', description: 'Guest phone, if known' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'Hand the conversation to a human staff member. A last resort: use only for aggression, ' +
      'legal threats, personal-data deletion requests, a repeated explicit demand for a person, ' +
      'or a severe complaint you truly cannot resolve. Not knowing a fact is NOT a reason.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short reason for escalation' },
        summary: { type: 'string', description: 'One-line summary of what the guest needs' },
        type: {
          type: 'string',
          enum: ['complaint', 'human_requested', 'cannot_help', 'data_deletion'],
          description: 'Escalation category',
        },
      },
      required: ['reason', 'summary', 'type'],
    },
  },
];
