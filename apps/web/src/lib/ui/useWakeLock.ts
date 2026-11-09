import { useEffect } from "react";

/**
 * Keeps the screen awake while `active` (e.g. during a long file transfer): phones pause a tab
 * whose screen locks, which stalls the transfer. Browsers drop the lock whenever the tab is
 * hidden, so it is requested again when the tab comes back. Silently does nothing where the
 * Screen Wake Lock API is missing or refused.
 */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (cancelled || document.visibilityState !== "visible" || sentinel) return;
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (cancelled) {
          void lock.release();
          return;
        }
        sentinel = lock;
        lock.addEventListener("release", () => { if (sentinel === lock) sentinel = null; });
      } catch { /* refused (low battery, permissions): the transfer still works */ }
    };

    const onVisibility = () => void acquire();
    document.addEventListener("visibilitychange", onVisibility);
    void acquire();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release();
      sentinel = null;
    };
  }, [active]);
}
