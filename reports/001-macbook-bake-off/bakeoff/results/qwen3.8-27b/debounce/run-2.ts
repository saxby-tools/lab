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
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new RangeError("waitMs must be a finite number, 0 or more");
  }

  const leading = options?.leading ?? false;
  const trailing = options?.trailing ?? true;

  let timerId: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: A | undefined;
  let callCount = 0;
  let burstActive = false;

  function onTimer(): void {
    const args = lastArgs;
    const count = callCount;

    // End the burst before invoking fn so state is clean even if fn throws
    timerId = undefined;
    lastArgs = undefined;
    callCount = 0;
    burstActive = false;

    if (args === undefined) return;
    if (trailing && !(leading && count === 1)) {
      fn(...args);
    }
  }

  function debounced(...args: A): void {
    lastArgs = args;
    callCount++;

    if (!burstActive) {
      burstActive = true;
    }

    // Restart (or start) the timer before the leading call so that
    // the burst still ends normally even if the leading fn invocation throws.
    if (timerId !== undefined) {
      globalThis.clearTimeout(timerId);
    }
    timerId = globalThis.setTimeout(onTimer, waitMs);

    if (leading && callCount === 1) {
      fn(...args);
    }
  }

  function cancel(): void {
    if (timerId !== undefined) {
      globalThis.clearTimeout(timerId);
    }
    timerId = undefined;
    lastArgs = undefined;
    callCount = 0;
    burstActive = false;
  }

  function flush(): void {
    if (!burstActive) return;

    const args = lastArgs;
    const count = callCount;

    // End the burst before invoking fn so state is clean even if fn throws.
    if (timerId !== undefined) {
      globalThis.clearTimeout(timerId);
    }
    timerId = undefined;
    lastArgs = undefined;
    callCount = 0;
    burstActive = false;

    if (args !== undefined && trailing && !(leading && count === 1)) {
      fn(...args);
    }
  }

  function pending(): boolean {
    return burstActive;
  }

  debounced.cancel = cancel;
  debounced.flush = flush;
  debounced.pending = pending;

  return debounced;
}
