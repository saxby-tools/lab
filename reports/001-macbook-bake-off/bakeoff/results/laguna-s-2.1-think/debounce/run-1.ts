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
  if (typeof waitMs !== "number" || !Number.isFinite(waitMs) || waitMs < 0) {
    throw new RangeError("`waitMs` must be a finite number >= 0");
  }

  const leading = options?.leading ?? false;
  const trailing = options?.trailing ?? true;

  let timerId: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;
  let leadingCalled = false;
  let hasMultipleCalls = false;

  function endBurst(): void {
    timerId = null;
    const shouldSkipTrailing = leadingCalled && !hasMultipleCalls;
    const argsToCall = lastArgs;
    lastArgs = null;
    leadingCalled = false;
    hasMultipleCalls = false;

    if (trailing && argsToCall !== null && !shouldSkipTrailing) {
      fn(...argsToCall);
    }
  }

  const debounced = function (...args: A): void {
    const isNewBurst = timerId === null;

    if (isNewBurst) {
      leadingCalled = false;
      hasMultipleCalls = false;
    } else {
      hasMultipleCalls = true;
    }

    lastArgs = args;

    if (timerId !== null) {
      clearTimeout(timerId);
    }

    timerId = setTimeout(() => {
      endBurst();
    }, waitMs);

    if (isNewBurst && leading) {
      leadingCalled = true;
      fn(...args);
    }
  } as Debounced<A>;

  debounced.cancel = function (): void {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    lastArgs = null;
    leadingCalled = false;
    hasMultipleCalls = false;
  };

  debounced.flush = function (): void {
    if (timerId === null) {
      return;
    }
    clearTimeout(timerId);
    endBurst();
  };

  debounced.pending = function (): boolean {
    return timerId !== null;
  };

  return debounced;
}
