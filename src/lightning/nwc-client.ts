import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import type { Event, EventTemplate } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import * as nip44 from 'nostr-tools/nip44';
import * as nip04 from 'nostr-tools/nip04';
import { SimplePool } from 'nostr-tools/pool';
import { hexToBytes } from 'nostr-tools/utils';
import { createHash } from 'crypto';
import { decodeInvoice } from './bolt11.js';

/**
 * A minimal NIP-47 (Nostr Wallet Connect) client, run inside the extension.
 *
 * The connection string never leaves the creator's machine: this client talks
 * to their wallet directly, over the wallet's own relay, end-to-end encrypted.
 *
 * Built on nostr-tools rather than a wallet SDK so timeouts are explicit (a
 * cold Lightning route can take minutes) and every failure maps onto an
 * outcome the payout journal can act on safely — see `NwcOutcome`.
 */

export const NWC_INFO_KIND = 13194;
export const NWC_REQUEST_KIND = 23194;
export const NWC_RESPONSE_KIND = 23195;

/** Reply budgets. Paying can legitimately take minutes; reads should not. */
export const PAY_INVOICE_REPLY_TIMEOUT_MS = 180_000;
export const READ_REPLY_TIMEOUT_MS = 30_000;
const INFO_LOOKUP_MAX_WAIT_MS = 5_000;
const PUBLISH_TIMEOUT_MS = 10_000;

/** The relay operations the client needs — a SimplePool, or a fake in tests. */
export interface NwcPool {
  publish(relays: string[], event: Event): Promise<string>[];
  subscribe(
    relays: string[],
    filter: Filter,
    params: { onevent: (event: Event) => void; onclose?: (reasons: string[]) => void }
  ): { close: () => void };
  querySync(relays: string[], filter: Filter, params?: { maxWait?: number }): Promise<Event[]>;
  close(relays: string[]): void;
}

// --- Connection string --------------------------------------------------------

export interface NwcConnection {
  walletPubkey: string;
  relays: string[];
  secret: string;
  lud16?: string;
}

/**
 * Parse and validate a `nostr+walletconnect://` URI. Throws a message safe to
 * show the user — it never echoes the secret.
 */
export function parseNwcUri(uri: string): NwcConnection {
  if (typeof uri !== 'string' || uri.trim().length === 0) {
    throw new Error('NWC URI is empty');
  }
  const trimmed = uri.trim();
  if (!/^nostr\+?walletconnect:\/\//i.test(trimmed)) {
    throw new Error('NWC URI must use the nostr+walletconnect:// scheme');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('NWC URI is not a valid URL');
  }
  const walletPubkey = (parsed.hostname || parsed.pathname.replace(/^\/+/, '')).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(walletPubkey)) {
    throw new Error('NWC URI is missing a valid wallet pubkey');
  }
  const relays = parsed.searchParams
    .getAll('relay')
    .map((r) => r.trim())
    .filter((r) => /^wss:\/\//i.test(r) || /^ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(r));
  if (relays.length === 0) {
    throw new Error('NWC URI is missing a wss:// relay parameter');
  }
  const secret = parsed.searchParams.get('secret') ?? '';
  if (!/^[0-9a-f]{64}$/i.test(secret)) {
    throw new Error('NWC URI is missing a valid secret parameter');
  }
  return {
    walletPubkey,
    relays,
    secret: secret.toLowerCase(),
    lud16: parsed.searchParams.get('lud16') ?? undefined,
  };
}

/** The wallet-service pubkey an NWC URI points at; undefined if unparseable. */
export function walletPubkeyFromNwcUri(uri: string): string | undefined {
  try {
    return parseNwcUri(uri).walletPubkey;
  } catch {
    return undefined;
  }
}

/**
 * Non-secret, display-only summary: the relay host and the `lud16` address.
 * Never returns the secret. `{}` on any parse failure.
 */
export function summarizeNwcUri(uri: string): { relay?: string; lud16?: string } {
  try {
    const c = parseNwcUri(uri);
    let relay = c.relays[0];
    try {
      relay = new URL(relay).hostname;
    } catch {
      /* keep the raw value */
    }
    return { relay, lud16: c.lud16 };
  } catch {
    return {};
  }
}

// --- Errors and outcomes ----------------------------------------------------------

/** No relay accepted the request, so the wallet can't have seen it. */
export class NwcPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NwcPublishError';
  }
}

