/**
 * Barrel for the bounty command factories.
 *
 * Each `sattest.*` command lives in its own module under `./commands/` — this
 * file re-exports them under their original names so `extension.ts` (and the
 * tests) keep a single, stable import path. The webview and evidence helpers the
 * commands rely on live in `./claim-evidence.ts`.
 */
export { addBountyCommand } from './commands/add-bounty.js';
export { removeBountyCommand } from './commands/remove-bounty.js';
export { claimBountyCommand } from './commands/claim-bounty.js';
export { approveClaimCommand } from './commands/approve-claim.js';
export { addClaimTrailerCommand } from './commands/add-claim-trailer.js';
export { tagLatestCommitForClaim } from './commands/claim-trailer-prompt.js';
