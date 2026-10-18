// Coalesce bursts, serialize requests, and retain one refresh requested mid-flight.
export function createRefreshQueue(refresh: () => Promise<void>, delay = 500) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let pending = false;
  let disposed = false;
  const trigger = () => {
    if (disposed) return;
    pending = true;
    if (running || timer) return;
    timer = setTimeout(async () => {
      timer = undefined;
      pending = false;
      running = true;
      try {
        await refresh();
      } finally {
        running = false;
        if (pending) trigger();
      }
    }, delay);
  };
  return {
    trigger,
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
