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
  options: DebounceOptions = {},
): Debounced<A> {
  // Validate waitMs
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new RangeError("waitMs must be a finite non-negative number");
  }

  const leading = options.leading ?? false;
  const trailing = options.trailing ?? true;

  let timerId: number | null = null;
  let argsForLastCall: A | null = null;
  let isLeadingCallPending = false;

  const clearTimer = () => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  const callFn = (args: A) => {
    try {
      fn(...args);
    } finally {
      // Always end the burst after calling the function
      isLeadingCallPending = false;
      argsForLastCall = null;
    }
  };

  const executeTrailingCall = () => {
    // Only execute if we have arguments and trailing is enabled
    if (trailing && argsForLastCall !== null) {
      const args = argsForLastCall;
      argsForLastCall = null;
      callFn(args);
    }
  };

  const debounced: Debounced<A> = ((...args: A) => {
    argsForLastCall = args;

    // If timer is already running, just restart it
    if (timerId !== null) {
      clearTimer();
      timerId = setTimeout(executeTrailingCall, waitMs);
      return;
    }

    // No active timer, so this starts a new burst

    // Handle leading call if enabled
    if (leading) {
      // We'll call the function immediately
      isLeadingCallPending = true;
      callFn(args);

      // If trailing is disabled, we're done
      if (!trailing) {
        return;
      }

      // Set timer for trailing call (unless only one call was made)
      // But we'll set it anyway since more calls might come during the burst
      timerId = setTimeout(executeTrailingCall, waitMs);
    } else {
      // No leading call, set timer for trailing call
      if (trailing) {
        timerId = setTimeout(executeTrailingCall, waitMs);
      }
    }
  }) as Debounced<A>;

  debounced.cancel = () => {
    clearTimer();
    argsForLastCall = null;
    isLeadingCallPending = false;
  };

  debounced.flush = () => {
    // If no burst is active, do nothing
    if (timerId === null && !isLeadingCallPending) {
      return;
    }

    // Cancel any pending timer
    clearTimer();

    // If we have a trailing call pending, execute it
    if (argsForLastCall !== null) {
      const args = argsForLastCall;
      argsForLastCall = null;
      callFn(args);
    }
  };

  debounced.pending = () => {
    return timerId !== null || isLeadingCallPending;
  };

  return debounced;
}
