/**
 * Keeps the pages hotels link in the admin panel readable by the bot.
 *
 * The promise made to the owner is simple: paste a link, the bot uses what is on it. That
 * promise is kept on a schedule rather than per guest message — a page fetched mid-reply
 * would add seconds to every answer and take the bot down with the site whenever the site
 * is down. Instead the text is read periodically and stored next to the other knowledge.
 */

import type { KbEntry } from '../types';
import { fetchSource } from './sourceFetch';

export interface SourceSyncStore {
  listKbEntries(property?: string, kind?: string, includeArchived?: boolean): KbEntry[];
  updateKbEntry(
    id: number,
    patch: Partial<Pick<KbEntry, 'title' | 'body' | 'url' | 'active' | 'property'>>,
  ): void;
  markKbFetched(id: number, at: string | null, error: string | null): void;
}

/** Read a source no more often than this unless someone asks for it by hand. */
export const SOURCE_TTL_MS = 6 * 60 * 60 * 1000;

export interface SyncResult {
  checked: number;
  updated: number;
  failed: number;
}

export class SourceSync {
  constructor(
    private readonly store: SourceSyncStore,
    private readonly deps: { fetchImpl?: typeof fetch; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** One source, on demand — used by the panel's «Обновить сейчас». */
  async refreshOne(entry: KbEntry): Promise<{ ok: boolean; error?: string }> {
    if (!entry.url) {
      this.store.markKbFetched(entry.id, null, 'У записи нет ссылки');
      return { ok: false, error: 'У записи нет ссылки' };
    }
    const res = await fetchSource(entry.url, { fetchImpl: this.deps.fetchImpl });
    const stamp = new Date(this.now()).toISOString();
    if (!res.ok || !res.text) {
      // The previously read text is deliberately kept: yesterday's menu still beats
      // nothing, and the panel shows the staff why the last read failed.
      this.store.markKbFetched(entry.id, entry.fetchedAt ?? null, res.error ?? 'Не удалось прочитать');
      return { ok: false, error: res.error };
    }
    this.store.updateKbEntry(entry.id, {
      body: `Со страницы ${entry.url} (прочитано ботом):\n${res.text}`,
    });
    this.store.markKbFetched(entry.id, stamp, null);
    return { ok: true };
  }

  /** Every active source whose text is older than the TTL. */
  async refreshDue(force = false): Promise<SyncResult> {
    const sources = this.store
      .listKbEntries(undefined, 'source')
      .filter((e) => Boolean(e.active) && Boolean(e.url));
    const due = force
      ? sources
      : sources.filter((e) => {
          if (!e.fetchedAt) return true;
          const age = this.now() - Date.parse(e.fetchedAt);
          return Number.isNaN(age) || age >= SOURCE_TTL_MS;
        });

    let updated = 0;
    let failed = 0;
    // Sequential on purpose: a handful of pages per hotel, and hammering a small
    // hotel site with parallel requests is a good way to get this server blocked.
    for (const entry of due) {
      const res = await this.refreshOne(entry);
      if (res.ok) updated += 1;
      else failed += 1;
    }
    return { checked: due.length, updated, failed };
  }
}
