import { decode } from 'light-bolt11-decoder';

/**
 * The few BOLT11 fields a payout needs. Decoding never verifies the invoice's
 * signature — the paying wallet does that — it only reads what the invoice
 * claims, which is exactly what the amount cross-check must compare against.
 */
export interface DecodedInvoice {
  /** Amount in millisatoshis; NaN for an amountless invoice. */
  amountMsat: number;
  paymentHash: string;
  /** Unix seconds the invoice was created. */
  timestamp: number;
  /** Seconds after `timestamp` the invoice stays payable. */
  expirySeconds: number;
}

/** Decode a bolt11 invoice; throws on anything that isn't one. */
export function decodeInvoice(bolt11: string): DecodedInvoice {
  const decoded = decode(bolt11.trim());
  let amountMsat = NaN;
  let paymentHash: string | undefined;
  let timestamp = 0;
  for (const section of decoded.sections) {
    if (section.name === 'amount') {
      amountMsat = Number(section.value);
    } else if (section.name === 'payment_hash') {
      paymentHash = section.value;
    } else if (section.name === 'timestamp') {
      timestamp = section.value;
    }
  }
  if (!paymentHash || !/^[0-9a-f]{64}$/i.test(paymentHash)) {
    throw new Error('Invoice has no payment hash');
  }
  return {
    amountMsat,
    paymentHash: paymentHash.toLowerCase(),
    timestamp,
    expirySeconds: decoded.expiry ?? 3600,
  };
}

/** Payment hash of a bolt11, or undefined when it can't be decoded. */
export function paymentHashFromBolt11(bolt11: string): string | undefined {
  try {
    return decodeInvoice(bolt11).paymentHash;
  } catch {
    return undefined;
  }
}

/**
 * True when the invoice can still be paid, with a safety margin so a payment
 * isn't started moments before it would be rejected.
 */
export function invoiceIsLive(invoice: DecodedInvoice, nowSeconds = Date.now() / 1000, marginSeconds = 60): boolean {
  return invoice.timestamp + invoice.expirySeconds - marginSeconds > nowSeconds;
}
