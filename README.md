# Sattest – Lightning Bounties for VS Code Tests

**Sattest** is a VS Code extension that lets you attach real Bitcoin Lightning bounties (via LNbits) to your test cases. Incentivize developers to fix failing tests by offering satoshis — paid out after bounty creator approval.

## Features

- Attach a Lightning bounty (in satoshis) to any test case
- Generate a QR code + BOLT11 invoice via LNbits
- Claim bounties by submitting a Lightning address or LNURL
- Bounty creator approves or rejects payout
- Poll payment status automatically with live webview updates
- Nostr identity integration for bounty creator verification
- CodeLens annotations showing bounty status inline
- Persistent storage using VS Code global state & secrets
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
- Node.js 18+
- A Sattest backend instance (default: `http://localhost:3000`)

## Installation

1. Open VS Code
2. Go to Extensions view (`Ctrl+Shift+X`)
3. Search for **Sattest** (or install from VSIX if sideloading)
4. Install & reload VS Code

## Setup

1. Open Command Palette (`Ctrl+Shift+P`)
2. Run **Bounty: Add Bounty** on a test (or right-click a test → Add Bounty)
3. Enter amount in sats (1–50,000,000)
4. On first use, choose your LNbits setup:
   - **Use default** – uses the built-in LNbits node (easiest)
   - **Use my own LNbits** – provide your own LNbits URL and API key
5. Connect your Nostr identity with `Ctrl+Alt+N` (`Cmd+Alt+N` on Mac) to sign bounties

## Usage

### Add a Bounty

- Right-click a test → **Add Bounty**
- Enter sats amount → QR code + invoice appears in a webview panel
- Fund the invoice via any Lightning wallet
- Payment status is polled automatically every 10 seconds

### Check Payment Status

- Right-click test → **Check Bounty Paid**
- If paid, the bounty is marked as funded
- If not yet funded, QR panel reopens so you can pay

### Claim a Bounty

- Right-click a funded test → **Claim Bounty**
- Paste your LNURL or Lightning address (e.g., `alice@primal.net`)
- Claim request is sent to the bounty creator for approval

### Approve a Claim

- Right-click a test with a pending claim → **Approve Claim**
- Only the bounty creator (verified via Nostr pubkey) can approve
- Approve → sats sent via LNbits payout

### Connect Nostr

- Press `Ctrl+Alt+N` (`Cmd+Alt+N` on Mac) to connect your Nostr identity
- Used for bounty creator verification and claim authorization

## Commands

| Command                | Description                                 |
| ---------------------- | ------------------------------------------- |
| `sattest.addBounty`    | Add bounty to selected test                 |
| `sattest.checkPaid`    | Check if bounty invoice was paid            |
| `sattest.claimBounty`  | Claim bounty with LNURL / Lightning address |
| `sattest.approveClaim` | Approve a pending claim (creator only)      |
| `sattest.removeBounty` | Remove bounty from test (creator only)      |
| `sattest.connectNostr` | Connect your Nostr identity                 |

## Configuration

| Setting              | Default                 | Description                        |
| -------------------- | ----------------------- | ---------------------------------- |
| `sattest.backendUrl` | `http://localhost:3000` | URL of the Sattest backend         |
| `sattest.apiKey`     | (empty)                 | API key for backend authentication |

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
