import type { Event } from 'nostr-tools/pure';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { matchFilter, type Filter } from 'nostr-tools/filter';
import * as nip44 from 'nostr-tools/nip44';
import { bytesToHex } from 'nostr-tools/utils';
import { createHash, randomBytes } from 'crypto';
import { NWC_INFO_KIND, NWC_REQUEST_KIND, NWC_RESPONSE_KIND } from '../lightning/nwc-client.js';

/**
 * Test fixtures: an in-memory "relay network" with the SimplePool surface the
 * extension uses, and a scriptable NIP-47 wallet service that lives on it.
 * Not shipped (see .vscodeignore).
 */

interface Subscription {
  filter: Filter;
  onevent: (e: Event) => void;
  oneose?: () => void;
  closed: boolean;
}

export class MemoryPool {
  /** Every event ever accepted, in publish order. */
  readonly events: Event[] = [];
  private subs: Subscription[] = [];
  /** Relays that refuse publishes (simulate an outage). */
  rejecting = false;
  /** Count of publishes, for assertions. */
  publishCount = 0;

  publish(_relays: string[], event: Event): Promise<string>[] {
    this.publishCount++;
    if (this.rejecting) {
      return [Promise.reject(new Error('relay rejected'))];
    }
    this.store(event);
    return [Promise.resolve('ok')];
  }

  /** Store + fan out without counting as a client publish. */
  store(event: Event): void {
    // Addressable/replaceable semantics are a relay concern; tests that care
    // query everything and rely on the client to pick versions.
    if (!this.events.some((e) => e.id === event.id)) {
      this.events.push(event);
    }
    for (const sub of this.subs) {
      if (!sub.closed && matchFilter(sub.filter, event)) {
        // Asynchronous, like a real relay.
        setImmediate(() => !sub.closed && sub.onevent(event));
      }
    }
  }

  subscribe(
    _relays: string[],
    filter: Filter,
    params: { onevent?: (e: Event) => void; oneose?: () => void; onclose?: (r: string[]) => void }
  ): { close: () => void } {
    const sub: Subscription = {
      filter,
      onevent: params.onevent ?? (() => {}),
      oneose: params.oneose,
      closed: false,
    };
    this.subs.push(sub);
    // Deliver history first (respecting `since`), then EOSE.
    const history = this.events.filter((e) => matchFilter(filter, e));
    setImmediate(() => {
      for (const e of history) {
        if (!sub.closed) {
          sub.onevent(e);
        }
      }
      if (!sub.closed) {
        sub.oneose?.();
      }
    });
    return {
      close: () => {
        sub.closed = true;
      },
    };
  }

  subscribeMany(
    relays: string[],
    filter: Filter,
    params: { onevent?: (e: Event) => void; oneose?: () => void; onclose?: (r: string[]) => void }
  ) {
    return this.subscribe(relays, filter, params);
  }

  async querySync(_relays: string[], filter: Filter): Promise<Event[]> {
    let matches = this.events.filter((e) => matchFilter(filter, e));
    if (filter.limit !== undefined) {
      matches = matches.sort((a, b) => b.created_at - a.created_at).slice(0, filter.limit);
    }
    return matches;
  }

  async get(relays: string[], filter: Filter): Promise<Event | null> {
    return (await this.querySync(relays, { ...filter, limit: 1 }))[0] ?? null;
  }

  close(): void {
    for (const sub of this.subs) {
      sub.closed = true;
    }
  }

  /** Number of subscriptions still open — a leak check. */
  openSubscriptions(): number {
    return this.subs.filter((s) => !s.closed).length;
  }
}

export type WalletBehavior =
  | 'pay'
  | 'decline'
  | 'decline-not-found'
  | 'silent'
  | 'pay-silently'
  | 'bad-preimage';

/**
 * A scriptable NWC wallet service. `pay` answers with a preimage for the
 * invoice's payment hash (tests mint hashes with `makePaymentPair`); `silent`
 * never answers; `pay-silently` records the payment but never answers (the
 * "outcome unknown" case); `decline` answers with a NIP-47 error.
 */
