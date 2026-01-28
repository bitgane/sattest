# Sattest – Lightning Bounties for VS Code Tests

**Sattest** is a VS Code extension that lets you attach real Bitcoin Lightning bounties (via LNbits) to your test cases. Incentivize developers to fix failing tests by offering satoshis — paid out automatically or manually after passing.

## Features

- Add a Lightning bounty (in satoshis) to any test case
- Generate QR code + BOLT11 invoice via your LNbits instance
- Claim bounty by submitting a Lightning invoice (BOLT11)
- Creator approves/rejects payout
- Check payment status via LNbits API
- Automatic payout on approval (or manual trigger)
- Persistent storage using VS Code global state & secrets
- Visual feedback via CodeLens and webview panels

## Requirements

- VS Code 1.85+
- A running LNbits instance (self-hosted or demo.lnbits.com)
- LNbits Invoice/Read API key with payout permissions

## Installation

1. Open VS Code
2. Go to Extensions view (`Ctrl+Shift+X`)
3. Search for **Sattest** (or install from VSIX if sideloading)
4. Install & reload VS Code

(When published: Marketplace link will go here)

## Setup

1. Open Command Palette (`Ctrl+Shift+P`)
2. Run **Sattest: Add Bounty** on a failing test (or right-click → Add Bounty)
3. Enter amount in sats (1–50,000,000)
4. If first time: provide your LNbits URL and Invoice API key
   - Stored securely in VS Code secrets/global state

## Usage

### Add a Bounty

- Right-click a test → **Add Bounty**
- Or run command: **Sattest: Add Bounty**
- Enter sats amount → QR + invoice appears in webview
- Fund the invoice via any Lightning wallet

### Check Payment Status

- Right-click test → **Check Bounty Paid**
- Extension queries LNbits → marks test as funded if paid

### Claim & Payout

- Passer submits Lightning invoice (claim)
- Creator gets approval prompt
- Approve → sats sent via LNbits payout
- Reject → claim cancelled

## Commands

| Command                          | Description                           |
|----------------------------------|---------------------------------------|
| `bountyTestPlugin.addBounty`     | Add bounty to selected test           |
| `bountyTestPlugin.checkPaid`     | Check if bounty was paid              |
| `bountyTestPlugin.claimBounty`   | Claim bounty by submitting invoice    |
| `bountyTestPlugin.removeBounty`  | Remove bounty from test               |

## Development / Contributing

### Prerequisites

- Node.js 18+
- npm / yarn

### Setup

```bash
git clone https://github.com/bitgane/sattest.git
cd sattest
npm install