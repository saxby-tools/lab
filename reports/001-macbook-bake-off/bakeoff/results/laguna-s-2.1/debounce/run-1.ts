export interface DebounceOptions {
  leading?: boolean;
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
    throw new RangeError("waitMs must be a finite number >= 0");
  }

  const leading = options?.leading ?? false;

  let timerId: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;
  let leadingInvoked = false;

  const clearTimeout = globalThis.clearTimeout;
  const setTimeout = globalThis.setTimeout;

  function invokeFn(args: A) {
    fn(...args);
  }

  function startBurst(args: A) {
    if (timerId !== null) {
      clearTimeout(timerId);
    }

    lastArgs = args;
    leadingInvoked = false;

    if (leading) {
      invokeFn(args);
      leadingInvoked = true;
    }

    timerId = setTimeout(() => {
      timerId = null;

      if (!leading && lastArgs !== null) {
        invokeFn(lastArgs);
      } else if (leading && lastArgs !== null && !leadingInvoked) {
        invokeFn(lastArgs);
      }

      lastArgs = null;
      leadingInvoked = false;
    }, waitMs);
  }

  function debounced(this: unknown, ...args: A): void {
    if (timerId === null) {
      startBurst(args);
    } else {
      if (lastArgs !== null) {
        lastArgs = args;
      } else {
        lastArgs = args;
      }

      if (timerId !== null) {
        clearTimeout(timerId);
      }

      timerId = setTimeout(() => {
        timerId = null;

        if (!leading && lastArgs !== null) {
          invokeFn(lastArgs);
        } else if (leading && lastArgs !== null && !leadingInvoked) {
          invokeFn(lastArgs);
        }

        lastArgs = null;
        leadingInvoked = false;
      }, waitMs);
    }
  }

  debounced.cancel = function (): void {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    lastArgs = null;
    leadingInvoked = false;
  };

  debounced.flush = function (): void {
    if (timerId === null) return;

    clearTimeout(timerId);
    timerId = null;

    if (!leading && lastArgs !== null) {
      invokeFn(lastArgs);
    } else if (leading && lastArgs !== null && !leadingInvoked) {
      invokeFn(lastArgs);
    }

    lastArgs = null;
    leadingInvoked = false;
  };

  debounced.pending = function (): boolean {
    return timerId !== null;
  };

  return debounced as Debounced<A>;
}