export class FakeWallet {
  readonly secret = generateSecretKey();
  readonly pubkey = getPublicKey(this.secret);
  readonly clientSecretHex = bytesToHex(generateSecretKey());
  behavior: WalletBehavior = 'pay';
  /** paymentHash → preimage for invoices the test knows the preimage of. */
  readonly preimages = new Map<string, string>();
  /** paymentHash → state as lookup_invoice will report it. */
  readonly payments = new Map<string, 'settled' | 'failed' | 'pending'>();
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  private sub: { close: () => void } | undefined;
  /** Resolves invoice → payment hash; tests plug in the bolt11 decoder. */
  hashOf: (bolt11: string) => string = () => '';

  constructor(private readonly pool: MemoryPool, encryption: 'nip44_v2' | 'nip04' = 'nip44_v2') {
    pool.store(
      finalizeEvent(
        {
          kind: NWC_INFO_KIND,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['encryption', encryption]],
          content: 'pay_invoice lookup_invoice get_info',
        },
        this.secret
      )
    );
    this.sub = pool.subscribe([], { kinds: [NWC_REQUEST_KIND], '#p': [this.pubkey] }, {
      onevent: (e) => this.handle(e),
    });
  }

  get uri(): string {
    return `nostr+walletconnect://${this.pubkey}?relay=wss%3A%2F%2Frelay.test&secret=${this.clientSecretHex}&lud16=creator%40wallet.test`;
  }

  private respond(request: Event, body: unknown): void {
    const key = nip44.getConversationKey(this.secret, request.pubkey);
    this.pool.store(
      finalizeEvent(
        {
          kind: NWC_RESPONSE_KIND,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['p', request.pubkey],
            ['e', request.id],
          ],
          content: nip44.encrypt(JSON.stringify(body), key),
        },
        this.secret
      )
    );
  }

  private handle(request: Event): void {
    const key = nip44.getConversationKey(this.secret, request.pubkey);
    const { method, params } = JSON.parse(nip44.decrypt(request.content, key));
    this.requests.push({ method, params });

    if (method === 'lookup_invoice') {
      const hash = (params.payment_hash as string) ?? this.hashOf(params.invoice as string);
      const state = this.payments.get(hash);
      if (!state) {
        this.respond(request, { result_type: method, error: { code: 'NOT_FOUND', message: 'unknown' } });
      } else {
        this.respond(request, {
          result_type: method,
          result: { state, preimage: state === 'settled' ? this.preimages.get(hash) : undefined },
        });
      }
      return;
    }
    if (method !== 'pay_invoice') {
      this.respond(request, { result_type: method, error: { code: 'NOT_IMPLEMENTED', message: '' } });
      return;
    }

    const hash = this.hashOf(params.invoice as string);
    switch (this.behavior) {
      case 'decline':
        this.payments.set(hash, 'failed');
        this.respond(request, { result_type: method, error: { code: 'INSUFFICIENT_BALANCE', message: 'no funds' } });
        return;
      case 'decline-not-found':
        // What a custodial service says when the invoice belongs to one of
        // its own accounts that has no wallet behind it.
        this.respond(request, { result_type: method, error: { code: 'OTHER', message: 'Payment failed: Wallet not found: ' } });
        return;
      case 'silent':
        return;
      case 'pay-silently':
        this.payments.set(hash, 'settled');
        return;
      case 'bad-preimage':
        this.payments.set(hash, 'settled');
        this.respond(request, { result_type: method, result: { preimage: '00'.repeat(32) } });
        return;
      case 'pay':
        if (this.payments.get(hash) === 'settled') {
          // A real node refuses to pay the same hash twice.
          this.respond(request, { result_type: method, error: { code: 'PAYMENT_FAILED', message: 'already paid' } });
          return;
        }
        this.payments.set(hash, 'settled');
        this.respond(request, { result_type: method, result: { preimage: this.preimages.get(hash), fees_paid: 1000 } });
        return;
    }
  }

  stop(): void {
    this.sub?.close();
  }
}

/** A preimage and its payment hash. */
export function makePaymentPair(): { preimage: string; paymentHash: string } {
  const preimage = randomBytes(32).toString('hex');
  const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
  return { preimage, paymentHash };
}
