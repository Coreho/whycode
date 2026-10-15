// Runs async work on several items at once but hands the results over in
// the items' order, so output reads top to bottom while AI calls overlap.

type Settled<R> = { ok: true; value: R } | { ok: false; error: unknown };

export async function forEachInOrder<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
  /** Awaited before the next result is handed over. */
  onResult: (result: R) => void | Promise<void>,
): Promise<void> {
  // A sliding window: the oldest job is awaited before the next one starts.
  const window: Promise<Settled<R>>[] = [];
  const deliverOldest = async (): Promise<void> => {
    const oldest = window.shift();
    if (oldest === undefined) return;
    const settled = await oldest;
    if (!settled.ok) throw settled.error;
    await onResult(settled.value);
  };

  for (const item of items) {
    if (window.length >= Math.max(1, concurrency)) await deliverOldest();
    window.push(settle(run(item)));
  }
  while (window.length > 0) await deliverOldest();
}

/** Never rejects, so a failure waiting in the window can't go unhandled. */
function settle<R>(promise: Promise<R>): Promise<Settled<R>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}
