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
  if (waitMs < 0 || !Number.isFinite(waitMs)) {
    throw new RangeError('waitMs must be a finite non-negative number');
  }

  const leading = options.leading ?? false;
  const trailing = options.trailing ?? true;

  let timerId: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: A | undefined;
  let leadingCalled = false;

  const debounced = ((...args: A): void => {
    lastArgs = args;

    if (timerId === undefined) {
      // Burst starts with this call
      if (leading) {
        fn(...args);
        leadingCalled = true;
      }
    }

    // Clear existing timer and schedule new one
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }

    timerId = setTimeout(() => {
      if (trailing && !leadingCalled) {
        if (lastArgs !== undefined) {
          fn(...lastArgs);
        }
      }
      // Reset for next burst
      timerId = undefined;
      lastArgs = undefined;
      leadingCalled = false;
    }, waitMs) as ReturnType<typeof setTimeout>;
  }) as Debounced<A>;

  debounced.cancel = (): void => {
    if (timerId !== undefined) {
      clearTimeout(timerId);
      timerId = undefined;
    }
    lastArgs = undefined;
    leadingCalled = false;
  };

  debounced.flush = (): void => {
    if (timerId !== undefined) {
      if (trailing && !leadingCalled) {
        if (lastArgs !== undefined) {
          fn(...lastArgs);
        }
      }
      clearTimeout(timerId);
      timerId = undefined;
      lastArgs = undefined;
      leadingCalled = false;
    }
  };

  debounced.pending = (): boolean => {
    return timerId !== undefined;
  };

  return debounced;
}
