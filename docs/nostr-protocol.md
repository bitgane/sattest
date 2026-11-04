# Sattest Nostr protocol (v1)

Sattest has no server. Bounties and claims are signed Nostr events stored on ordinary relays, and every client validates them itself. This document is the shared schema. The constants live in [`src/api/nostr-protocol.ts`](../src/api/nostr-protocol.ts) and are pinned by `nostr-protocol.contract.test.ts`.

The event kinds are provisional and not yet registered in the NIPs repository.

## Repository identity

Bounties are scoped to a repository by its **root commit**: the lexicographically smallest commit from `git rev-list --max-parents=0 HEAD`. Every clone and fork shares it, and it doesn't depend on any hosting provider. Shallow clones are refused, because they report the wrong root.

Two values are derived from the root commit with HKDF-SHA256, using salt `sattest:v1` and the lowercase hex root commit as input key material:

| Value | `info` | Use |
|---|---|---|
| `repoId` | `repo-id` | Public scope. It is the relay-indexed `r` tag on every event. |
| `repoKey` | `repo-key` | 32 bytes, used directly as a NIP-44 v2 conversation key for bounty content. |

Anyone who has ever had a copy of the repository can derive `repoKey`. For a public repository that is everyone. The key hides bounty details from relay readers who don't have the code. It is not access control.

## Bounty: kind 37400 (addressable, authored by the creator)

| Tag | Value |
|---|---|
| `d` | Random UUID, the bounty id. It also salts the `Sattest-Claim` git trailer token. |
| `r` | `repoId` |
| `status` | `open`, `approving`, `paid` or `cancelled` |
| `alt` | Human-readable fallback (NIP-31) |
| `e` | Claim event id being paid (`approving` / `paid`) |
| `p` | Claimant pubkey (`approving` / `paid`) |
| `payment_hash` | Hex payment hash of the payout invoice (`approving` / `paid`) |
| `preimage` | Hex preimage; `sha256(preimage) == payment_hash` (`paid`) |
| `paid_at` | Unix seconds (`paid`) |
| `resolution` | `creator-confirmed` when the creator asserted an outcome no wallet could report |

`content` is `nip44_encrypt(repoKey, JSON)` with the fields `{ v: 1, testId, testLabel?, amountSats, repoSlug?, memo? }`. `testId` is repository-relative, for example `/src/math.test.ts#adds`. `amountSats` is an integer from 1 to 50,000.

A status change publishes a new version of the same coordinate. It copies the payout tags forward and uses `created_at = max(now, previous + 1)`.

## Claim: kind 37401 (addressable, authored by the claimant)

| Tag | Value |
|---|---|
| `d` | `37400:<creator>:<bounty id>`. One claim per claimant per bounty. |
| `a` | Same as `d` |
| `p` | Bounty creator |
| `r` | `repoId` |
| `status` | `pending` or `withdrawn` |
| `epk` | Ephemeral sender public key used to encrypt `content` |
| `nonce` | NIP-13 proof of work, at least 16 bits |
| `public` | Present (`payout`) only if the claimant agreed to a public payout announcement |
| `alt` | Human-readable fallback |

`content` is `nip44_encrypt(conversationKey(ephemeralSecret, creatorPubkey), JSON)` with the fields `{ v: 1, lnurl }`. Only the bounty creator can read the payout address.

## Validation rules (every client)

1. Verify each event's id and signature from its fields. Don't trust cached verification markers.
2. For each coordinate (`kind:pubkey:d`), keep the newest version by `created_at`, breaking ties by lowest event id.
3. A bounty's state comes only from events signed by its creator. Because the author is part of the coordinate, no other key can publish a version of someone else's bounty. That includes the Sattest project account.
4. Ignore bounties that don't decrypt with the repository key or whose content is out of range.
5. Ignore claims below the proof-of-work minimum, `withdrawn` claims, and claims filed after a bounty closed (except the one it was paid to).
6. When a test has several bounties, prefer the user's own, then the user's trusted creators, then the newest.

## Payout (creator's client)

1. Re-read the bounty and the chosen claim. The claim must be the exact event the creator reviewed.
2. If a payout is held (`approving`), ask the same wallet (`lookup_invoice` on `payment_hash`) before doing anything new. If the wallet is different, or the attempt was made from another device, ask the creator instead.
3. Decrypt the LNURL. Fetch a bolt11 invoice for exactly the bounty amount, over HTTPS only and refusing private addresses.
4. Write a local journal entry, then publish `status=approving`. If no relay accepts it, don't pay.
5. Pay over NIP-47 and verify `sha256(preimage) == payment_hash`.
6. Publish `status=paid` with the receipt, retrying from a local outbox if needed.

## Public announcements (opt-in)

A kind-1 note tagged `["t","sattest"]`, `["a",<bounty coordinate>]`, `["sattest-announce","bounty"|"payout"]` and `["p",<Sattest account pubkey>]`. It is only published after the creator agrees. A payout announcement also requires the claimant's `public` tag. A separate announcer service, which holds the Sattest account key, may repost these. The extension never holds that key, and clients never treat the Sattest account as an authority on bounty state.
