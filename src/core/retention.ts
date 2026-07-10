const DAY_MS = 24 * 60 * 60 * 1000;

/** Purge old data on startup and then once a day. The timer never blocks shutdown. */
export function startRetention(
  store: { purgeOlderThan(days: number): void },
  days = 90,
): { stop(): void } {
  store.purgeOlderThan(days);
  const timer = setInterval(() => store.purgeOlderThan(days), DAY_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
