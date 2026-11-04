import type { Event } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import { SimplePool } from 'nostr-tools/pool';
import type { KeyValueStore } from '../lightning/payout.js';

/**
 * Talks to the bounty relays. Bounty state lives in signed events spread over
 * several independent relays, so this layer's job is to treat them as one
 * unreliable, eventually-consistent store:
 *
 *  - publish to every relay and report which accepted (callers that move money
 *    require at least one acceptance),
 *  - read from every relay and merge (de-duplicated by event id; picking the
 *    newest version of an addressable event is `bounty-events.ts`'s job),
 *  - keep signed events that couldn't be published in a persisted outbox and
 *    retry them later — a signed event can be re-sent any number of times,
 *  - re-broadcast the user's own events so a relay that dropped them (or never
 *    saw them) gets them back.
 */

const PUBLISH_TIMEOUT_MS = 8_000;
const QUERY_MAX_WAIT_MS = 4_000;
const OUTBOX_KEY = 'sattest.relayOutbox';
const OUTBOX_LIMIT = 200;

/** The SimplePool operations used here (a fake implements them in tests). */
export interface RelayPool {
  publish(relays: string[], event: Event): Promise<string>[];
  querySync(relays: string[], filter: Filter, params?: { maxWait?: number }): Promise<Event[]>;
  subscribeMany(
    relays: string[],
    filter: Filter,
    params: { onevent?: (event: Event) => void; oneose?: () => void }
  ): { close: () => void };
  close(relays: string[]): void;
}

export interface PublishResult {
  accepted: string[];
  failed: string[];
}

export class PublishError extends Error {
  constructor(public readonly result: PublishResult) {
    super(
      `No relay accepted the event (tried ${result.failed.length}: ${result.failed.join(', ') || 'none'})`
    );
    this.name = 'PublishError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export class RelayClient {
  private readonly pool: RelayPool;
  private readonly ownsPool: boolean;
  private readonly usedRelays = new Set<string>();

  constructor(
    private readonly relays: () => string[],
    opts: { pool?: RelayPool; store?: KeyValueStore } = {}
  ) {
    this.ownsPool = !opts.pool;
    this.pool = opts.pool ?? (new SimplePool() as unknown as RelayPool);
    this.store = opts.store;
  }

  private readonly store: KeyValueStore | undefined;

  private targets(extra: string[] = []): string[] {
    const list = Array.from(new Set([...this.relays(), ...extra]));
    list.forEach((r) => this.usedRelays.add(r));
    return list;
  }

  /** Publish to every relay. Rejects with PublishError when none accepted. */
  async publish(event: Event, extraRelays: string[] = []): Promise<PublishResult> {
    const relays = this.targets(extraRelays);
    let attempts: Promise<string>[];
    try {
      attempts = this.pool.publish(relays, event);
    } catch {
      attempts = relays.map(() => Promise.reject(new Error('publish failed')));
    }
    const settled = await Promise.allSettled(
      attempts.map((p) => withTimeout(p, PUBLISH_TIMEOUT_MS))
    );
    const result: PublishResult = { accepted: [], failed: [] };
    settled.forEach((s, i) =>
      (s.status === 'fulfilled' ? result.accepted : result.failed).push(relays[i] ?? `relay ${i}`)
    );
    if (result.accepted.length === 0) {
      throw new PublishError(result);
    }
    return result;
  }

  /**
   * Publish, or — if no relay accepts — queue for a later retry. Use for
   * events whose consequences already happened (a payout receipt) and must
   * eventually reach the network. Returns whether it went out now.
   */
  async publishEventually(event: Event, extraRelays: string[] = []): Promise<boolean> {
    try {
      await this.publish(event, extraRelays);
      return true;
    } catch {
      await this.enqueue(event);
      return false;
    }
  }

  /** Query every relay and merge, de-duplicated by event id. */
  async query(filter: Filter, maxWait = QUERY_MAX_WAIT_MS): Promise<Event[]> {
    const events = await this.pool.querySync(this.targets(), filter, { maxWait });
    const byId = new Map<string, Event>();
    for (const e of events) {
      byId.set(e.id, e);
    }
    return [...byId.values()];
  }

  /** Live subscription across every relay. */
  subscribe(filter: Filter, onevent: (event: Event) => void): { close: () => void } {
    return this.pool.subscribeMany(this.targets(), filter, { onevent });
  }

  /**
   * NIP-65 read ("inbox") relays a user asked to be reached on, so a claim
   * lands where the bounty creator actually listens. Best effort.
   */
  async inboxRelaysOf(pubkey: string): Promise<string[]> {
    try {
      const lists = await this.query({ kinds: [10002], authors: [pubkey], limit: 1 }, 2_500);
      const latest = lists.sort((a, b) => b.created_at - a.created_at)[0];
      if (!latest) {
        return [];
      }
      return latest.tags
        .filter((t) => t[0] === 'r' && (t[2] === undefined || t[2] === 'read'))
        .map((t) => t[1])
        .filter((u) => typeof u === 'string' && /^wss:\/\//i.test(u))
        .slice(0, 4);
    } catch {
      return [];
    }
  }

  private outbox(): Event[] {
    return this.store?.get<Event[]>(OUTBOX_KEY) ?? [];
  }

  private async enqueue(event: Event): Promise<void> {
    if (!this.store) {
      return;
    }
    const queue = this.outbox().filter((e) => e.id !== event.id);
    queue.push(event);
    await this.store.update(OUTBOX_KEY, queue.slice(-OUTBOX_LIMIT));
  }

  /** Retry queued events. Returns how many are still queued. */
  async flushOutbox(): Promise<number> {
    if (!this.store) {
      return 0;
    }
    const remaining: Event[] = [];
    for (const event of this.outbox()) {
      try {
        await this.publish(event);
      } catch {
        remaining.push(event);
      }
    }
    await this.store.update(OUTBOX_KEY, remaining);
    return remaining.length;
  }

  /** Re-send already-signed events (no signer needed). Best effort, never throws. */
  async rebroadcast(events: Event[]): Promise<void> {
    await Promise.allSettled(events.map((e) => this.publish(e)));
  }

  close(): void {
    if (this.ownsPool) {
      try {
        this.pool.close([...this.usedRelays]);
      } catch {
        /* best effort */
      }
    }
  }
}