/** The request went out but no reply arrived in time. */
export class NwcReplyTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`Your wallet didn't answer the ${method} request within ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'NwcReplyTimeoutError';
  }
}

/** The wallet answered with a NIP-47 error code (an explicit decline). */
export class NwcWalletError extends Error {
  /** The wallet's own text, tidied (e.g. "Wallet not found:" → "Wallet not found"). */
  public readonly walletMessage: string;

  constructor(
    public readonly code: string,
    message: string
  ) {
    const tidy = message.replace(/[\s:;,.-]+$/, '').trim();
    super(tidy ? `${code}: ${tidy}` : code);
    this.name = 'NwcWalletError';
    this.walletMessage = tidy;
  }
}

/** Host part of a Lightning address or LNURL host, lowercased; undefined if neither. */
export function addressDomain(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const v = value.trim().toLowerCase();
  const at = /^[^@\s]+@([^@\s]+\.[^@\s]+)$/.exec(v);
  if (at) {
    return at[1].replace(/^www\./, '');
  }
  try {
    return new URL(v).hostname.replace(/^www\./, '') || undefined;
  } catch {
    return undefined;
  }
}

/** True when two domains are the same service (equal, or one a subdomain of the other). */
export function sameService(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) {
    return false;
  }
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

const REFUSAL_TEXT: Record<string, string> = {
  INSUFFICIENT_BALANCE:
    "Your wallet doesn't have enough sats for this payout (plus routing fees).",
  QUOTA_EXCEEDED:
    'This payout is over the budget set on your wallet connection. Raise the budget in your wallet app.',
  RATE_LIMITED: 'Your wallet is rate-limiting this connection. Wait a moment and try again.',
  RESTRICTED:
    "This wallet connection isn't allowed to pay invoices. Check its permissions in your wallet app.",
  UNAUTHORIZED:
    "Your wallet no longer accepts this connection. Reconnect it (Connect Lightning Wallet) or create a new one in your wallet app.",
  PAYMENT_FAILED: "Your wallet couldn't route the payment to the claimant.",
  NOT_IMPLEMENTED: "Your wallet doesn't support paying invoices over this connection.",
  INTERNAL: 'Your wallet hit an internal error while paying.',
};

export interface RefusalContext {
  /** The claimant's payout address (Lightning address or LNURL). */
  claimantAddress?: string;
  /** Domain of the creator's wallet (from its NWC `lud16`, else its relay). */
  walletDomain?: string;
}

/**
 * Explain a wallet's refusal to pay in plain words. The wallet's own text is
 * always quoted, because its wording is often the only clue to what's wrong.
 */
export function describeWalletRefusal(
  code: string,
  walletMessage: string,
  ctx: RefusalContext = {}
): string {
  const parts = [REFUSAL_TEXT[code] ?? 'Your wallet refused the payment.'];
  if (walletMessage) {
    parts.push(`(Your wallet said: "${walletMessage}")`);
  }
  const claimantDomain = addressDomain(ctx.claimantAddress);
  const notFound = /not found|no such (user|wallet|account)|unknown (user|wallet|account)/i.test(
    walletMessage
  );
  if (notFound || (code !== 'INSUFFICIENT_BALANCE' && code !== 'QUOTA_EXCEEDED' && sameService(claimantDomain, ctx.walletDomain))) {
    const where = sameService(claimantDomain, ctx.walletDomain)
      ? ` is on the same service as your wallet (${claimantDomain}) and`
      : '';
    parts.push(
      `The claimant's Lightning address${ctx.claimantAddress ? ` ${ctx.claimantAddress}` : ''}${where} ` +
        'may not have a working wallet behind it. Ask the claimant to check that it can receive, ' +
        'or to claim again with a different address.'
    );
  }
  return parts.join(' ');
}

/**
 * Whether a failed payout attempt definitely moved no money.
 *
 *   'failed'  — the wallet never got the request, or explicitly declined it.
 *               Safe to release the claim and retry.
 *   'unknown' — the request was published but no usable answer came back.
 *               The wallet MAY have paid; releasing would risk a double
 *               payment, so the claim stays held until a lookup settles it.
 */
export type NwcOutcome = 'failed' | 'unknown';

/** Only provable non-payments are 'failed'; anything else is 'unknown'. */
export function classifyNwcError(err: unknown): NwcOutcome {
  if (err instanceof NwcPublishError || err instanceof NwcWalletError) {
    return 'failed';
  }
  return 'unknown';
}

export class NwcPayoutError extends Error {
  constructor(
    message: string,
    public readonly outcome: NwcOutcome = 'unknown',
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'NwcPayoutError';
  }
}

/** What the wallet says about a payment we attempted. */
export type NwcPaymentLookup =
  | { state: 'settled'; preimage: string }
  | { state: 'failed' }
  | { state: 'pending' }
  | { state: 'unknown'; reason: string };

export interface NwcInfo {
  methods: string[];
  encryption: 'nip44_v2' | 'nip04';
}

