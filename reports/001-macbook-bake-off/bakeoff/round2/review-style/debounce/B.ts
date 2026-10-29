const DEFAULT_LEADING = false;

const DEFAULT_TRAILING = true;

export interface DebounceOptions {
  leading?: boolean;
  trailing?: boolean;
}

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
  flush(): void;
  pending(): boolean;
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
  options?: DebounceOptions,
): Debounced<A> {
  // Reject non-finite or negative waits up front so callers see
  // a synchronous RangeError rather than a misbehaving timer.
  if (!Number.isFinite(waitMs)) {
    throw new RangeError(
      `waitMs must be a finite number, got ${String(waitMs)}`,
    );
  }

  if (waitMs < 0) {
    throw new RangeError(
      `waitMs must be >= 0, got ${waitMs}`,
    );
  }

  const leading = options?.leading ?? DEFAULT_LEADING;
  const trailing = options?.trailing ?? DEFAULT_TRAILING;

  // All three are "no burst" when timerId is undefined.
  let timerId: number | undefined;
  let lastArgs: A | undefined;
  let callCount = 0;

  function endBurst(): void {
    // Clearing an already-fired timer is a harmless no-op.
    if (timerId !== undefined) {
      globalThis.clearTimeout(timerId);
    }

    timerId = undefined;
    lastArgs = undefined;
    callCount = 0;
  }

  // A trailing call is suppressed only when the leading edge
  // already consumed the sole call in a single-call burst.
  function shouldTrail(): boolean {
    if (!trailing) {
      return false;
    }

    if (leading && callCount <= 1) {
      return false;
    }

    return true;
  }

  function onTimer(): void {
    // Capture before teardown so a trailing call still has args.
    const args = lastArgs;
    const trail = shouldTrail();

    endBurst();

    if (!trail) {
      return;
    }

    // args is always set here because the timer was armed
    // inside debounced() after assigning lastArgs.
    fn(...(args as A));
  }

  function debounced(...args: A): void {
    const isNewBurst = timerId === undefined;

    lastArgs = args;
    callCount++;

    // Arm the timer before invoking fn so a thrown error in the
    // leading call does not leave the burst in a half-open state.
    if (timerId !== undefined) {
      globalThis.clearTimeout(timerId);
    }

    timerId = globalThis.setTimeout(onTimer, waitMs);

    if (leading && isNewBurst) {
      fn(...args);
    }
  }

  function cancel(): void {
    endBurst();
  }

  function flush(): void {
    if (timerId === undefined) {
      return;
    }

    const args = lastArgs;
    const trail = shouldTrail();

    endBurst();

    if (!trail) {
      return;
    }

    fn(...(args as A));
  }

  function pending(): boolean {
    return timerId !== undefined;
  }

  // Bind the helper methods onto the callable so the returned value
  // satisfies Debounced<A>.
  debounced.cancel = cancel;
  debounced.flush = flush;
  debounced.pending = pending;

  return debounced;
}
