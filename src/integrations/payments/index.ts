/**
 * Payment gateway abstraction. Online payment currently flows through the Exely
 * bookingFormLink; a real gateway (ePay etc.) swaps in behind this interface once
 * the hotel provides credentials.
 */

export interface PaymentResult {
  ok: boolean;
  paymentUrl?: string;
  error?: string;
}

export interface PaymentStatusResult {
  ok: boolean;
  status?: string;
  error?: string;
}

export interface PaymentGateway {
  createPayment(bookingNumber: string, amountKzt: number): Promise<PaymentResult>;
  checkStatus(paymentId: string): Promise<PaymentStatusResult>;
}

/** No real gateway configured: the bot honestly redirects guests to the booking link. */
export class StubPaymentGateway implements PaymentGateway {
  async createPayment(_bookingNumber: string, _amountKzt: number): Promise<PaymentResult> {
    return { ok: false, error: 'PAYMENT_GATEWAY_NOT_CONFIGURED' };
  }

  async checkStatus(_paymentId: string): Promise<PaymentStatusResult> {
    return { ok: false, error: 'PAYMENT_GATEWAY_NOT_CONFIGURED' };
  }
}
