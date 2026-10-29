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
    throw new RangeError(`Invalid waitMs: ${waitMs}`);
  }

  const leading = options?.leading ?? false;
  const trailing = options?.trailing ?? true;

  let timerId: ReturnType<typeof setTimeout> | undefined;
  let lastArgs: A | undefined;
  let callCount = 0;
  let burstActive = false;

  function endBurst(): void {
    const args = lastArgs;
    const count = callCount;

    timerId = undefined;
    burstActive = false;
    lastArgs = undefined;
    callCount = 0;

    if (args === undefined) return;

    // Skip trailing if the only call was already handled by the leading edge.
    if (trailing && !(leading && count === 1)) {
      fn(...args);
    }
  }

  function onTimer(): void {
    endBurst();
  }

  const debounced = ((...args: A): void => {
    if (burstActive) {
      // Subsequent call within the same burst: restart the timer.
      globalThis.clearTimeout(timerId!);
      timerId = globalThis.setTimeout(onTimer, waitMs);
      lastArgs = args;
      callCount++;
      return;
    }

    // First call of a new burst.
    burstActive = true;
    lastArgs = args;
    callCount = 1;
    timerId = globalThis.setTimeout(onTimer, waitMs);

    if (leading) {
      // Synchronous leading invocation; errors propagate to the caller
      // but the timer is already set so the burst lifecycle is intact.
      fn(...args);
    }
  }) as Debounced<A>;

  debounced.cancel = function cancel(): void {
    if (!burstActive) return;
    globalThis.clearTimeout(timerId!);
    timerId = undefined;
    burstActive = false;
    lastArgs = undefined;
    callCount = 0;
  };

  debounced.flush = function flush(): void {
    if (!burstActive) return;
    globalThis.clearTimeout(timerId!);
    // endBurst resets state and performs the trailing call if one is due.
    // Errors from fn propagate to the flush() caller.
    endBurst();
  };

  debounced.pending = function pending(): boolean {
    return burstActive;
  };

  return debounced;
}
