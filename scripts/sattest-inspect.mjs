#!/usr/bin/env node
// Read-only inspector for Sattest bounties on Nostr relays — the stand-in for
// the old "query the database" steps in docs/PRE_DEPLOY_CHECKLIST.md.
//
// It derives the repository's public id and content key from the root commit
// (the same way src/git/repo-identity.ts does), reads every bounty and claim
// event for that repository from the relays, and prints what each one says,
// using the extension's own validation (out/bounty/bounty-events.js).
//
// It never publishes anything and never needs a private key.
//
// Usage (after `npm run compile`):
//   npm run inspect -- [--repo <path>] [--relays wss://a,wss://b] [--raw] [--json]

import { execFileSync } from 'node:child_process';
import { createHash, hkdfSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
const BOUNTY_KIND = 37400;
const CLAIM_KIND = 37401;

function usage(code = 0) {
  console.log(`Usage: npm run inspect -- [options]

  --repo <path>      git repository to inspect (default: current directory)
  --relays <list>    comma-separated relay URLs (default: ${DEFAULT_RELAYS.join(',')})
  --raw              also print each event's raw tags and (encrypted) content
  --json             print machine-readable JSON instead of text
  --min-pow <n>      minimum claim proof of work to accept (default: 16)
  --help             show this help`);
  process.exit(code);
}

const args = process.argv.slice(2);
const opt = { repo: process.cwd(), relays: DEFAULT_RELAYS, raw: false, json: false, minPow: 16 };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--help' || a === '-h') usage(0);
  else if (a === '--repo') opt.repo = args[++i];
  else if (a === '--relays') opt.relays = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--raw') opt.raw = true;
  else if (a === '--json') opt.json = true;
  else if (a === '--min-pow') opt.minPow = Number(args[++i]);
  else {
    console.error(`Unknown option: ${a}`);
    usage(1);
  }
}

const compiled = fileURLToPath(new URL('../out/bounty/bounty-events.js', import.meta.url));
if (!existsSync(compiled)) {
  console.error('out/ is missing — run `npm run compile` first.');
  process.exit(1);
}
const { assembleBounties } = await import(compiled);
const { SimplePool } = await import('nostr-tools/pool');

function git(argv) {
  return execFileSync('git', argv, { cwd: opt.repo, encoding: 'utf-8' }).trim();
}

let rootSha;
try {
  if (git(['rev-parse', '--is-shallow-repository']) === 'true') {
    console.error('Shallow clone: the root commit is unknown. Run `git fetch --unshallow`.');
    process.exit(1);
  }
  rootSha = git(['rev-list', '--max-parents=0', 'HEAD']).split('\n').map((s) => s.trim().toLowerCase()).sort()[0];
} catch (err) {
  console.error(`Not a git repository with commits: ${opt.repo}`);
  process.exit(1);
}

// Same derivation as src/git/repo-identity.ts.
const derive = (label) => new Uint8Array(hkdfSync('sha256', rootSha, 'sattest:v1', label, 32));
const repoId = Buffer.from(derive('repo-id')).toString('hex');
const repoKey = derive('repo-key');

const pool = new SimplePool();
let events = [];
try {
  events = await pool.querySync(opt.relays, { kinds: [BOUNTY_KIND, CLAIM_KIND], '#r': [repoId] }, { maxWait: 6000 });
} catch (err) {
  console.error(`Relay query failed: ${err?.message ?? err}`);
} finally {
  try {
    pool.close(opt.relays);
  } catch {
    /* ignore */
  }
}

const byId = new Map(events.map((e) => [e.id, e]));
events = [...byId.values()];
const bounties = assembleBounties(events, repoKey, repoId, { minClaimPow: opt.minPow });

const proofOk = (p) =>
  p?.preimage && p?.paymentHash
    ? createHash('sha256').update(Buffer.from(p.preimage, 'hex')).digest('hex') === p.paymentHash
    : undefined;

const report = {
  repo: opt.repo,
  repoId,
  relays: opt.relays,
  eventsFound: events.length,
  bountyEvents: events.filter((e) => e.kind === BOUNTY_KIND).length,
  claimEvents: events.filter((e) => e.kind === CLAIM_KIND).length,
  bounties: bounties.map((b) => ({
    id: b.id,
    creator: b.creatorId,
    status: b.status,
    amountSats: b.amountSats,
    testId: b.testId,
    updatedAt: new Date(b.eventCreatedAt * 1000).toISOString(),
    claims: b.claims.map((c) => ({
      claimant: c.claimantPubkey,
      status: c.status,
      eventId: c.id,
      publicConsent: c.publicConsent,
    })),
    payout: b.payout ? { ...b.payout, proofVerifies: proofOk(b.payout) } : undefined,
  })),
  raw: opt.raw ? events.map(({ id, kind, pubkey, created_at, tags, content }) => ({ id, kind, pubkey, created_at, tags, content })) : undefined,
};

if (opt.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`repo     ${report.repo}`);
  console.log(`repoId   ${repoId}   (the public "r" tag)`);
  console.log(`relays   ${opt.relays.join(', ')}`);
  console.log(`events   ${report.eventsFound} (${report.bountyEvents} bounty, ${report.claimEvents} claim versions)\n`);
  if (report.bounties.length === 0) {
    console.log('No valid bounties for this repository.');
  }
  for (const b of report.bounties) {
    console.log(`bounty ${b.id}  [${b.status}]  ${b.amountSats} sats  ${b.testId}`);
    console.log(`  creator  ${b.creator}   updated ${b.updatedAt}`);
    for (const c of b.claims) {
      console.log(`  claim    ${c.claimant}  ${c.status}${c.publicConsent ? '  (public payout ok)' : ''}`);
    }
    if (b.payout) {
      const p = b.payout;
      console.log(`  payout   hash ${p.paymentHash ?? '-'}`);
      console.log(`           preimage ${p.preimage ?? '-'}  verifies: ${p.proofVerifies ?? 'n/a'}${p.resolution ? `  resolution: ${p.resolution}` : ''}`);
    }
    console.log('');
  }
  if (report.raw) {
    console.log('--- raw events ---');
    for (const e of report.raw) console.log(JSON.stringify(e));
  }
}
process.exit(0);