/** sha256(preimage) === paymentHash — the proof a payment settled. */
export function preimageMatches(preimage: string, paymentHash: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(preimage)) {
    return false;
  }
  return (
    createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex') ===
    paymentHash.toLowerCase()
  );
}

// --- Client ------------------------------------------------------------------------

export class NwcClient {
  private readonly connection: NwcConnection;
  private readonly secretBytes: Uint8Array;
  private readonly pool: NwcPool;
  private readonly ownsPool: boolean;
  private info: NwcInfo | undefined;
  private readonly payReplyTimeoutMs: number;

  constructor(uri: string, opts: { pool?: NwcPool; payReplyTimeoutMs?: number } = {}) {
    this.connection = parseNwcUri(uri);
    this.payReplyTimeoutMs = opts.payReplyTimeoutMs ?? PAY_INVOICE_REPLY_TIMEOUT_MS;
    this.secretBytes = hexToBytes(this.connection.secret);
    this.ownsPool = !opts.pool;
    this.pool = opts.pool ?? (new SimplePool() as unknown as NwcPool);
  }

  get walletPubkey(): string {
    return this.connection.walletPubkey;
  }

  /** Domain of this wallet's service: its `lud16`, else its relay. Display/diagnosis only. */
  get walletDomain(): string | undefined {
    return addressDomain(this.connection.lud16) ?? addressDomain(this.connection.relays[0]);
  }

  /** Read the wallet's info event: supported methods and encryption. */
  async getInfo(): Promise<NwcInfo> {
    if (this.info) {
      return this.info;
    }
    const events = await this.pool.querySync(
      this.connection.relays,
      { kinds: [NWC_INFO_KIND], authors: [this.connection.walletPubkey], limit: 1 },
      { maxWait: INFO_LOOKUP_MAX_WAIT_MS }
    );
    const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
    const methods = latest ? latest.content.trim().split(/\s+/).filter(Boolean) : [];
    // Per NIP-47, a wallet whose info event carries no `encryption` tag only
    // speaks NIP-04.
    const encTag = latest?.tags.find((t) => t[0] === 'encryption')?.[1] ?? '';
    const encryption = encTag.split(/\s+/).includes('nip44_v2') ? 'nip44_v2' : 'nip04';
    this.info = { methods, encryption };
    return this.info;
  }

  private async encrypt(plaintext: string): Promise<string> {
    const { encryption } = await this.getInfo();
    return encryption === 'nip44_v2'
      ? nip44.encrypt(plaintext, nip44.getConversationKey(this.secretBytes, this.connection.walletPubkey))
      : nip04.encrypt(this.secretBytes, this.connection.walletPubkey, plaintext);
  }

  private decrypt(ciphertext: string): string {
    try {
      return nip44.decrypt(
        ciphertext,
        nip44.getConversationKey(this.secretBytes, this.connection.walletPubkey)
      );
    } catch {
      return nip04.decrypt(this.secretBytes, this.connection.walletPubkey, ciphertext);
    }
  }

  /**
   * Send one NIP-47 request and wait for its reply. Throws NwcPublishError,
   * NwcWalletError or NwcReplyTimeoutError so callers can classify the outcome.
   */
  async request<T>(method: string, params: Record<string, unknown>, replyTimeoutMs: number): Promise<T> {
    const info = await this.getInfo();
    const template: EventTemplate = {
      kind: NWC_REQUEST_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', this.connection.walletPubkey], ...(info.encryption === 'nip44_v2' ? [['encryption', 'nip44_v2']] : [])],
      content: await this.encrypt(JSON.stringify({ method, params })),
    };
    const event = finalizeEvent(template, this.secretBytes);

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Subscribe BEFORE publishing so a fast reply can't be missed.
      const sub = this.pool.subscribe(
        this.connection.relays,
        {
          kinds: [NWC_RESPONSE_KIND],
          authors: [this.connection.walletPubkey],
          '#e': [event.id],
        },
        {
          onevent: (reply) => {
            if (settled) {
              return;
            }
            let body: { result_type?: string; error?: { code?: string; message?: string } | null; result?: T };
            try {
              body = JSON.parse(this.decrypt(reply.content));
            } catch {
              return; // undecryptable — not ours, keep waiting
            }
            finish(() => {
              if (body.error) {
                reject(new NwcWalletError(body.error.code ?? 'OTHER', body.error.message ?? ''));
              } else {
                resolve(body.result as T);
              }
            });
          },
        }
      );
      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        try {
          sub.close();
        } catch {
          /* already closed */
        }
        fn();
      };

