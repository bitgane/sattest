import { assertPublicHttpUrl, FetchGuardOptions, readJsonCapped, readTextCapped } from './ssrf.js';
import { decodeInvoice } from './bolt11.js';

/**
 * The LNURL-pay protocol (LUD-06 / LUD-16), run from the bounty creator's own
 * machine.
 *
 *   1. GET the LNURL (or `.well-known/lnurlp/<user>` for an LN address) →
 *      a `payRequest` with a `callback` URL and min/max sendable bounds.
 *   2. GET `<callback>?amount=<msat>` → `{ pr: <bolt11> }`.
 *
 * …then the check that matters: the returned invoice must ask for exactly the
 * amount requested. The LNURL server belongs to whoever filed the claim, and a
 * wallet pays whatever a bolt11 demands — without the cross-check a malicious
 * server could hand back a bigger invoice and overspend the creator.
 *
 * Every hop is SSRF-guarded, uses `redirect: 'manual'` so a redirect can't walk
 * past the guard, and reads its body under a byte cap.
 */

export const LNURL_HTTP_TIMEOUT_MS = 20_000;

/** The subset of fetch these hops use — injectable for tests. */
export type LnurlFetch = (
  url: string,
  init: { method: 'GET'; signal: AbortSignal; redirect: 'manual'; headers: Record<string, string> }
) => Promise<{ ok: boolean; status: number; body: unknown }>;

export interface LnurlOptions extends FetchGuardOptions {
  fetchImpl?: LnurlFetch;
}

const defaultFetch: LnurlFetch = (url, init) =>
  fetch(url, init) as unknown as ReturnType<LnurlFetch>;

/** Shape of the LUD-06 `payRequest` document, as much of it as we rely on. */
export interface LnurlPayRequest {
  tag?: string;
  callback?: string;
  minSendable?: number;
  maxSendable?: number;
  commentAllowed?: number;
  status?: string;
  reason?: string;
}

// --- bech32 (BIP-173) — just enough to decode an `lnurl1…` string -----------

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) {
        chk ^= BECH32_GENERATORS[i];
      }
    }
  }
  return chk >>> 0;
}

/** Decode a bech32 string to its human-readable part and 8-bit payload. */
export function bech32Decode(input: string): { prefix: string; bytes: Uint8Array } {
  const str = input.toLowerCase();
  if (str !== input && str.toUpperCase() !== input) {
    throw new Error('bech32: mixed case');
  }
  const sep = str.lastIndexOf('1');
  if (sep < 1 || sep + 7 > str.length) {
    throw new Error('bech32: bad separator position');
  }
  const prefix = str.slice(0, sep);
  const data: number[] = [];
  for (const ch of str.slice(sep + 1)) {
    const v = BECH32_CHARSET.indexOf(ch);
    if (v === -1) {
      throw new Error('bech32: invalid character');
    }
    data.push(v);
  }
  const expanded = [
    ...[...prefix].map((c) => c.charCodeAt(0) >> 5),
    0,
    ...[...prefix].map((c) => c.charCodeAt(0) & 31),
    ...data,
  ];
  if (bech32Polymod(expanded) !== 1) {
    throw new Error('bech32: checksum mismatch');
  }
  // 5-bit words → bytes, dropping the 6-word checksum.
  const words = data.slice(0, -6);
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (bits >= 5 || (acc << (8 - bits)) & 0xff) {
    throw new Error('bech32: non-zero padding');
  }
  return { prefix, bytes: Uint8Array.from(out) };
}

/**
 * Resolve an LN address ("alice@domain.tld"), bech32 LNURL or https URL to the
 * LNURL-pay endpoint.
 */
export function resolveLnurlEndpoint(input: string): string {
  const trimmed = input.trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
    const [name, domain] = trimmed.split('@');
    return `https://${domain.toLowerCase()}/.well-known/lnurlp/${encodeURIComponent(name)}`;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const lnurl = trimmed.replace(/^lightning:/i, '');
  if (/^lnurl1/i.test(lnurl)) {
    const { prefix, bytes } = bech32Decode(lnurl);
    if (prefix !== 'lnurl') {
      throw new Error('Not an LNURL');
    }
    return Buffer.from(bytes).toString('utf8');
  }
  throw new Error(
    'Unrecognised LNURL format: expected an LN address (alice@domain.tld), lnurl1… or https:// URL'
  );
}

