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

  const leading = options?.leading ?? false;
  const trailing = options?.trailing ?? true;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: A | undefined;
  let callCount = 0;

  const cancel = () => {
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
      timer = undefined;
    }
    lastArgs = undefined;
    callCount = 0;
  };

  const invokeTrailing = () => {
    if (trailing && (!leading || callCount > 1)) {
      fn(...lastArgs!);
    }
  };

  const flush = () => {
    if (timer === undefined) return;
    try {
      invokeTrailing();
    } finally {
      cancel();
    }
  };

  const pending = (): boolean => timer !== undefined;

  const debounced = (...args: A): void => {
    const isBurstStart = timer === undefined;
    
    callCount++;
    lastArgs = args;

    if (isBurstStart && leading) {
      // Leading call: executed synchronously
      fn(...args);
    }

    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
    }

    timer = globalThis.setTimeout(() => {
      try {
        invokeTrailing();
      } finally {
        timer = undefined;
        callCount = 0;
        lastArgs = undefined;
      }
    }, waitMs);
  };

  // Attach methods to the function object
  Object.assign(debounced, {
    cancel,
    flush,
    pending,
  });

  return debounced as Debounced<A>;
}
