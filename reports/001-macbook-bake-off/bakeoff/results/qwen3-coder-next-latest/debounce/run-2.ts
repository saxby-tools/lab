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
  // Validate waitMs
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new RangeError("waitMs must be a finite non-negative number");
  }

  const leading = options?.leading ?? false;
  const trailing = options?.trailing ?? true;

  let timerId: number | null = null;
  let lastArgs: A | null = null;
  let lastCallTime = 0;
  let isLeadingCallPending = false;

  // Helper function to clear the timer
  const clearTimer = () => {
    if (timerId !== null) {
      clearTimeout(timerId as number);
      timerId = null;
    }
  };

  // The function to call after the wait period
  const invokeFunc = (args: A) => {
    // Save the current time before calling the function
    lastCallTime = Date.now();
    try {
      fn(...args);
    } finally {
      // Reset state after invocation
      if (isLeadingCallPending) {
        isLeadingCallPending = false;
      }
    }
  };

  // Timer callback
  const timerExpired = () => {
    // There might be pending trailing args
    if (lastArgs !== null) {
      invokeFunc(lastArgs);
      lastArgs = null;
    }
    clearTimer();
  };

  // Main debounced function
  const debounced = ((...args: A) => {
    const isLeadingEnabled = leading;
    const isTrailingEnabled = trailing;

    // Check if we're in a burst (timer is active)
    const inBurst = timerId !== null;

    // Update last args
    lastArgs = args;

    if (!inBurst) {
      // Start of a new burst
      
      // Handle leading edge if enabled and we're not just about to do trailing only
      if (isLeadingEnabled) {
        // If we're not in a burst and leading is enabled, we invoke immediately
        isLeadingCallPending = false;
        // Record call time
        lastCallTime = Date.now();
        try {
          fn(...args);
        } finally {
          // Reset state only if this is the only call in the burst
          if (!isTrailingEnabled) {
            lastArgs = null;
            return;
          }
        }
      }

      // Set timer for trailing if enabled
      if (isTrailingEnabled) {
        timerId = setTimeout(timerExpired, waitMs);
      }
    } else {
      // During an ongoing burst: just restart timer
      if (timerId !== null) {
        clearTimeout(timerId as number);
        timerId = setTimeout(timerExpired, waitMs);
      }
      
      // If we get a call during a burst and leading is enabled, 
      // we only want the first call to trigger the leading execution,
      // so we set a flag to prevent subsequent leading calls during the same burst.
      if (isLeadingEnabled) {
        isLeadingCallPending = true;
      }
    }
  }) as Debounced<A>;

  // Cancel method: clear timer and drop pending arguments
  debounced.cancel = () => {
    clearTimer();
    lastArgs = null;
  };

  // Flush method: execute immediately if there's a pending call
  debounced.flush = () => {
    // If no burst is active, do nothing
    if (timerId === null) return;

    // Get the stored args
    const argsToCall = lastArgs;
    clearTimer();
    
    // Reset state
    lastArgs = null;

    // If there were args to call, invoke now
    if (argsToCall !== null) {
      invokeFunc(argsToCall);
    }
  };

  // Pending method: returns true if timer is active
  debounced.pending = () => timerId !== null;

  return debounced;
}
