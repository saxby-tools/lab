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
  if (
    !Number.isFinite(waitMs) ||
    waitMs < 0
  ) {
    throw new RangeError("waitMs must be a finite number 0 or more");
  }

  const leading = options?.leading ?? false;
  const trailing = options?.trailing ?? true;

  let timerId: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: A | undefined;
  let callCount = 0;

  const cancelBurst = (): void => {
    if (
      timerId !== undefined
    ) {
      globalThis.clearTimeout(timerId);
    }

    timerId = undefined;
    lastArgs = undefined;
    callCount = 0;
  };

  const invokeTrailing = (): void => {
    const shouldCall =
      trailing &&
      (!leading || callCount > 1);

    if (
      shouldCall &&
      lastArgs !== undefined
    ) {
      fn(...lastArgs);
    }

    cancelBurst();
  };

  const wrapper = (...args: A): void => {
    const isFirstCall = timerId === undefined;

    if (
      isFirstCall &&
      leading
    ) {
      fn(...args);
    }

    lastArgs = args;
    callCount++;

    if (
      timerId !== undefined
    ) {
      globalThis.clearTimeout(timerId);
    }

    timerId = globalThis.setTimeout(
      invokeTrailing,
      waitMs,
    );
  };

  const debounced = wrapper as Debounced<A>;

  debounced.cancel = (): void => {
    cancelBurst();
  };

  debounced.flush = (): void => {
    if (
      timerId === undefined
    ) {
      return;
    }

    invokeTrailing();
  };

  debounced.pending = (): boolean => {
    return timerId !== undefined;
  };

  return debounced;
}
