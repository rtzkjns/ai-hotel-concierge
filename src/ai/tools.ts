import type Anthropic from '@anthropic-ai/sdk';

export interface BookingLeadArgs {
  checkIn: string;
  checkOut: string;
  guests: number;
  roomType: string;
  contactName: string;
  contactPhone: string;
  specialRequests?: string;
}

export interface EscalateArgs {
  reason: string;
  summary: string;
}

export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'capture_booking_lead',
    description:
      'Save a guest booking request once all details are collected. Use only when you have ' +
      'check-in date, check-out date, number of guests, room type, contact name, and phone.',
    input_schema: {
      type: 'object',
      properties: {
        checkIn: { type: 'string', description: 'Check-in date, YYYY-MM-DD' },
        checkOut: { type: 'string', description: 'Check-out date, YYYY-MM-DD' },
        guests: { type: 'number', description: 'Number of guests' },
        roomType: { type: 'string', description: 'Requested room type' },
        contactName: { type: 'string', description: 'Guest name' },
        contactPhone: { type: 'string', description: 'Guest phone number' },
        specialRequests: {
          type: 'string',
          description:
            'Any special requests or open questions to pass to the team (pets, infant/cot, ' +
            'airport transfer, accessibility, discounts, etc.). Omit if none.',
        },
      },
      required: ['checkIn', 'checkOut', 'guests', 'roomType', 'contactName', 'contactPhone'],
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'Hand the conversation to a human staff member. Use for complaints, upset guests, ' +
      'requests you cannot answer from the knowledge base, or explicit requests for a person.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short reason for escalation' },
        summary: { type: 'string', description: 'One-line summary of what the guest needs' },
      },
      required: ['reason', 'summary'],
    },
  },
];
