# Sattest – Lightning Bounties for VS Code Tests

**Sattest** turns your tests into bounties! Attach a Bitcoin bounty to any unit test; when you approve a contributor's claim, sats move **directly from your own Lightning wallet to theirs** over [Nostr Wallet Connect (NIP-47)](https://nips.nostr.com/47).

There is **no Sattest server**. Bounties and claims are signed [Nostr](https://nostr.com) events stored on relays you choose, and payouts run inside your own VS Code. Nobody holds your funds, your wallet connection, or your bounty data.

Do you...
- have tests, but not the time to get them to pass?
- have difficulty getting old tests to pass?
- want to encourage test-driven development (TDD) on your team?
- or just want to add some fun to your test suite?

...**Sattest** lets you do this with nothing but Nostr and Lightning.

## Features

- **No server, no custody.** Bounty state lives in signed Nostr events on independent relays. Sats move wallet-to-wallet when you approve.
- **Your wallet connection stays on your machine.** It's kept in VS Code's secret storage and used only to pay claims you approve.
- **Private by default.** Bounty details are encrypted with a key derived from your repository's first commit, so only people with a copy of the code can read them. Claimants' payout addresses are encrypted so only the bounty creator can read them.
- **Forks see upstream bounties.** Bounties are scoped by the repository's first commit, not by a hosting provider.
- Connect any NWC-capable Lightning wallet once (Alby Hub, Coinos, Phoenix, …) and reuse it for every bounty.
- Attach a Lightning bounty (in satoshis) to any test case, right from the editor.
- Claim bounties with a Lightning address or LNURL.
- Only the bounty creator can approve a payout, because only their wallet can pay it.
- Payouts are safe to retry: an attempt whose outcome is unknown is checked with your wallet, never paid blind.
- Nostr (NIP-46 remote signer) identity for creators and claimants.
- Opt-in public announcements, which tag the Sattest Nostr account so it can share your bounty.
- CodeLens annotations showing bounty status inline.
- **Multi-language test discovery**, not just TypeScript/JavaScript.

## Supported Languages

Sattest discovers tests in all major languages and frameworks:

| Language                    | Frameworks / Conventions                | File Patterns                             |
| --------------------------- | --------------------------------------- | ----------------------------------------- |
| **JavaScript / TypeScript** | Jest, Mocha, Vitest, Jasmine, node:test | `*.test.{ts,js}`, `*.spec.{ts,js}`        |
| **Java**                    | JUnit 4/5, TestNG                       | `*Test.java`, `*Tests.java`, `Test*.java` |
| **Python**                  | pytest, unittest                        | `test_*.py`, `*_test.py`                  |
| **Go**                      | testing                                 | `*_test.go`                               |
| **Rust**                    | `#[test]`, tokio::test                  | `*.rs`                                    |
| **C#**                      | xUnit, NUnit, MSTest                    | `*Test.cs`, `*Tests.cs`                   |
| **Ruby**                    | minitest, RSpec                         | `*_test.rb`, `*_spec.rb`                  |
| **PHP**                     | PHPUnit, Pest                           | `*Test.php`                               |
| **Kotlin**                  | JUnit (incl. backtick names)            | `*Test.kt`                                |
| **Swift**                   | XCTest                                  | `*Tests.swift`                            |
| **Scala**                   | ScalaTest, specs2                       | `*Test.scala`, `*Spec.scala`              |
| **C / C++**                 | Google Test, Catch2                     | `*_test.cpp`, `*_test.c`                  |

## Requirements

- VS Code 1.106+
- A Nostr signer — Primal, Amber, nsec.app, or any NIP-46 remote signer ("bunker")
- An NWC-capable Lightning wallet — Alby Hub, Coinos, Phoenix, etc. Create the connection **with a budget** in your wallet app: that is the real spending limit.
- A git repository with its full history (shallow clones can't identify the repository)

## Installation

1. Open VS Code
2. Go to Extensions view (`Ctrl+Shift+X`)
3. Search for **Sattest** (or install from VSIX if sideloading)
4. Install & reload VS Code

## Setup

1. Open Command Palette (`Ctrl+Shift+P`)
2. Connect your Nostr identity with `Ctrl+Alt+N` (`Cmd+Alt+N` on Mac) to sign bounties
3. Connect a Lightning wallet with **Bounty: Connect Lightning Wallet (NWC)** — paste the
   `nostr+walletconnect://…` connection string from Alby Hub, Coinos, Phoenix, etc.
4. Run **Bounty: Add Bounty** on a test (or right-click a test → Add Bounty) and enter an
   amount in sats (1–50,000)

Nothing is held by anyone: when you approve a claim, the sats move directly from your
connected wallet to the claimant. If you run Add Bounty without a wallet connected, the connect
flow launches automatically.

### Where your data lives

| What | Where | Who can read it |
| --- | --- | --- |
| Bounty (test, amount, repo name) | Nostr relays (`sattest.bountyRelays`) | Anyone with a copy of the repository |
| Bounty status and payout receipt | Nostr relays | Anyone |
| Claim (who claimed) | Nostr relays | Anyone with the repository id |
| Claimant's payout address | Nostr relays, encrypted | Only the bounty creator |
| Your wallet connection (NWC) | VS Code secret storage on your machine | Only you |
| Payout journal (in-flight payouts) | VS Code storage on your machine | Only you |

Relays can drop or withhold events but can't forge them, so use several independent ones.
Sattest re-broadcasts your own events, and retries any it couldn't publish, each time it starts.

## Usage

### Add a Bounty

- Right-click a test → **Add Bounty**
- Enter sats amount, then choose whether to keep it private to the repository (default) or
  announce it publicly on Nostr
- Nothing is paid up front. On approval, the payout moves from your wallet straight to the claimant

### Claim a Bounty

- Right-click a test with a bounty → **Claim Bounty**
- Paste your LNURL or Lightning address (e.g., `alice@primal.net`). It is encrypted so only the bounty creator can read it
- Your claim is signed with your Nostr key and published to the bounty relays for the creator to review
- Choose how the creator will know the work is yours:
  - **Tag my latest commit** (recommended): adds a `Sattest-Claim` line to your latest commit. Use it on public or busy repositories, or whenever others might claim the same bounty, so the creator can match your claim to the code they merge. Push the commit afterwards.
  - **Skip tagging**: fine when the creator already knows you're working on it, such as on a small team. You can still tag later with **Add Claim Trailer to Latest Commit**.

### Approve a Claim

- Right-click a test with a pending claim → **Approve Claim**
- Only the bounty creator can approve, because only their wallet can pay
- Approve → Sattest fetches an invoice from the claimant's address and your wallet pays it over NWC
- If your wallet doesn't confirm in time, the payout is held. Clicking **Payout Processing** asks your wallet what happened before anything is sent again

### Remove a Bounty

- Right-click a test with a bounty → **Remove Bounty**
- Only the bounty creator can remove it
- It is marked cancelled for everyone immediately. There's nothing to refund, since no funds were ever held

### Connect a Lightning Wallet (NWC)

- Run **Bounty: Connect Lightning Wallet (NWC)** and paste your `nostr+walletconnect://…` connection string
- The connection is checked (it must allow `pay_invoice` and `lookup_invoice`) and stored only in VS Code's secret storage
- Optionally note a budget window (display-only — the real limit is enforced by your wallet)
- Run **Bounty: Disconnect Lightning Wallet (NWC)** to forget it, and revoke it in your wallet app

### Connect Nostr

- Press `Ctrl+Alt+N` (`Cmd+Alt+N` on Mac) to connect your Nostr identity
- Your signer signs every bounty and claim event, and decrypts payout addresses sent to you

### Settings

| Setting | Purpose |
| --- | --- |
| `sattest.bountyRelays` | Relays bounties and claims are published to and read from |
| `sattest.nostrRelays` | Relays used to talk to your NIP-46 signer |
| `sattest.trustedCreators` | Creators (hex or `npub`) whose bounties win when a test has several |

All three are machine-scoped, so a repository's `.vscode/settings.json` can't change them.

## Troubleshooting payouts

When a payout fails, Sattest says whether money could have moved. A **"Payout failed: … Nothing was sent"** message means your wallet refused the payment, the claim is still open, and you can approve again once the cause is fixed. The wallet's own words are quoted in the message.

| Your wallet said | What it usually means |
| --- | --- |
| *Wallet not found* / *user not found* | The claimant's Lightning address has no working wallet behind it. This is common when both wallets are on the same service (e.g. an address that came with a Nostr profile but was never activated). Ask the claimant to check that address can receive, or to claim again with another one. |
| `INSUFFICIENT_BALANCE` | Your wallet needs more sats, including room for routing fees. |
| `QUOTA_EXCEEDED` | The payout is over the budget on your wallet connection. Raise it in your wallet app. |
| `RESTRICTED` / `UNAUTHORIZED` | The connection can't pay invoices, or was revoked. Create a new connection and reconnect it. |
| `PAYMENT_FAILED` | Your wallet couldn't find a route to the claimant. Try again later. |

**"Couldn't confirm this payout"** is different: your wallet may already have paid, so the claim is held rather than retried. Click the **Payout Processing** lens to have Sattest ask your wallet what happened.

## Commands

| Command                     | Description                                       |
| --------------------------- | ------------------------------------------------- |
| `sattest.addBounty`         | Add bounty to selected test                       |
| `sattest.claimBounty`       | Claim bounty with LNURL / Lightning address       |
| `sattest.approveClaim`      | Approve a pending claim (creator only)            |
| `sattest.removeBounty`      | Remove bounty from test (creator only)            |
| `sattest.connectWallet`     | Connect a Lightning wallet via NWC                |
| `sattest.disconnectWallet`  | Disconnect your Lightning wallet                  |
| `sattest.connectNostr`      | Connect your Nostr identity                       |
| `sattest.addClaimTrailer`   | Tag your latest commit with your claim            |

## Development

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
git clone https://github.com/bitgane/sattest.git
cd sattest
npm install
```

### Running Tests

```bash
npm test
```

### Building

```bash
npm run compile
```

### Packaging a release

```bash
npx vsce package
```

### Inspecting bounties on relays

`npm run inspect -- --repo <path>` prints the bounties a repository has on the relays, decrypted with that repository's key. It is read-only.

### Protocol

The event formats, encryption and validation rules every client follows are documented in
[`docs/nostr-protocol.md`](docs/nostr-protocol.md).

## License

[MIT](LICENSE.md)
