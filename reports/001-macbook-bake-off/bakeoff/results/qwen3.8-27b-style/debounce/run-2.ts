// Constants ------------------------------------------------

const WAIT_MSG = "waitMs must be a finite number >= 0";

// Types ----------------------------------------------------

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

// Implementation -------------------------------------------

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
  options?: DebounceOptions,
): Debounced<A> {
  // Reject invalid waitMs before any work is done.
  if (!Number.isFinite(waitMs)) {
    throw new RangeError(WAIT_MSG);
  }
  if (waitMs < 0) {
    throw new RangeError(WAIT_MSG);
  }

  const leading = options?.leading ?? false;
  const trailing = options?.trailing ?? true;

  // Mutable closure state; reset on every burst end.
  let timerId: number | undefined;
  let lastArgs: A | undefined;
  let callCount = 0;

  // Trailing fires unless the sole call was already consumed by leading.
  function shouldTrailingFire(count: number): boolean {
    if (!trailing) {
      return false;
    }
    if (leading) {
      if (count <= 1) {
        return false;
      }
    }
    return true;
  }

  // Timer callback: end the burst first so state is clean
  // even if fn throws in the trailing call.
  function onTimer(): void {
    timerId = undefined;
    const args = lastArgs;
    const count = callCount;
    lastArgs = undefined;
    callCount = 0;

    if (args === undefined) {
      return;
    }

    if (shouldTrailingFire(count)) {
      fn(...args);
    }
  }

  function debounced(...args: A): void {
    const isNewBurst = timerId === undefined;

    if (isNewBurst) {
      callCount = 0;
    }

    lastArgs = args;
    callCount++;

    // Always set the timer so the burst survives a throwing fn.
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }
    timerId = setTimeout(onTimer, waitMs);

    // Leading fires synchronously on the first call of a burst;
    // errors propagate to the caller but the burst continues.
    if (isNewBurst) {
      if (leading) {
        fn(...args);
      }
    }
  }

  function cancel(): void {
    if (timerId === undefined) {
      return;
    }
    clearTimeout(timerId);
    timerId = undefined;
    lastArgs = undefined;
    callCount = 0;
  }

  // Flush ends the burst immediately, then fires the trailing
  // call synchronously so the caller can catch errors.
  function flush(): void {
    if (timerId === undefined) {
      return;
    }

    clearTimeout(timerId);
    const args = lastArgs;
    const count = callCount;
    timerId = undefined;
    lastArgs = undefined;
    callCount = 0;

    if (args === undefined) {
      return;
    }

    if (shouldTrailingFire(count)) {
      fn(...args);
    }
  }

  function pending(): boolean {
    return timerId !== undefined;
  }

  debounced.cancel = cancel;
  debounced.flush = flush;
  debounced.pending = pending;

  return debounced as Debounced<A>;
}
