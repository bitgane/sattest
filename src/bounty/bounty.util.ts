import * as vscode from 'vscode';
import { toString } from 'qrcode';
import { LNBITS_INVOICE_KEY_KEY, LNBITS_URL_KEY } from './bounty.constants';
import { BountyInfo, ClaimStatus } from './bounty.types';

export const addBountyCommand = (
  bounties: Map<string, BountyInfo>,
  onBountiesChangedEmitter: vscode.EventEmitter<void>,
  context: vscode.ExtensionContext
) =>
  vscode.commands.registerCommand('bountyTestPlugin.addBounty', async (test: vscode.TestItem) => {
    if (!test) {
      vscode.window.showErrorMessage('No test selected');
      return;
    }

    // Check if already has bounty
    if (bounties.has(test.id)) {
      const existing = bounties.get(test.id)!;
      vscode.window.showWarningMessage(
        `Test "${test.label}" already has ${existing.amountSats} sats bounty (created ${existing.createdAt.toLocaleString()})`
      );
      return;
    }

    // Prompt for amount (sats)
    const amountInput = await vscode.window.showInputBox({
      title: `Bounty for "${test.label}"`,
      prompt: 'Enter bounty amount in satoshis (e.g., 10000 for 0.0001 BTC)',
      value: '10000',
      validateInput: (value) => {
        const sats = parseInt(value);
        if (isNaN(sats) || sats < 1 || sats > 50000000) {
          // Max ~.05 BTC
          return 'Enter 1-50M satoshis';
        }
        return null;
      },
    });
    if (!amountInput) {
      return;
    }

    const amountSats = parseInt(amountInput);

    const lnbitsUrlKey = LNBITS_URL_KEY;
    const lnbitsInvoiceKeyConst = LNBITS_INVOICE_KEY_KEY;
    // Get or prompt for LNbits config
    let lnbitsUrl = context.globalState.get<string>(lnbitsUrlKey);
    let lnbitsInvoiceKey = await context.secrets.get(lnbitsInvoiceKeyConst);

    if (!lnbitsUrl || !lnbitsInvoiceKey) {
      const urlInput = await vscode.window.showInputBox({
        prompt: 'Enter your LNbits instance URL (e.g., https://demo.lnbits.com)',
        value: lnbitsUrl || 'https://demo.lnbits.com',
      });
      if (!urlInput) {
        return;
      }

      const keyInput = await vscode.window.showInputBox({
        prompt: 'Enter your LNbits Invoice/Read Key (from API Info)',
        password: true,
      });
      if (!keyInput) {
        return;
      }

      await context.globalState.update(LNBITS_URL_KEY, urlInput);
      await context.secrets.store(LNBITS_INVOICE_KEY_KEY, keyInput);

      lnbitsUrl = urlInput;
      lnbitsInvoiceKey = keyInput;
    }

    // Create real payable invoice via LNbits API
    const response = await fetch(`${lnbitsUrl}/api/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': lnbitsInvoiceKey!,
      },
      body: JSON.stringify({
        out: false, // false = incoming payment (invoice)
        amount: amountSats,
        memo: `Bounty for test "${test.label}" in ${test.uri?.fsPath || 'unknown'}`,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      vscode.window.showErrorMessage(`LNbits error: ${response.status} - ${errorText}`);
      return;
    }

    const data = await response.json();
    const invoice = data.payment_request; // The real payable BOLT11 invoice
    const paymentHash = data.payment_hash; // Save this for later checking if paid

    // Store with payment hash for future payout detection
    const bountyInfo = {
      amountSats,
      invoice,
      paymentHash,
      createdAt: new Date(),
      testId: test.id,
      testItem: test, // test is the TestItem passed to command
      claimStatus: 'none' as ClaimStatus,
      creatorApiKey: lnbitsInvoiceKey, // ← the key that can send payouts
      creatorWalletId: await getWalletId(lnbitsUrl, lnbitsInvoiceKey), // optional
    };
    bounties.set(test.id, bountyInfo);
    onBountiesChangedEmitter.fire();
    await context.globalState.update('bountyTests', Object.fromEntries(bounties));

    vscode.commands.executeCommand('setContext', 'testItemHasBounty', true);

    // Create webview panel to show the invoice
    const panel = vscode.window.createWebviewPanel(
      'bountyInvoice',
      `Bounty: ${test.label} (${amountSats} sats)`,
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

    toString(
      bountyInfo.invoice,
      { type: 'svg', errorCorrectionLevel: 'M' },
      async (err: Error | null | undefined, svg: string) => {
        if (err) {
          panel.webview.html = `<h1>Error generating QR: ${err.message}</h1>`;
          console.error('QR error:', err);
          return;
        }
        panel.webview.html = `
                <!DOCTYPE html>
                <html>
                <body style="font-family:monospace;padding:20px;">
                    <h2>Scan to fund bounty (${amountSats} sats)</h2>
                    <div style="text-align:center;">${svg}</div>
                    <textarea onclick="this.select()" rows="4" cols="80" readonly>${bountyInfo.invoice}</textarea><br>
                    <button onclick="navigator.clipboard.writeText('${bountyInfo.invoice}')">Copy Invoice</button>
                    <p><em>Pay via Lightning wallet. Payout auto-triggers on test pass in CI.</em></p>
                </body>
            </html>`;
      }
    );

    vscode.window
      .showInformationMessage(
        `✅ Bounty created: ${amountSats} sats for "${test.label}". QR panel opened. Fund it!`,
        'View All Bounties'
      )
      .then(async (choice) => {
        if (choice === 'View All Bounties') {
          const activeBounties = Array.from(bounties.values())
            .map((b) => `${b.amountSats} sats: ${b.testId?.slice(0, 8)}...`)
            .join('\n');
          vscode.window.showInformationMessage(`Active Bounties:\n${activeBounties || 'None'}`, {
            modal: true,
          });
        }
      });
  });

export const removeBountyCommand = (
  bounties: Map<string, BountyInfo>,
  onBountiesChangedEmitter: vscode.EventEmitter<void>,
  context: vscode.ExtensionContext
) =>
  vscode.commands.registerCommand(
    'bountyTestPlugin.removeBounty',
    async (test?: vscode.TestItem) => {
      if (!test) {
        vscode.window.showErrorMessage('No test selected');
        return;
      }

      const bounty = bounties.get(test.id);
      if (!bounty) {
        vscode.window.showInformationMessage(`No bounty on test "${test.label}"`);
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Remove ${bounty.amountSats} sats bounty from "${test.label}"?`,
        { modal: true },
        'Yes, Remove'
      );

      if (confirm !== 'Yes, Remove') {
        return;
      }

      // Remove from memory and storage
      bounties.delete(test.id);
      onBountiesChangedEmitter.fire();
      const allBounties = Object.fromEntries(bounties);
      await context.globalState.update('bountyTests', allBounties);

      vscode.commands.executeCommand('setContext', 'testItemHasBounty', false);

      vscode.window.showInformationMessage(
        `Bounty removed from "${test.label}" (${bounty.amountSats} sats)`
      );
    }
  );

