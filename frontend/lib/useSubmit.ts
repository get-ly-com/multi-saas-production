import { useCallback, useRef, useState } from 'react';

// Runs one save at a time, so a double click or a held Enter key cannot post twice.
// The ref blocks a second call at once; the state is there to disable the button.
export default function useSubmit() {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async <T>(task: () => Promise<T>): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    setBusy(true);
    try {
      return await task();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);

  return { busy, run };
}
