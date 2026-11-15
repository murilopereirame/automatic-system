import { useCallback, useEffect, useState } from 'react';

export interface Loaded<T> {
  data: T | undefined;
  error: string | undefined;
  reload: () => void;
}

/** Loads data when the component mounts or `key` changes, and exposes a `reload`. */
export function useLoad<T>(load: () => Promise<T>, key: unknown = ''): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    load()
      .then((value) => {
        setData(value);
        setError(undefined);
      })
      .catch((reason: Error) => setError(reason.message));
    // `load` is a new function on every render; `key` says when to really reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(reload, [reload]);
  return { data, error, reload };
}