      const publishes = this.pool.publish(this.connection.relays, event).map((p) =>
        Promise.race([
          p,
          new Promise<never>((_, rej) => {
            const t = setTimeout(() => rej(new Error('publish timeout')), PUBLISH_TIMEOUT_MS);
            // Never let this guard keep the process (or Jest) alive.
            (t as { unref?: () => void }).unref?.();
          }),
        ])
      );
      Promise.allSettled(publishes).then((results) => {
        if (!results.some((r) => r.status === 'fulfilled')) {
          finish(() => reject(new NwcPublishError('No wallet relay accepted the request')));
          return;
        }
        if (!settled) {
          timer = setTimeout(
            () => finish(() => reject(new NwcReplyTimeoutError(method, replyTimeoutMs))),
            replyTimeoutMs
          );
        }
      });
    });
  }

  /**
   * Pay `bolt11`, which must ask for exactly `expectedAmountSats`. Throws
   * NwcPayoutError carrying whether money provably did not move.
   */
  async payInvoice(
    bolt11: string,
    expectedAmountSats: number,
    replyTimeoutMs = this.payReplyTimeoutMs
  ): Promise<{ preimage: string; feesPaidSats: number }> {
    let paymentHash: string;
    try {
      const invoice = decodeInvoice(bolt11);
      if (invoice.amountMsat !== expectedAmountSats * 1000) {
        throw new Error(
          `invoice is for ${invoice.amountMsat / 1000} sats, expected ${expectedAmountSats}`
        );
      }
      paymentHash = invoice.paymentHash;
    } catch (err) {
      // Rejected before the wallet was contacted — definitely no payment.
      throw new NwcPayoutError(err instanceof Error ? err.message : String(err), 'failed', err);
    }

    let result: { preimage?: string; fees_paid?: number } | undefined;
    try {
      result = await this.request('pay_invoice', { invoice: bolt11 }, replyTimeoutMs);
    } catch (err) {
      throw new NwcPayoutError(
        err instanceof Error ? err.message : 'NWC payout failed',
        classifyNwcError(err),
        err
      );
    }
    // A reply without a valid proof of payment may still mean the wallet paid.
    // Keep it 'unknown' so the caller reconciles instead of retrying blind.
    if (!result || typeof result.preimage !== 'string') {
      throw new NwcPayoutError('Your wallet returned no proof of payment', 'unknown');
    }
    if (!preimageMatches(result.preimage, paymentHash)) {
      throw new NwcPayoutError('Your wallet returned a proof of payment that does not match the invoice', 'unknown');
    }
    return {
      preimage: result.preimage.toLowerCase(),
      feesPaidSats: Math.round((typeof result.fees_paid === 'number' ? result.fees_paid : 0) / 1000),
    };
  }

  /**
   * Ask the wallet what happened to a payment. Never throws — every failure
   * degrades to `unknown`, which callers must treat as "keep the claim held".
   */
  async lookupPayment(ref: { paymentHash?: string; bolt11?: string }): Promise<NwcPaymentLookup> {
    const params = ref.paymentHash
      ? { payment_hash: ref.paymentHash }
      : ref.bolt11
        ? { invoice: ref.bolt11 }
        : undefined;
    if (!params) {
      return { state: 'unknown', reason: 'No payment hash or invoice to look up' };
    }
    try {
      const r = await this.request<{ state?: string; preimage?: string; settled_at?: number }>(
        'lookup_invoice',
        params,
        READ_REPLY_TIMEOUT_MS
      );
      const state = r?.state ?? (r?.settled_at ? 'settled' : undefined);
      if (state === 'settled') {
        const preimage = r?.preimage ?? '';
        if (ref.paymentHash && preimage && !preimageMatches(preimage, ref.paymentHash)) {
          return { state: 'unknown', reason: 'Wallet reported a preimage that does not match' };
        }
        // Settled without a preimage shouldn't happen, but money moved either way.
        return { state: 'settled', preimage: preimage || 'unknown-preimage' };
      }
      if (state === 'failed') {
        return { state: 'failed' };
      }
      if (state === 'pending' || state === 'accepted') {
        return { state: 'pending' };
      }
      return { state: 'unknown', reason: `Unrecognised lookup_invoice state: ${state ?? 'none'}` };
    } catch (err) {
      // NOT_FOUND / NOT_IMPLEMENTED / timeouts are all "we still don't know".
      return { state: 'unknown', reason: err instanceof Error ? err.message : 'lookup failed' };
    }
  }

  /** Release relay sockets (only when this client created the pool). */
  close(): void {
    if (this.ownsPool) {
      try {
        this.pool.close(this.connection.relays);
      } catch {
        /* best effort */
      }
    }
  }
}

/** The client's own public key — distinct from the wallet's. Test helper. */
export function nwcClientPubkey(uri: string): string {
  return getPublicKey(hexToBytes(parseNwcUri(uri).secret));
}
