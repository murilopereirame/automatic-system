/** Tiny hash router: `#/runs/123` becomes `['runs', '123']`. */
import { useEffect, useState } from 'react';

function currentRoute(): string[] {
  return window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
}

export function useRoute(): string[] {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const onChange = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(path: string): void {
  window.location.hash = path;
}
