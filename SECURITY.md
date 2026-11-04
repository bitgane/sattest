# Security Policy

The Sattest extension holds your Nostr signer session and your Lightning wallet's spending permission (an NWC connection), and it pays approved claims from your wallet. There is no Sattest server: bounty data lives in signed events on Nostr relays. Please report security problems privately so they can be fixed before anyone can use them against users.

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

## Supported versions

Only the latest Marketplace release is supported.

## In scope

Especially:

- **Malicious repositories or workspaces:** a repo you open that can redirect your relay settings, trigger a payout, or grab your Nostr session or NWC connection string. The relay and trusted-creator settings are machine-scoped on purpose, so a workspace can't change them.
- **Malicious events on relays:** a forged or crafted bounty, claim or status that the extension accepts, that changes a bounty it shouldn't, or that leads to a payout. Only the bounty creator's signature may change a bounty, and no other key (including the Sattest project account) is trusted for bounty state.
- **Malicious Lightning addresses:** an LNURL server that gets the extension to pay more than the bounty, fetch a private-network URL, or exhaust memory.
- **Double payment:** any way to make one approved claim pay twice, across retries, reloads or devices.
- **Webviews:** script injection or Content Security Policy bypasses in the Connect to Nostr panel.
- **Tricking you into approving the wrong payout:** misleading bounty, claim, or CodeLens information that could lead you to pay the wrong claim or the wrong amount.
- **Credential handling:** your Nostr session or NWC connection being written to logs, settings files, relays, or anywhere other than VS Code's secret storage.
- **Privacy:** bounty details or payout addresses readable by someone who shouldn't be able to read them (see the table in the README).

## Out of scope

- Vulnerabilities in VS Code itself, your Nostr signer app, your Lightning wallet, or a relay.
- A relay withholding or dropping events (availability, not integrity — use several relays).
- Attacks that require an attacker to already control your machine or your VS Code user settings.
- Findings from automated scanners that come without a working exploit.
