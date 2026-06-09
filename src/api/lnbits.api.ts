import * as vscode from 'vscode';
import {
  getLnbitsApiKey,
  getLnbitsUrl,
  setIsDefaultLnbits,
  setLnbitsApiKey,
  setLnbitsUrl,
} from '../state.js';

interface CreateInvoiceResponse {
  payment_request: string;
  payment_hash: string;
}

export async function getLnbitsConfig() {
  const url = await getLnbitsUrl();
  const apiKey = await getLnbitsApiKey();

  if (url && apiKey) {
    return { url, apiKey };
  }
  return null;
}

export async function configureLnbits() {
  const url = await vscode.window.showInputBox({
    title: 'Your LNbits instance URL',
    prompt: 'Example: https://umbrel.local:3007',
    placeHolder: 'https://',
    validateInput: (v) => (v.startsWith('http') ? null : 'Must start with http(s)://'),
  });

  if (!url) {
    return;
  }

  const apiKey = await vscode.window.showInputBox({
    title: 'LNbits API Key',
    prompt: 'Admin or invoice key with payout permissions',
    password: true,
    validateInput: (v) => (v.length > 10 ? null : 'Key looks too short'),
  });

  if (!apiKey) {
    return;
  }

  await setLnbitsUrl(url);
  await setLnbitsApiKey(apiKey);

  vscode.window.showInformationMessage('LNbits configuration saved – using your instance now');
}

export async function createLnbitsInvoice(
  lnbitsUrl: string,
  apiKey: string,
  amountSats: number,
  memo: string
): Promise<CreateInvoiceResponse> {
  const response = await fetch(`${lnbitsUrl}/api/v1/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify({
      out: false,
      amount: amountSats,
      memo,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LNbits error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();

  return {
    payment_request: (data as CreateInvoiceResponse).payment_request,
    payment_hash: (data as CreateInvoiceResponse).payment_hash,
  };
}
