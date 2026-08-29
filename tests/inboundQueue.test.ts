/**
 * Durable inbound intake — crash-safe guest messages. Proves the primitives the webhook handlers
 * and the boot sweep rely on: dedup (Meta retry / replay), one-shot claim, at-most-once reply gate,
 * and recovery of rows a crash left mid-flight.
 */
import { describe, it, expect } from 'vitest';
import { Store } from '../src/store';

describe('inbound_queue', () => {
  it('enqueue dedups by idem_key (Meta retry / replay is a no-op)', () => {
    const s = new Store(':memory:');
    const id1 = s.enqueueInbound({ idemKey: 'whatsapp:wamid1', channel: 'whatsapp', senderId: 'a', payload: { x: 1 } });
    const id2 = s.enqueueInbound({ idemKey: 'whatsapp:wamid1', channel: 'whatsapp', senderId: 'a', payload: { x: 1 } });
    expect(id1).not.toBeNull();
    expect(id2).toBeNull();
  });

  it('claim and markReplying are one-shot (at-most-once)', () => {
    const s = new Store(':memory:');
    const id = s.enqueueInbound({ idemKey: 'k', channel: 'whatsapp', senderId: 'a', payload: {} })!;
    expect(s.claimInbound(id)).toBe(true);
    expect(s.claimInbound(id)).toBe(false); // already processing
    expect(s.markReplying(id)).toBe(true);
    expect(s.markReplying(id)).toBe(false); // reply already sent → replay must not re-send
  });

  it('reclaimStaleInbound returns unfinished rows oldest-first with payload; done rows excluded', () => {
    const s = new Store(':memory:');
    const a = s.enqueueInbound({ idemKey: 'a', channel: 'whatsapp', senderId: 'x', payload: { inbound: { text: 'hi' } } })!;
    const b = s.enqueueInbound({ idemKey: 'b', channel: 'instagram', senderId: 'y', payload: { inbound: { text: 'yo' } } })!;
    s.markInboundDone(a);
    const stale = s.reclaimStaleInbound(-5000); // cutoff in the future → all unfinished rows
    expect(stale.map((r) => r.id)).toEqual([b]); // a is done → excluded
    expect(stale[0].channel).toBe('instagram');
    expect((stale[0].payload as { inbound: { text: string } }).inbound.text).toBe('yo');
    expect(stale[0].repliedAt).toBeNull();
  });

  it('a replied-then-crashed row is recoverable and carries repliedAt (sweep will close, not re-send)', () => {
    const s = new Store(':memory:');
    const id = s.enqueueInbound({ idemKey: 'c', channel: 'whatsapp', senderId: 'z', payload: {} })!;
    s.claimInbound(id);
    s.markReplying(id); // reply sent, then "crash" before markInboundDone
    const stale = s.reclaimStaleInbound(-5000);
    expect(stale.find((r) => r.id === id)?.repliedAt).not.toBeNull();
  });

  it('markInboundDead removes a poison row from the recoverable set', () => {
    const s = new Store(':memory:');
    const id = s.enqueueInbound({ idemKey: 'd', channel: 'whatsapp', senderId: 'z', payload: {} })!;
    s.markInboundDead(id);
    expect(s.reclaimStaleInbound(-5000).find((r) => r.id === id)).toBeUndefined();
  });
});

describe('assertTenant — one-DB-per-tenant guard', () => {
  it('binds the DB to the first tenant, then refuses a different one', () => {
    const s = new Store(':memory:');
    s.assertTenant('kazzhol'); // first boot binds
    s.assertTenant('kazzhol'); // same tenant → fine
    expect(() => s.assertTenant('demostay')).toThrow(/belongs to tenant "kazzhol"/);
  });
});
