/**
 * AMO CRM abstraction. The stub records leads as analytics events so nothing is
 * lost; a real client swaps in behind this interface once AMO_ACCESS_TOKEN exists.
 */

export type CrmLeadKind = 'booking' | 'mice' | 'generic';

export interface AmoCrmClient {
  createLead(kind: CrmLeadKind, data: Record<string, unknown>): Promise<{ ok: boolean; crmId?: string }>;
  updateStatus(crmId: string, status: string): Promise<{ ok: boolean }>;
}

export class StubAmoCrm implements AmoCrmClient {
  constructor(private readonly recordEvent: (type: string, data?: unknown) => void) {}

  async createLead(kind: CrmLeadKind, data: Record<string, unknown>): Promise<{ ok: boolean; crmId?: string }> {
    this.recordEvent('crm_lead_stub', { kind, data });
    return { ok: true };
  }

  async updateStatus(_crmId: string, _status: string): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}
