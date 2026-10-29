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
  if (!Number.isFinite(waitMs)) {
    throw new RangeError("waitMs must be a finite number");
  }

  if (waitMs < 0) {
    throw new RangeError("waitMs must be 0 or more");
  }

  const leading = options?.leading ?? false;
  const trailing = options?.trailing ?? true;

  let timerId: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: A | undefined;
  let callCount = 0;
  let isBursting = false;

  const execute = (args: A) => {
    fn(...args);
  };

  const clearTimer = () => {
    if (timerId !== undefined) {
      clearTimeout(timerId);
      timerId = undefined;
    }
  };

  const shouldExecuteTrailing = () => {
    if (!trailing) {
      return false;
    }

    if (leading) {
      if (callCount <= 1) {
        return false;
      }
    }

    return true;
  };

  const completeBurst = () => {
    if (shouldExecuteTrailing()) {
      if (lastArgs) {
        execute(lastArgs);
      }
    }

    clearTimer();
    isBursting = false;
    callCount = 0;
  };

  const timerCallback = () => {
    completeBurst();
  };

  const cancel = () => {
    clearTimer();
    isBursting = false;
    callCount = 0;
    lastArgs = undefined;
  };

  const flush = () => {
    if (!isBursting) {
      return;
    }

    completeBurst();
  };

  const pending = (): boolean => {
    return isBursting;
  };

  const debounced = (...args: A): void => {
    lastArgs = args;
    callCount++;

    if (!isBursting) {
      isBursting = true;

      if (leading) {
        execute(args);
      }
    }

    clearTimer();
    timerId = setTimeout(timerCallback, waitMs);
  };

  debounced.cancel = cancel;
  debounced.flush = flush;
  debounced.pending = pending;

  return debounced;
}
