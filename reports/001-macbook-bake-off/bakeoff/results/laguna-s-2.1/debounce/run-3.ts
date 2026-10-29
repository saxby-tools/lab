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

  let timerId: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;
  let leadingCallOccurred = false;

  const endBurst = (): void => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    if (trailing && lastArgs !== null && !leadingCallOccurred) {
      const args = lastArgs;
      lastArgs = null;
      fn(...args);
    }
    leadingCallOccurred = false;
  };

  const debounced = function (...args: A): void {
    if (timerId === null) {
      // Burst starts
      leadingCallOccurred = false;
      if (leading) {
        leadingCallOccurred = true;
        fn(...args);
      }
    } else {
      // Burst continues, restart timer
    }

    if (timerId !== null) {
      clearTimeout(timerId);
    }

    lastArgs = args;
    timerId = setTimeout(() => {
      timerId = null;
      endBurst();
    }, waitMs);
  } as Debounced<A>;

  debounced.cancel = (): void => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    lastArgs = null;
    leadingCallOccurred = false;
  };

  debounced.flush = (): void => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
      if (trailing && lastArgs !== null && !leadingCallOccurred) {
        const args = lastArgs;
        lastArgs = null;
        fn(...args);
      }
      leadingCallOccurred = false;
    }
  };

  debounced.pending = (): boolean => {
    return timerId !== null;
  };

  return debounced;
}
