import { useRef, useState } from 'react';

type Runner = (label: string, action: () => Promise<void>) => Promise<void>;

/** Local duplicate-click protection, not a Runtime permission or global busy lock.
 * A long task.run must never disable the Attention needed to unblock that very task.
 */
export function usePendingAction(report: Runner) {
  const locks = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const run = async (key: string, label: string, action: () => Promise<void>): Promise<void> => {
    if (locks.current.has(key)) return;
    locks.current.add(key);
    setPending(new Set(locks.current));
    try { await report(label, action); }
    finally {
      locks.current.delete(key);
      setPending(new Set(locks.current));
    }
  };
  return { run, pending };
}
