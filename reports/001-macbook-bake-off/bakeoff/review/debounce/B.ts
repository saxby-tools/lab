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
    throw new RangeError("waitMs must be a finite number 0 or more.");
  }

  const { leading = false, trailing = true } = options ?? {};

  let timerId: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: A | undefined;
  let count = 0;
  let leadingCallExecuted = false;

  /**
   * Clears the timer and resets the state of the burst.
   */
  const reset = () => {
    if (timerId !== undefined) {
      globalThis.clearTimeout(timerId);
      timerId = undefined;
    }
    lastArgs = undefined;
    count = 0;
    leadingCallExecuted = false;
  };

  /**
   * Logic to determine if the trailing call should be executed and 
   * perform that execution.
   */
  const executeTrailing = () => {
    const args = lastArgs;
    // Trailing call happens if trailing is enabled AND 
    // (this wasn't the only call in the burst OR the only call wasn't already handled by leading)
    const shouldExecute = trailing && (count > 1 || !leadingCallExecuted);
    
    // The burst ends regardless of whether fn is called or if it throws.
    reset();

    if (shouldExecute && args !== undefined) {
      fn(...args);
    }
  };

  /**
   * The primary debounced function.
   */
  const debouncedFunc = (...args: A) => {
    count++;
    lastArgs = args;

    if (timerId === undefined) {
      // Start of a new burst
      if (leading) {
        fn(...args);
        leadingCallExecuted = true;
      }
      timerId = globalThis.setTimeout(executeTrailing, waitMs);
    } else {
      // Existing burst: restart the timer
      globalThis.clearTimeout(timerId);
      timerId = globalThis.setTimeout(executeTrailing, waitMs);
    }
  };

  // Attach utility methods to the function object
  const debounced = Object.assign(debouncedFunc, {
    cancel: () => {
      reset();
    },
    flush: () => {
      if (timerId === undefined) return;
      executeTrailing();
    },
    pending: () => {
      return timerId !== undefined;
    },
  });

  return debounced as unknown as Debounced<A>;
}
