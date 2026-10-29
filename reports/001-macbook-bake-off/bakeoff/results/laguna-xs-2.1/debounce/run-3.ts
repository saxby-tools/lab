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
  options: DebounceOptions = {},
): Debounced<A> {
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new RangeError("waitMs must be a finite number, 0 or more");
  }

  const leading = options.leading ?? false;
  const trailing = options.trailing ?? true;

  let timerId: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: A | undefined;
  let lastThis: unknown;
  let burstActive = false;
  let leadingCalled = false;

  const debounced = function (this: unknown, ...args: A): void {
    lastThis = this;
    lastArgs = args;

    if (!burstActive) {
      burstActive = true;
      leadingCalled = false;

      if (leading && timerId === undefined) {
        try {
          fn.apply(this, args);
          leadingCalled = true;
        } catch {
          // Error will propagate, burst still ends normally
        }
      }

      timerId = setTimeout(() => {
        const shouldCallTrailing = trailing && !leadingCalled && lastArgs !== undefined;

        if (shouldCallTrailing) {
          try {
            fn.apply(lastThis, lastArgs);
          } catch {
            // Error propagates, burst ends normally
          }
        }

        timerId = undefined;
        burstActive = false;
        lastArgs = undefined;
        leadingCalled = false;
      }, waitMs);
    } else {
      // Restart timer in burst
      clearTimeout(timerId);
      timerId = setTimeout(() => {
        const shouldCallTrailing = trailing && !leadingCalled && lastArgs !== undefined;

        if (shouldCallTrailing) {
          try {
            fn.apply(lastThis, lastArgs);
          } catch {
            // Error propagates, burst ends normally
          }
        }

        timerId = undefined;
        burstActive = false;
        lastArgs = undefined;
        leadingCalled = false;
      }, waitMs);
    }
  };

  debounced.cancel = () => {
    if (timerId !== undefined) {
      clearTimeout(timerId);
      timerId = undefined;
    }
    burstActive = false;
    lastArgs = undefined;
    leadingCalled = false;
  };

  debounced.flush = () => {
    if (!burstActive || timerId === undefined) {
      return;
    }

    clearTimeout(timerId);
    timerId = undefined;

    if (trailing && !leadingCalled && lastArgs !== undefined) {
      try {
        fn.apply(lastThis, lastArgs);
      } catch {
        // Error propagates, burst ends normally
      }
    }

    burstActive = false;
    lastArgs = undefined;
    leadingCalled = false;
  };

  debounced.pending = (): boolean => {
    return burstActive;
  };

  return debounced as Debounced<A>;
}
