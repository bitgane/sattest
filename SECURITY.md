# Security Policy

The Sattest extension holds your Nostr sign-in session and sends your Lightning wallet's spending permission (an NWC connection) to the backend. Please report security problems privately so they can be fixed before anyone can use them against users.

## Reporting a vulnerability

**Do not open a public issue, pull request, or discussion.**

Report privately, using either of these:

- **GitHub private vulnerability reporting** (preferred): go to this repo's **Security** tab and choose **Report a vulnerability**.
- **Email:** bitgane@proton.me

Include:

- the extension version and your VS Code version
- steps to reproduce, or a proof of concept (a malicious repo or workspace that triggers the issue is ideal)
- what an attacker could achieve

Sattest is maintained by one person. You can expect an acknowledgement within 7 days, and updates as the fix progresses. Once a fixed version is released, the issue will be disclosed publicly and you will be credited, unless you ask not to be.

There is no paid bug bounty program.

If the problem is on the server side (authentication, payouts, stored wallet connections), report it to [sattest-backend](https://github.com/bitgane/sattest-backend/security) instead. If you're not sure which one it belongs to, either is fine.

## Supported versions

Only the latest Marketplace release is supported.

## In scope

Especially:

- **Malicious repositories or workspaces:** a repo you open that can redirect `sattest.backendUrl`, trigger a payout, or grab your Nostr session or NWC connection string. The backend URL setting is machine-scoped on purpose, so a workspace can't change it.
- **Webviews:** script injection or Content Security Policy bypasses in the Connect to Nostr panel or the invoice panel.
- **Tricking you into approving the wrong payout:** misleading bounty, claim, or CodeLens information that could lead you to pay the wrong claim or the wrong amount.
- **Credential handling:** your Nostr session or NWC connection being written to logs, settings files, or anywhere other than VS Code's secret storage.

## Out of scope

- Vulnerabilities in VS Code itself, your Nostr signer app, or your Lightning wallet.
- Attacks that require an attacker to already control your machine or your VS Code user settings.
- Findings from automated scanners that come without a working exploit.
