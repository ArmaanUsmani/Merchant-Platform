import { useCallback, useEffect, useRef, useState } from 'react';

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch('/api' + path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? 'Something went wrong.');
  return data as T;
}

/** Loads something now, then again every few seconds, so the page stays up to date by itself. */
export function useLive<T>(load: () => Promise<T>, everyMs: number, deps: unknown[] = []) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const loadRef = useRef(load);
  loadRef.current = load;
  const refresh = useCallback(async () => {
    try { setData(await loadRef.current()); setError(''); } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, everyMs);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, everyMs, ...deps]);
  return { data, error, refresh };
}