async function getJson(url: string, opts: LnurlOptions): Promise<unknown> {
  await assertPublicHttpUrl(url, opts);
  const doFetch = opts.fetchImpl ?? defaultFetch;
  const response = await doFetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(LNURL_HTTP_TIMEOUT_MS),
    redirect: 'manual',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const detail = await readTextCapped(response, 200);
    throw new Error(`LNURL request failed: ${response.status}${detail ? ` (${detail})` : ''}`);
  }
  return readJsonCapped(response);
}

/** Hop 1 — resolve the LNURL and return its `payRequest` document. */
export async function fetchLnurlPayRequest(
  lnurl: string,
  opts: LnurlOptions = {}
): Promise<LnurlPayRequest> {
  const data = (await getJson(resolveLnurlEndpoint(lnurl), opts)) as LnurlPayRequest;
  if (data?.status === 'ERROR') {
    throw new Error(`LNURL error: ${data.reason || 'unknown'}`);
  }
  if (data?.tag !== 'payRequest' || !data.callback) {
    throw new Error('LNURL did not return a payRequest');
  }
  return data;
}

/** The LNURL's sendable bounds in millisats (for pre-checking a claim). */
export async function fetchLnurlLimits(
  lnurl: string,
  opts: LnurlOptions = {}
): Promise<{ minSendable: number; maxSendable: number }> {
  const pr = await fetchLnurlPayRequest(lnurl, opts);
  if (typeof pr.minSendable !== 'number' || typeof pr.maxSendable !== 'number') {
    throw new Error('LNURL did not report its sendable range');
  }
  return { minSendable: pr.minSendable, maxSendable: pr.maxSendable };
}

/** The integrity guard: the invoice must ask for exactly what we requested. */
export function assertInvoiceAmount(bolt11: string, expectedMsat: number): void {
  const { amountMsat } = decodeInvoice(bolt11);
  if (!Number.isFinite(amountMsat) || amountMsat !== expectedMsat) {
    throw new Error(
      `LNURL invoice amount ${amountMsat} msat does not match requested ${expectedMsat} msat`
    );
  }
}

/** Hop 2 + the amount cross-check — mint a bolt11 for exactly `amountMsat`. */
export async function fetchInvoiceFromPayRequest(
  payRequest: LnurlPayRequest,
  amountMsat: number,
  comment: string | undefined,
  opts: LnurlOptions = {}
): Promise<string> {
  if (
    typeof payRequest.minSendable !== 'number' ||
    typeof payRequest.maxSendable !== 'number' ||
    amountMsat < payRequest.minSendable ||
    amountMsat > payRequest.maxSendable
  ) {
    throw new Error(
      `Amount ${amountMsat} msat is outside this LNURL's range [${payRequest.minSendable}, ${payRequest.maxSendable}]`
    );
  }
  const callbackUrl = new URL(payRequest.callback as string);
  callbackUrl.searchParams.set('amount', String(amountMsat));
  if (comment && payRequest.commentAllowed && comment.length <= payRequest.commentAllowed) {
    callbackUrl.searchParams.set('comment', comment);
  }
  const data = (await getJson(callbackUrl.toString(), opts)) as {
    pr?: string;
    status?: string;
    reason?: string;
  };
  if (data?.status === 'ERROR') {
    throw new Error(`LNURL callback error: ${data.reason || 'unknown'}`);
  }
  if (!data?.pr || typeof data.pr !== 'string') {
    throw new Error('LNURL callback did not return a bolt11 invoice');
  }
  assertInvoiceAmount(data.pr, amountMsat);
  return data.pr;
}

/** Both hops end-to-end: LNURL → bolt11 for `amountMsat`, amount cross-checked. */
export async function fetchInvoiceForAmount(
  lnurl: string,
  amountMsat: number,
  comment?: string,
  opts: LnurlOptions = {}
): Promise<string> {
  const payRequest = await fetchLnurlPayRequest(lnurl, opts);
  return fetchInvoiceFromPayRequest(payRequest, amountMsat, comment, opts);
}
