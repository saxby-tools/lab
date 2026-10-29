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
  let latestArgs: A | null = null;
  let burstCallCount = 0;

  function endBurst(): void {
    const args = latestArgs;
    const count = burstCallCount;

    timerId = undefined;
    latestArgs = null;
    burstCallCount = 0;

    if (args !== null && trailing && !(leading && count === 1)) {
      fn(...args);
    }
  }

  const debounced = ((...args: A): void => {
    if (timerId !== undefined) {
      globalThis.clearTimeout(timerId);
      timerId = globalThis.setTimeout(() => endBurst(), waitMs);
      latestArgs = args;
      burstCallCount++;
    } else {
      latestArgs = args;
      burstCallCount = 1;
      timerId = globalThis.setTimeout(() => endBurst(), waitMs);
      if (leading) {
        fn(...args);
      }
    }
  }) as Debounced<A>;

  debounced.cancel = (): void => {
    if (timerId !== undefined) {
      globalThis.clearTimeout(timerId);
      timerId = undefined;
    }
    latestArgs = null;
    burstCallCount = 0;
  };

  debounced.flush = (): void => {
    if (timerId === undefined) return;
    globalThis.clearTimeout(timerId);
    endBurst();
  };

  debounced.pending = (): boolean => {
    return timerId !== undefined;
  };

  return debounced;
}
