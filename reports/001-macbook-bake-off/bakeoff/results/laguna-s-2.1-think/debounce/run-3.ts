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
  options: DebounceOptions = {},
): Debounced<A> {
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new RangeError("waitMs must be a finite number, 0 or more");
  }

  const leading = options.leading ?? false;
  const trailing = options.trailing ?? true;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;
  let isInvoking = false;

  const debounced = function (this: unknown, ...args: A): void {
    if (timeoutId === null) {
      if (leading) {
        try {
          fn.apply(this, args);
        } finally {
          // Burst ends here if leading call happened; trailing call should be skipped.
        }
        isInvoking = true;
      } else {
        isInvoking = false;
      }

      lastArgs = leading ? null : args;
      timeoutId = setTimeout(onTimeout, waitMs);
    } else {
      lastArgs = args;
    }
  };

  function onTimeout(): void {
    timeoutId = null;

    if (trailing && lastArgs !== null && !isInvoking) {
      isInvoking = true;
      const args = lastArgs;
      lastArgs = null;
      fn.apply(undefined as unknown, args); // Timer callback context is irrelevant.
    }

    isInvoking = false;
  }

  debounced.cancel = function (): void {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    lastArgs = null;
    isInvoking = false;
  };

  debounced.flush = function (): void {
    if (timeoutId === null) {
      return;
    }

    clearTimeout(timeoutId);
    timeoutId = null;

    if (trailing && lastArgs !== null && !isInvoking) {
      isInvoking = true;
      const args = lastArgs;
      lastArgs = null;
      fn.apply(undefined as unknown, args);
    }

    isInvoking = false;
  };

  debounced.pending = function (): boolean {
    return timeoutId !== null;
  };

  return debounced;
}
