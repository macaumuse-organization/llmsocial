import { useEffect, useState } from 'react';

export interface Route {
  page: string;
  param: string;
}

function parse(): Route {
  const [page = 'inbox', param = ''] = window.location.hash.replace(/^#\/?/, '').split('/');
  try { return { page: page || 'inbox', param: decodeURIComponent(param) }; }
  catch { return { page: 'inbox', param: '' }; }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(page: string, param?: string): void {
  window.location.hash = `#/${page}${param ? `/${encodeURIComponent(param)}` : ''}`;
}
