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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: unknown,
  options?: DebounceOptions,
): Debounced<A> {
  if (!isFiniteNumber(waitMs) || waitMs < 0) {
    throw new RangeError("waitMs must be a finite number >= 0");
  }

  const leading = options?.leading ?? false;
  const trailing = options?.trailing ?? true;

  let timerId: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;
  let inLeadingCall = false;

  const invoke = (args: A) => {
    inLeadingCall = true;
    try {
      fn(...args);
    } finally {
      inLeadingCall = false;
    }
  };

  const startTimer = () => {
    clearTimer();
    timerId = setTimeout(() => {
      timerId = null;
      const args = lastArgs;
      lastArgs = null;
      if (trailing && args !== null && !inLeadingCall) {
        invoke(args);
      }
    }, waitMs);
  };

  const clearTimer = () => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  const endBurst = () => {
    clearTimer();
    lastArgs = null;
  };

  const debounced = (...args: A): void => {
    const isNewBurst = timerId === null;
    lastArgs = args;
    startTimer();
    if (leading && isNewBurst) {
      invoke(args);
    }
  };

  debounced.cancel = () => {
    endBurst();
  };

  debounced.flush = () => {
    if (timerId === null) return;
    const args = lastArgs;
    endBurst();
    if (trailing && args !== null && !inLeadingCall) {
      invoke(args);
    }
  };

  debounced.pending = () => timerId !== null;

  return debounced;
}
