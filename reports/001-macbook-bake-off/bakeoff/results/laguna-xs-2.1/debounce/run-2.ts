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
  let burstActive = false;
  let callCount = 0;

  const debounced = (...args: A): void => {
    lastArgs = args;

    const isNewBurst = !burstActive;

    if (timerId !== undefined) {
      clearTimeout(timerId);
    }

    callCount++;

    timerId = setTimeout(() => {
      const shouldCallTrailing = trailing && callCount > (leading ? 1 : 0);

      if (shouldCallTrailing) {
        fn(...lastArgs!);
      }

      timerId = undefined;
      lastArgs = undefined;
      burstActive = false;
      callCount = 0;
    }, waitMs);

    if (isNewBurst) {
      burstActive = true;
    }

    if (leading && isNewBurst) {
      fn(...args);
    }
  };

  debounced.cancel = (): void => {
    if (timerId !== undefined) {
      clearTimeout(timerId);
      timerId = undefined;
    }
    lastArgs = undefined;
    burstActive = false;
    callCount = 0;
  };

  debounced.flush = (): void => {
    if (timerId !== undefined) {
      clearTimeout(timerId);
      timerId = undefined;
    }

    if (trailing && callCount > (leading ? 1 : 0)) {
      fn(...lastArgs!);
    }

    burstActive = false;
    lastArgs = undefined;
    callCount = 0;
  };

  debounced.pending = (): boolean => {
    return burstActive;
  };

  return debounced;
}
