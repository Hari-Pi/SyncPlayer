import { useCallback, useRef, useState } from "react";

export function useCopyFeedback(duration = 2000) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copyWithFeedback = useCallback(
    (key: string, value: string) => {
      if (!value) return;

      void navigator.clipboard?.writeText(value);

      setCopiedKey(key);

      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }

      timerRef.current = setTimeout(() => {
        setCopiedKey(null);
        timerRef.current = null;
      }, duration);
    },
    [duration]
  );

  const isCopied = useCallback(
    (key: string) => copiedKey === key,
    [copiedKey]
  );

  return { copyWithFeedback, isCopied };
}