/**
 * Task 4: broadcast store — create, queue recipients, resumable send with honest per-status counts.
 */
import { describe, it, expect } from 'vitest';
import { Store } from '../src/store';

describe('broadcasts store', () => {
  it('creates a broadcast, queues recipients, and tracks counts through send', () => {
    const s = new Store(':memory:');
    const id = s.createBroadcast({ property: 'almaty', createdBy: 'admin', body: 'Акция', audience: 'safe' });
    expect(id).toBeGreaterThan(0);

    s.addBroadcastRecipients(id, [
      { conversationId: 'telegram:1', channel: 'telegram', status: 'pending' },
      { conversationId: 'whatsapp:2', channel: 'whatsapp', status: 'pending' },
      { conversationId: 'instagram:3', channel: 'instagram', status: 'skipped', reason: 'outside_24h_window' },
    ]);
    let counts = s.broadcastCounts(id);
    expect(counts.pending).toBe(2);
    expect(counts.skipped).toBe(1);

    const batch = s.nextPendingRecipients(id, 10);
    expect(batch).toHaveLength(2);
    s.markRecipient(batch[0].id, 'sent');
    s.markRecipient(batch[1].id, 'failed', 'HTTP 500');

    counts = s.broadcastCounts(id);
    expect(counts.sent).toBe(1);
    expect(counts.failed).toBe(1);
    expect(counts.pending ?? 0).toBe(0);
    // Drained → no more pending to resume.
    expect(s.nextPendingRecipients(id, 10)).toHaveLength(0);

    s.setBroadcastStatus(id, 'done');
    expect(s.getBroadcast(id)?.status).toBe('done');
    expect(s.getBroadcast(id)?.body).toBe('Акция');
    expect(s.listBroadcasts('almaty')[0].id).toBe(id);
  });
});
