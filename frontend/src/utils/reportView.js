/**
 * Opening a report PDF in our own viewer tab (pages/ReportViewer.jsx).
 *
 * WHY A VIEWER OF OUR OWN (2026-09-29). A cashbook report prints every bill as
 * a thumbnail that links to the full-size photo, and the ask was that clicking
 * one opens a NEW tab. A PDF cannot make that happen in Chrome or Edge: their
 * built-in viewer follows a URI link in the SAME tab whatever the document
 * says, so the reader lost their place in a forty-page report on every bill.
 * Rendered with pdf.js instead, we decide: internal links ("See bill 3", "Back
 * to the entry") still jump inside the document, external ones open a new tab.
 *
 * WHY AN ALLOW-LIST. The viewer fetches `src` with the signed-in api client, so
 * the bearer token rides on that request. A viewer that fetched any `src` it was
 * handed would be a link anyone could craft to send a reader's token somewhere
 * else — so it accepts exactly the report endpoints below and nothing more:
 * no scheme, no `//`, no other path, and a query string made only of the
 * characters URLSearchParams itself writes.
 */

// Path, then an optional query string in URLSearchParams' own alphabet
// (letters, digits, `*-._`, `%XX` escapes, `+` for a space, `=` and `&`).
const QUERY = '(?:\\?[A-Za-z0-9*\\-._%+=&]*)?';
const REPORT_SRC_ALLOW = [
  new RegExp(`^/khata/me/statement\\.pdf${QUERY}$`),
  new RegExp(`^/khata/employees/[0-9a-fA-F]{24}/statement\\.pdf${QUERY}$`),
];

/**
 * Is this one of the report endpoints the viewer may fetch with the reader's
 * token? Anything else is refused before a request is made.
 * @param {string} src - an API path relative to the api base, e.g.
 *   `/khata/me/statement.pdf?report=entries&bills=1`
 * @returns {boolean}
 */
export function isAllowedReportSrc(src) {
  if (typeof src !== 'string' || !src || src.length > 2000) return false;
  // Belt and braces over the patterns: nothing that could read as a scheme,
  // a protocol-relative URL or a Windows-style path gets through.
  if (src.includes('//') || src.includes('\\') || src.includes(':')) return false;
  return REPORT_SRC_ALLOW.some((re) => re.test(src));
}

/**
 * Open a report in the viewer tab.
 *
 * MUST be called synchronously inside the click (or submit) handler, before
 * any `await` — a window.open after one has lost the user's gesture and the
 * popup blocker stops it. The report itself is built in the new tab.
 * @param {string} path - the report endpoint, e.g. `/khata/me/statement.pdf`
 * @param {object} params - the same query params the download sends
 * @param {string} [name] - file name to show and to save under, until the
 *   server's own Content-Disposition name arrives
 * @returns {boolean} false when the tab could not be opened (a popup blocker,
 *   or a src the viewer would refuse) — the caller then downloads as before
 */
export function openReportViewer(path, params, name) {
  const qs = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null) qs.append(k, String(v));
  });
  const query = qs.toString();
  const src = query ? `${path}?${query}` : path;
  if (!isAllowedReportSrc(src)) return false;
  const view = new URLSearchParams({ src, ...(name ? { name } : {}) });
  let tab = null;
  try {
    tab = window.open(`/report-view?${view.toString()}`, '_blank');
  } catch {
    tab = null;
  }
  return Boolean(tab);
}
