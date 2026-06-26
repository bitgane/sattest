# Sattest – Lightning Bounties for VS Code Tests

**Sattest** turns your test suite into a bounty board. Attach a Bitcoin Lightning bounty to any failing test; when you approve a contributor's claim, the satoshis move **directly from your own Lightning wallet to theirs** — non-custodially, over [Nostr Wallet Connect (NIP-47)](https://nips.nostr.com/47). Sattest never holds your funds.

## Features

- **Non-custodial by default** — sats move wallet-to-wallet on approval via Nostr Wallet Connect (NWC); the backend never custodies funds, mints invoices, or touches your balance
- Connect any NWC-capable Lightning wallet once (Alby Hub, Coinos, Phoenix, Mutiny, …) and reuse it for every bounty
- Attach a Lightning bounty (in satoshis) to any test case, right from the editor
- Claim bounties by submitting a Lightning address or LNURL
- Bounty creator approves each payout — verified via Nostr identity, so only the owner can release funds
- Nostr (NIP-46 remote signer) sign-in for creator verification and claim authorization
- CodeLens annotations showing bounty status inline, with a **"Non-custodial"** badge
- **Multi-language test discovery** — not just TypeScript/JavaScript

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
- An NWC-capable Lightning wallet — Alby Hub, Coinos, Phoenix, Mutiny, etc.
- A Sattest backend instance (defaults to the hosted instance; configurable via `sattest.backendUrl`)

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

Bounties are **non-custodial**: nothing is held by Sattest. When you approve a claim, the sats
move directly from your connected wallet to the claimant. If you run Add Bounty without a wallet
connected, the connect flow launches automatically.

> The custodial flow (LNbits invoice/QR, funds held server-side) is disabled by default. It's an
> operator-gated option — see `ALLOW_CUSTODIAL_BOUNTIES` in the backend `.env.example`.

## Usage

### Add a Bounty

- Right-click a test → **Add Bounty**
- Enter sats amount → the bounty is created against your connected Lightning wallet (no invoice
  to pay up front)
- On approval, the payout moves from your wallet straight to the claimant

### Claim a Bounty

- Right-click a test with a bounty → **Claim Bounty**
- Paste your LNURL or Lightning address (e.g., `alice@primal.net`)
- Claim request is sent to the bounty creator for approval

### Approve a Claim

- Right-click a test with a pending claim → **Approve Claim**
- Only the bounty creator (verified via Nostr pubkey) can approve
- Approve → the payout fires **from your connected wallet straight to the claimant** over NWC. Nothing was held in escrow

### Remove a Bounty

- Right-click a test with a bounty → **Remove Bounty**
- Only the bounty creator (verified via Nostr pubkey) can remove it
- Non-custodial bounties are deactivated immediately — there's nothing to refund, since no funds were ever held

### Connect a Lightning Wallet (NWC)

- Run **Bounty: Connect Lightning Wallet (NWC)** and paste your `nostr+walletconnect://…` connection string
- Optionally set a budget window (display-only — the real limit is enforced by your wallet)
- Run **Bounty: Disconnect Lightning Wallet (NWC)** to revoke it

### Connect Nostr

- Press `Ctrl+Alt+N` (`Cmd+Alt+N` on Mac) to connect your Nostr identity
- Used for bounty creator verification and claim authorization

### Custodial mode (operator-gated, off by default)

The original custodial flow — pay a BOLT11 invoice / QR up front, funds held server-side via LNbits, then **Check Bounty Paid** and refund-on-remove — is disabled by default. Operators can re-enable it with `ALLOW_CUSTODIAL_BOUNTIES=true` on the backend; see the backend `.env.example`.

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
| `sattest.checkPaid`         | Check if a bounty invoice was paid (custodial)    |

## Configuration

| Setting               | Default                                            | Description                          |
| --------------------- | -------------------------------------------------- | ------------------------------------ |
| `sattest.nostrRelays` | `relay.damus.io`, `relay.primal.net`, `nos.lol`, `relay.nsec.app` | Nostr relay WebSocket URLs |
| `sattest.apiKey`      | (empty)                                            | API key for backend authentication   |

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
