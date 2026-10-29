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

  let pending = false;
  let timerId: number | null = null;
  let lastArgs: A | null = null;
  let leadingInvoked = false;
  let callCount = 0;

  // When the timer fires the burst ends; call fn for the
  // trailing edge unless it would duplicate the leading call.
  function onTimer(): void {
    timerId = null;
    pending = false;

    if (!trailing) return;
    if (leadingInvoked && callCount === 1) return;
    if (lastArgs === null) return;

    const args = lastArgs;
    lastArgs = null;
    leadingInvoked = false;
    callCount = 0;

    fn(...args);
  }

  function debounced(...args: A): void {
    const isStart = !pending;

    // Every call, including the first, restarts the timer.
    if (timerId !== null) {
      globalThis.clearTimeout(timerId);
    }
    timerId = globalThis.setTimeout(onTimer, waitMs);

    lastArgs = args;

    if (isStart) {
      pending = true;
      callCount = 1;
      leadingInvoked = false;

      // The timer is already armed, so a throw from fn
      // here leaves the burst in a consistent state.
      if (leading) {
        leadingInvoked = true;
        fn(...args);
      }
    } else {
      callCount++;
    }
  }

  debounced.cancel = function cancel(): void {
    if (timerId !== null) {
      globalThis.clearTimeout(timerId);
    }
    timerId = null;
    pending = false;
    lastArgs = null;
    leadingInvoked = false;
    callCount = 0;
  };

  debounced.flush = function flush(): void {
    if (!pending) return;

    // End the burst before invoking fn so a throw does
    // not leave stale pending state behind.
    if (timerId !== null) {
      globalThis.clearTimeout(timerId);
    }
    timerId = null;
    pending = false;

    if (!trailing) return;
    if (leadingInvoked && callCount === 1) return;
    if (lastArgs === null) return;

    const args = lastArgs;
    lastArgs = null;
    leadingInvoked = false;
    callCount = 0;

    fn(...args);
  };

  debounced.pending = () => pending;

  return debounced;
}
