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
    throw new RangeError('waitMs must be a finite number 0 or more');
  }

  const leading = options?.leading ?? false;
  const trailing = options?.trailing ?? true;

  let timerId: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: A | undefined;
  let callCount = 0;

  const invoke = () => {
    if (lastArgs === undefined) {
      return;
    }

    fn(...lastArgs);
  };

  const cancel = () => {
    if (timerId !== undefined) {
      clearTimeout(timerId);
    }

    timerId = undefined;
    callCount = 0;
    lastArgs = undefined;
  };

  const timerExpired = () => {
    try {
      const shouldTrailing = trailing && (callCount > 1 || !leading);

      if (shouldTrailing) {
        invoke();
      }
    } finally {
      // Ensure burst ends regardless of whether fn threw
      timerId = undefined;
      callCount = 0;
    }
  };

  const flush = () => {
    if (callCount === 0) {
      return;
    }

    try {
      const shouldTrailing = trailing && (callCount > 1 || !leading);

      if (shouldTrailing) {
        invoke();
      }
    } finally {
      cancel();
    }
  };

  const pending = () => {
    return callCount > 0;
  };

  const debounced = (...args: A): void => {
    lastArgs = args;
    callCount++;

    if (callCount === 1 && leading) {
      fn(...args);
    }

    if (timerId !== undefined) {
      clearTimeout(timerId);
    }

    timerId = setTimeout(timerExpired, waitMs);
  };

  const result = debounced as Debounced<A>;

  result.cancel = cancel;
  result.flush = flush;
  result.pending = pending;

  return result;
}