export const checkPaidCommand = (
  bounties: Map<string, BountyInfo>,
  onBountiesChangedEmitter: vscode.EventEmitter<void>,
  context: vscode.ExtensionContext
) =>
  vscode.commands.registerCommand('bountyTestPlugin.checkPaid', async (test?: vscode.TestItem) => {
    if (!test || !test.id) {
      vscode.window.showErrorMessage('No test selected');
      return;
    }

    const bounty = bounties.get(test.id);
    if (!bounty || !bounty.paymentHash) {
      vscode.window.showInformationMessage('No bounty or payment hash for this test');
      return;
    }

    // Reload config
    const lnbitsUrl = context.globalState.get<string>(LNBITS_URL_KEY);
    const lnbitsInvoiceKey = await context.secrets.get(LNBITS_INVOICE_KEY_KEY);

    if (!lnbitsUrl || !lnbitsInvoiceKey) {
      vscode.window.showErrorMessage('LNbits config missing – run Add Bounty first');
      return;
    }

    try {
      const response = await fetch(`${lnbitsUrl}/api/v1/payments/${bounty.paymentHash}`, {
        method: 'GET',
        headers: {
          'X-Api-Key': lnbitsInvoiceKey,
        },
      });

      if (!response.ok) {
        vscode.window.showErrorMessage(`LNbits check failed: ${response.status}`);
        return;
      }

      const data = await response.json();
      const isPaid = data.paid || false; // LNbits returns { paid: true/false }

      if (isPaid) {
        vscode.window.showInformationMessage(`Bounty funded! ${bounty.amountSats} sats received.`);
        // Optional: Mark as paid
        bounty.paid = true;
        vscode.commands.executeCommand('editor.action.forceCodeLensRefresh');
        bounties.set(test.id, bounty);
        onBountiesChangedEmitter.fire();
        await context.globalState.update('bountyTests', Object.fromEntries(bounties));
      } else {
        vscode.window.showInformationMessage('Bounty not yet paid.');
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Error checking payment: ${err}`);
    }
  });

export const claimBountyCommand = (
  bounties: Map<string, BountyInfo>,
  onBountiesChangedEmitter: vscode.EventEmitter<void>,
  context: vscode.ExtensionContext
) =>
  vscode.commands.registerCommand(
    'bountyTestPlugin.claimBounty',
    async (test?: vscode.TestItem) => {
      if (!test || !test.id) {
        vscode.window.showErrorMessage('No test selected');
        return;
      }

      const bounty = bounties.get(test.id);
      if (!bounty || !bounty.paid || bounty.claimStatus !== 'none') {
        vscode.window.showErrorMessage('Bounty not funded yet or already claimed');
        return;
      }

      // Prompt for claimer's Lightning invoice
      const claimInvoice = await vscode.window.showInputBox({
        title: `Claim ${bounty.amountSats} sats bounty`,
        prompt: 'Paste your Lightning invoice (bolt11) to receive payout',
        validateInput: (v) =>
          v.startsWith('lnbc') ? null : 'Must be a valid Lightning invoice starting with lnbc',
      });

      if (!claimInvoice) {
        return;
      }

      // Set pending status
      bounty.claimedBy = claimInvoice;
      bounty.claimStatus = 'pending';
      bounties.set(test.id, bounty);

      await context.globalState.update('bountyTests', Object.fromEntries(bounties));

      // Notify claimant
      vscode.window.showInformationMessage(
        `Claim request sent for ${bounty.amountSats} sats. Waiting for creator approval.`,
        'OK'
      );

      // Show approval prompt to creator
      vscode.window
        .showInformationMessage(
          `Someone wants to claim your ${bounty.amountSats} sats bounty on test "${test.label}".`,
          'Approve Payout',
          'Reject'
        )
        .then(async (selection) => {
          if (selection === 'Approve Payout') {
            await executePayout(bounties, bounty, claimInvoice, context, test);
            onBountiesChangedEmitter.fire(); // fire here after successful payout
          } else if (selection === 'Reject') {
            bounty.claimStatus = 'rejected';
            bounties.set(test.id, bounty);
            await context.globalState.update('bountyTests', Object.fromEntries(bounties));
            vscode.window.showInformationMessage('Claim rejected');
            onBountiesChangedEmitter.fire(); // optional: fire on reject too
          }
        });
    }
  );

// Helper to get wallet ID (optional, but nice for debugging)
export async function getWalletId(url: string, key: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${url}/api/v1/wallet`, {
      headers: { 'X-Api-Key': key },
    });
    if (res.ok) {
      const data = await res.json();
      return data.id;
    }
  } catch (e) {
    console.error('Failed to get wallet ID:', e);
  }
  return undefined;
}

// Helper to actually send the payout (used by the approval button)
export async function executePayout(
  bounties: Map<string, BountyInfo>,
  bounty: BountyInfo,
  claimInvoice: string,
  context: vscode.ExtensionContext,
  test: vscode.TestItem
) {
  const lnbitsUrl = context.globalState.get<string>(LNBITS_URL_KEY);
  const apiKey = bounty.creatorApiKey;

  if (!lnbitsUrl || !apiKey) {
    vscode.window.showErrorMessage('LNbits configuration missing for creator');
    return;
  }

  try {
    const res = await fetch(`${lnbitsUrl}/api/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
      },
      body: JSON.stringify({
        out: true,
        bolt11: claimInvoice,
        memo: `Payout for test "${test.label}" bounty`,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      vscode.window.showErrorMessage(`Payout failed: ${err}`);
      return;
    }

    const data = await res.json();
    vscode.window.showInformationMessage(`Payout sent! Check ID: ${data.checking_id}`);

    bounty.paid = true;
    vscode.commands.executeCommand('editor.action.forceCodeLensRefresh');
    bounty.claimStatus = 'approved';
    bounties.set(test.id, bounty);
    await context.globalState.update('bountyTests', Object.fromEntries(bounties));
  } catch (err) {
    vscode.window.showErrorMessage(`Payout error: ${err instanceof Error ? err.message : err}`);
  }
}
