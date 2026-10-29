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

  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;
  let called = false;

  const endBurst = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    lastArgs = null;
    called = false;
  };

  const callFn = (args: A): void => {
    fn(...args);
  };

  const triggerTrailing = (): void => {
    if (trailing && lastArgs !== null && !called) {
      callFn(lastArgs);
    }
  };

  const debounced = (...args: A): void => {
    if (timer === null) {
      if (leading) {
        callFn(args);
        called = true;
      } else {
        called = false;
      }
      lastArgs = args;
      timer = setTimeout(() => {
        triggerTrailing();
        endBurst();
      }, waitMs);
    } else {
      lastArgs = args;
    }
  };

  debounced.cancel = (): void => {
    endBurst();
  };

  debounced.flush = (): void => {
    if (timer !== null) {
      triggerTrailing();
      endBurst();
    }
  };

  debounced.pending = (): boolean => {
    return timer !== null;
  };

  return debounced;
}
