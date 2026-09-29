import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FiArrowLeft, FiDownload, FiMaximize2, FiRefreshCw, FiZoomIn, FiZoomOut } from 'react-icons/fi';
// ORDER IS LOAD-BEARING: the viewer components read `globalThis.pdfjsLib` at
// their top level, and it is the core library's import that sets it. The
// LEGACY build throughout — the modern one leans on Promise.withResolvers and
// friends, which the older office PCs' browsers do not have.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { EventBus, LinkTarget, PDFLinkService, PDFViewer } from 'pdfjs-dist/legacy/web/pdf_viewer.mjs';
import 'pdfjs-dist/legacy/web/pdf_viewer.css';
import './ReportViewer.css';
import api from '../api/client';
import { filenameFrom } from '../utils/download';
import { isAllowedReportSrc } from '../utils/reportView';

// THE WORKER, BUNDLED AS PLAIN JS (2026-09-29). Vite turns this exact
// `new Worker(new URL(..., import.meta.url))` shape into its own chunk with a
// .js name. Not a `?url` import of the .mjs: nginx 1.24 serves .mjs as
// application/octet-stream, and a browser refuses to run a module worker of
// that type — the viewer would sit on "Loading" for ever. One worker for the
// life of the tab; getDocument() reuses the port for every document.
if (!pdfjsLib.GlobalWorkerOptions.workerPort) {
  pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(
    new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url),
    { type: 'module' },
  );
}

/**
 * A file name safe to show and to save under: no path separators or other
 * characters a file system refuses, a sane length, and a .pdf ending.
 * @param {string} raw
 * @returns {string}
 */
function cleanName(raw) {
  const printable = [...String(raw || '')].filter((ch) => ch.charCodeAt(0) >= 32).join('');
  let name = printable.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
  if (!name) name = 'report.pdf';
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  return name;
}

/**
 * The sentence worth showing for a failed fetch. Under responseType 'blob' a
 * refusal's JSON body arrives as a Blob too, so the server's own message is
 * read back out of it (same approach as api/download.js openProtectedPdf).
 * @param {Error} err - an axios error
 * @returns {Promise<string>}
 */
async function refusalMessage(err) {
  try {
    const data = err?.response?.data;
    const text = data instanceof Blob ? await data.text() : null;
    const msg = text ? JSON.parse(text).message : '';
    if (msg) return msg;
  } catch { /* fall through to the status-based wording */ }
  const status = err?.response?.status;
  if (status === 403) return 'You do not have access to this report.';
  if (status === 404) return 'This report could not be found.';
  if (!err?.response) return 'Could not reach the server. Check your connection and try again.';
  return 'Could not build the report.';
}

/**
 * ReportViewer — route /report-view?src=<api path>&name=<file name>.
 *
 * A report PDF rendered in our own page rather than the browser's viewer, so
 * that a bill thumbnail opens in a NEW tab (Chrome and Edge follow a PDF's URI
 * link in the same tab whatever the document asks — see utils/reportView.js)
 * while the report's own jumps ("See bill 3", "Back to the entry") stay inside
 * the document.
 *
 * Opened by the cashbook pages in a tab of its own; the report is fetched here
 * with the signed-in api client, which is why `src` is held to an allow-list.
 * The fetched Blob is kept untouched for Download: getDocument({ data })
 * transfers its buffer to the worker, so the bytes handed to pdf.js are a copy.
 */
