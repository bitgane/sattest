import * as vscode from 'vscode';

export interface BountyInfo {
  amountSats: number;
  invoice: string;
  paymentHash?: string; // From LNbits response
  createdAt: Date;
  testItem?: vscode.TestItem;
  testId: string;
  paid?: boolean; // Track if paid out
  claimedBy?: string; // Optional: claimer's invoice or address
  claimStatus: ClaimStatus;
  creatorApiKey?: string; // the invoice/read+send key used by creator
  creatorWalletId?: string; // optional LNbits wallet ID
}

export type ClaimStatus = 'none' | 'pending' | 'approved' | 'rejected';
