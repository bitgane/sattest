import * as vscode from 'vscode';

jest.mock('../state', () => ({
  getNostrAuthEvent: jest.fn(),
  initializeSecrets: jest.fn(),
}));

import { getNostrAuthHeaders } from './nostr-auth.js';
import { getNostrAuthEvent } from '../state.js';

describe('getNostrAuthHeaders', () => {
  it('returns Authorization header with base64-encoded event', async () => {
    const mockEvent = JSON.stringify({ kind: 22242, content: 'sattest-auth' });
    (getNostrAuthEvent as jest.Mock).mockResolvedValue(mockEvent);

    const headers = await getNostrAuthHeaders();

    const expectedEncoded = Buffer.from(mockEvent).toString('base64');
    expect(headers).toEqual({
      Authorization: `Nostr ${expectedEncoded}`,
    });
  });

  it('merges extra headers', async () => {
    const mockEvent = JSON.stringify({ kind: 22242 });
    (getNostrAuthEvent as jest.Mock).mockResolvedValue(mockEvent);

    const headers = await getNostrAuthHeaders({ 'Content-Type': 'application/json' });

    const expectedEncoded = Buffer.from(mockEvent).toString('base64');
    expect(headers).toEqual({
      Authorization: `Nostr ${expectedEncoded}`,
      'Content-Type': 'application/json',
    });
  });

  it('throws when no auth event is stored', async () => {
    (getNostrAuthEvent as jest.Mock).mockResolvedValue(undefined);

    await expect(getNostrAuthHeaders()).rejects.toThrow('Nostr authentication required');
  });

  it('throws when auth event is null', async () => {
    (getNostrAuthEvent as jest.Mock).mockResolvedValue(null);

    await expect(getNostrAuthHeaders()).rejects.toThrow('Nostr authentication required');
  });
});
