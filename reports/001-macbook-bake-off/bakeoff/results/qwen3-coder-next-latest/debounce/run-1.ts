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
    throw new RangeError('waitMs must be a non-negative finite number');
  }

  const leading = options.leading ?? false;
  const trailing = options.trailing ?? true;

  let timerId: number | null = null;
  let lastArgs: A | null = null;
  let lastThis: ThisParameterType<typeof fn> | null = null;
  let hasLeadingCalled = false;

  const clearTimer = () => {
    if (timerId !== null) {
      // Use global setTimeout/clearTimeout as required
      clearTimeout(timerId as number);
      timerId = null;
    }
  };

  const callTrailing = () => {
    // Clear the timer to indicate we're no longer waiting
    clearTimer();
    
    // If we have stored args, call fn with them
    if (lastArgs !== null) {
      const argsToCall = lastArgs;
      const thisToCall = lastThis;
      lastArgs = null;
      lastThis = null;
      
      fn.apply(thisToCall, argsToCall);
    }
    
    hasLeadingCalled = false;
  };

  const debounced: Debounced<A> = (...args: A) => {
    // Update stored args for potential trailing call
    lastArgs = args;
    lastThis = this;
    
    // If timer is already active
    if (timerId !== null) {
      // If this is the only call in the burst, restart the timer
      // We don't need to do anything special if trailing is false,
      // since we'll just be waiting for nothing to happen
      if (timerId !== null) {
        clearTimeout(timerId as number);
      }
      timerId = setTimeout(() => callTrailing(), waitMs);
      return;
    }
    
    // No timer active: start a new burst
    if (leading) {
      // Leading call happens immediately
      fn.apply(this, args);
      hasLeadingCalled = true;
      
      // Set up the timer for trailing call if needed
      if (trailing) {
        timerId = setTimeout(() => callTrailing(), waitMs);
      }
    } else {
      // No leading, so start timer for trailing call
      if (trailing) {
        timerId = setTimeout(() => callTrailing(), waitMs);
      }
      // If neither leading nor trailing, no need to do anything
    }
  };

  debounced.cancel = () => {
    clearTimer();
    lastArgs = null;
    lastThis = null;
    hasLeadingCalled = false;
  };

  debounced.flush = () => {
    // If no timer, there's nothing to flush
    if (timerId === null) {
      return;
    }

    clearTimer();
    // Call trailing if trailing is true and there are stored args
    // (and skip if this was only the leading call)
    if (trailing && lastArgs !== null) {
      const argsToCall = lastArgs;
      const thisToCall = lastThis;
      lastArgs = null;
      lastThis = null;
      
      fn.apply(thisToCall, argsToCall);
    }
    
    hasLeadingCalled = false;
  };

  debounced.pending = () => timerId !== null;

  return debounced;
}
