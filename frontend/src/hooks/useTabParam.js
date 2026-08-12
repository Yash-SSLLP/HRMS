// Keeps a page's active tab in the URL as ?tab=<id>.
//
// Two things depend on this. Global search indexes tabs as well as pages, so
// "approval setup" has to be able to land you ON that tab rather than merely on
// the page that contains it. And a tab becomes linkable and survives a reload,
// which plain useState never did.
//
// Drop-in for useState: `const [tab, setTab] = useTabParam('requests', IDS)`.
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * @param {string} fallback - tab id to use when the URL names none (or an unknown one)
 * @param {string[]} [valid] - the page's tab ids; an unrecognised ?tab= falls back
 *   rather than rendering an empty page, so a stale or hand-edited link stays usable
 * @returns {[string, (id: string) => void]}
 */
export function useTabParam(fallback, valid) {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');

  const tab = useMemo(() => {
    if (!raw) return fallback;
    if (Array.isArray(valid) && valid.length && !valid.includes(raw)) return fallback;
    return raw;
  }, [raw, fallback, valid]);

  const setTab = useCallback(
    (id) => {
      const next = new URLSearchParams(params);
      // The default tab leaves the URL clean rather than pinning ?tab=requests.
      if (!id || id === fallback) next.delete('tab');
      else next.set('tab', id);
      // replace: switching tabs shouldn't stack history entries, so Back still
      // leaves the page instead of walking through every tab you touched.
      setParams(next, { replace: true });
    },
    [params, setParams, fallback]
  );

  return [tab, setTab];
}

export default useTabParam;