export default function ReportViewer() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const src = searchParams.get('src') || '';
  const nameParam = searchParams.get('name') || '';
  const allowed = isAllowedReportSrc(src);

  const [fileName, setFileName] = useState(() => cleanName(nameParam));
  const [phase, setPhase] = useState(allowed ? 'loading' : 'refused'); // loading | ready | error | refused
  const [error, setError] = useState('');
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [hasBlob, setHasBlob] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const containerRef = useRef(null);
  const innerRef = useRef(null);
  const viewerRef = useRef(null);
  const blobRef = useRef(null);

  // The app reserves a scrollbar gutter on <html> (index.css) so portal pages
  // never shift; here the document scrolls inside its own stage, and the
  // reserved gutter would only be an empty strip beside it. Both it and the
  // app's own title come back if this page is ever left in the same tab.
  useEffect(() => {
    const before = document.title;
    const html = document.documentElement;
    const { overflowY, scrollbarGutter } = html.style;
    html.style.overflowY = 'hidden';
    html.style.scrollbarGutter = 'auto';
    return () => {
      document.title = before;
      html.style.overflowY = overflowY;
      html.style.scrollbarGutter = scrollbarGutter;
    };
  }, []);
  // The tab's title is the document's name, as it would be in the browser's
  // own viewer — several reports open side by side stay tell-apart-able.
  useEffect(() => { document.title = fileName; }, [fileName]);

  useEffect(() => {
    if (!allowed) return undefined;
    let cancelled = false;
    const ac = new AbortController();
    let loadingTask = null;
    let viewer = null;
    let linkService = null;

    setPhase('loading');
    setError('');
    setPages(0);
    setPage(1);
    blobRef.current = null;
    setHasBlob(false);

    (async () => {
      let res;
      try {
        res = await api.get(src, { responseType: 'blob', signal: ac.signal });
      } catch (err) {
        if (cancelled) return;
        setError(await refusalMessage(err));
        setPhase('error');
        return;
      }
      if (cancelled) return;

      const blob = res.data;
      blobRef.current = blob;
      setHasBlob(true);
      // The server's own name first, exactly as the old download saved it.
      // filenameFrom decodes the header, and a stray '%' in it would throw.
      let served = nameParam;
      try { served = filenameFrom(res, nameParam); } catch { /* keep the param */ }
      setFileName(cleanName(served));

      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (cancelled) return;

        const eventBus = new EventBus();
        // External links (the bill thumbnails) open in a new tab; internal ones
        // go through goToDestination and scroll this viewer.
        // ignoreDestinationZoom: the report's jumps ("See bill N", "Back to the
        // entry") carry a whole-page /Fit, which knocked the reader out of Fit
        // width — and on a phone left the page cut off at the right. A jump
        // moves to the page; the zoom stays the reader's.
        linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK, ignoreDestinationZoom: true });
        viewer = new PDFViewer({
          container: containerRef.current,
          viewer: innerRef.current,
          eventBus,
          linkService,
          abortSignal: ac.signal,
        });
        linkService.setViewer(viewer);
        viewerRef.current = viewer;

        eventBus.on('pagesinit', () => { viewer.currentScaleValue = 'page-width'; });
        eventBus.on('pagechanging', (e) => setPage(e.pageNumber));
        eventBus.on('scalechanging', (e) => setScale(e.scale));

        // Our own document, but eval stays off anyway: nothing here needs the
        // speed, and it closes a whole class of font-program exploits.
        loadingTask = pdfjsLib.getDocument({ data: bytes, isEvalSupported: false });
        const pdf = await loadingTask.promise;
        if (cancelled) return;
        viewer.setDocument(pdf);
        linkService.setDocument(pdf, null);
        setPages(pdf.numPages);
        setPhase('ready');
      } catch (_) {
        if (cancelled) return;
        setError('This report could not be displayed here. Download it to open it in another viewer.');
        setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
      try {
        viewer?.setDocument(null);
        linkService?.setDocument(null);
      } catch { /* tearing down — nothing to report */ }
      loadingTask?.destroy();
      viewerRef.current = null;
    };
  }, [src, nameParam, allowed, attempt]);

  // "Fit width" is a mode, not a number: a window resized (or a phone turned)
  // while in it re-fits, as the browser's own viewer does.
  useEffect(() => {
    const onResize = () => {
      const v = viewerRef.current;
      if (v?.pdfDocument && v.currentScaleValue === 'page-width') v.currentScaleValue = 'page-width';
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const zoomOut = () => viewerRef.current?.decreaseScale();
  const zoomIn = () => viewerRef.current?.increaseScale();
  const fitWidth = () => {
    const v = viewerRef.current;
    if (v?.pdfDocument) v.currentScaleValue = 'page-width';
  };

  /** Save the ORIGINAL bytes the server sent, under the file's name. */
  const download = useCallback(() => {
    const blob = blobRef.current;
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Deferred so Safari has started the download before the URL goes.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [fileName]);

  // window.close() only closes a tab a script opened — which is how the
  // cashbook pages open this one. A link pasted into a tab by hand cannot be
  // closed that way, so that reader is taken back, or home.
  const close = () => {
    window.close();
    setTimeout(() => {
      if (window.closed) return;
      if (window.history.length > 1) navigate(-1);
      else navigate('/', { replace: true });
    }, 150);
  };

  const ready = phase === 'ready';
  const btn = 'inline-flex items-center justify-center gap-1.5 min-h-[40px] min-w-[40px] px-2.5 rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 text-sm disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <div className="rv-root">
      <header className="rv-toolbar bg-white border-b border-gray-200">
        {/* A real flex-basis (12rem), not flex-1's 0: with 0 the toolbar's wrap
            never triggered on a phone and Close sat under the zoom buttons. */}
        <div className="flex items-center gap-2 min-w-0 flex-[1_1_12rem]">
          <button type="button" onClick={close} className={btn} aria-label="Close" title="Close">
            <FiArrowLeft size={16} aria-hidden="true" />
            <span className="hidden sm:inline">Close</span>
          </button>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 truncate" title={fileName}>{fileName}</p>
            <p className="text-xs text-gray-500">
              {ready ? `Page ${page} of ${pages}` : phase === 'loading' ? 'Building…' : ' '}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          <button type="button" onClick={zoomOut} disabled={!ready} className={btn}
            aria-label="Zoom out" title="Zoom out">
            <FiZoomOut size={16} aria-hidden="true" />
          </button>
          <span className="text-xs text-gray-600 tabular-nums w-12 text-center" aria-live="polite">
            {ready ? `${Math.round(scale * 100)}%` : ''}
          </span>
          <button type="button" onClick={zoomIn} disabled={!ready} className={btn}
            aria-label="Zoom in" title="Zoom in">
            <FiZoomIn size={16} aria-hidden="true" />
          </button>
          <button type="button" onClick={fitWidth} disabled={!ready} className={btn}
            aria-label="Fit width" title="Fit width">
            <FiMaximize2 size={16} aria-hidden="true" />
            <span className="hidden sm:inline">Fit width</span>
          </button>
          <button type="button" onClick={download} disabled={!hasBlob}
            className="inline-flex items-center justify-center gap-1.5 min-h-[40px] px-3 rounded-lg bg-gray-900 text-white hover:bg-gray-700 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed">
            <FiDownload size={16} aria-hidden="true" />
            <span>Download</span>
          </button>
        </div>
      </header>

      <main className="rv-stage">
        {/* Always mounted: PDFViewer is built on this node once the bytes
            arrive, and insists it be absolutely positioned (rv-scroll). */}
        <div ref={containerRef} className="rv-scroll" tabIndex={0} role="region" aria-label="Report">
          <div ref={innerRef} className="pdfViewer" />
        </div>

        {phase === 'loading' && (
          <div className="rv-overlay">
            <div className="rv-spinner" aria-hidden="true" />
            <p className="text-sm font-medium text-gray-700">Building the report…</p>
            <p className="text-xs text-gray-500 max-w-xs text-center">
              A report with the bills attached can take a little while.
            </p>
          </div>
        )}

        {(phase === 'error' || phase === 'refused') && (
          <div className="rv-overlay">
            <div className="bg-white border border-gray-200 rounded-xl shadow p-5 w-full max-w-sm text-center">
              <p className="text-sm font-semibold text-gray-900">
                {phase === 'refused' ? 'This link is not a report' : 'Could not open the report'}
              </p>
              <p className="text-sm text-gray-600 mt-1">
                {phase === 'refused'
                  ? 'The viewer only opens cashbook reports. Open the report again from the cashbook page.'
                  : error}
              </p>
              <div className="flex flex-wrap justify-center gap-2 mt-4">
                {phase === 'error' && !hasBlob && (
                  <button type="button" onClick={() => setAttempt((n) => n + 1)} className={btn}>
                    <FiRefreshCw size={15} aria-hidden="true" />
                    <span>Try again</span>
                  </button>
                )}
                {/* The bytes arrived but pdf.js could not draw them — the file
                    itself may still open in another viewer. */}
                {phase === 'error' && hasBlob && (
                  <button type="button" onClick={download} className={btn}>
                    <FiDownload size={15} aria-hidden="true" />
                    <span>Download</span>
                  </button>
                )}
                <button type="button" onClick={close} className={btn}>Close</button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
