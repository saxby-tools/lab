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

/**
 * Debounce implementation for Deno 2 / TypeScript.
 * 
 * A burst starts with a call made while no burst is active. Every call during a
 * burst restarts a timer. When the timer fires, the burst ends.
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
  options?: DebounceOptions,
): Debounced<A> {
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new RangeError("waitMs must be a finite number 0 or more.");
  }

  const leading = options?.leading ?? false;
  const trailing = options?.trailing ?? true;

  let timerId: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: A | undefined;
  let callCount = 0;

  const timerExpired = () => {
    const args = lastArgs;
    const count = callCount;

    // Reset burst state before executing fn to ensure the burst ends 
    // normally regardless of whether fn throws.
    timerId = undefined;
    callCount = 0;
    lastArgs = undefined;

    if (trailing && args !== undefined) {
      // Skip trailing call if the only call in the burst was handled by the leading call.
      if (!(leading && count === 1)) {
        fn(...args);
      }
    }
  };

  const debounced = function (...args: A) {
    lastArgs = args;
    callCount++;

    const isBursting = timerId !== undefined;

    // Leading edge execution
    if (!isBursting && leading) {
      fn(...args);
    }

    // Refresh timer
    if (timerId !== undefined) {
      globalThis.clearTimeout(timerId);
    }

    timerId = globalThis.setTimeout(timerExpired, waitMs);
  } as Debounced<A>;

  debounced.cancel = () => {
    if (timerId !== undefined) {
      globalThis.clearTimeout(timerId);
    }
    timerId = undefined;
    callCount = 0;
    lastArgs = undefined;
  };

  debounced.flush = () => {
    if (timerId === undefined) {
      return;
    }

    const args = lastArgs;
    const count = callCount;

    try {
      if (trailing && args !== undefined) {
        // Only execute if it would have executed on timer expiration
        if (!(leading && count === 1)) {
          fn(...args);
        }
      }
    } finally {
      // Ensure burst ends normally even if fn throws
      debounced.cancel();
    }
  };

  debounced.pending = () => timerId !== undefined;

  return debounced;
}
