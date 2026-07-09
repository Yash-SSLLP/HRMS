import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { FiAlertTriangle, FiHelpCircle, FiInfo } from 'react-icons/fi';

// A premium, minimal in-app replacement for window.confirm / window.prompt /
// window.alert. Promise-based and imperative so call sites stay tiny:
//
//   if (!(await confirmDialog({ message: 'Delete this?' }))) return;
//   const note = await promptDialog({ message: 'Reason (optional):' }); // string | null
//   await alertDialog({ message: 'Saved.' });
//
// A single <DialogHost /> (mounted once in App) renders whatever is requested.

let resolver = null;

const useDialogStore = create((set) => ({
  req: null,
  _set: (req) => set({ req }),
}));

function ask(req) {
  // Only one dialog at a time — resolve any in-flight one as cancelled first.
  if (resolver) {
    const prev = resolver;
    resolver = null;
    prev(req.type === 'prompt' ? null : false);
  }
  return new Promise((resolve) => {
    resolver = resolve;
    useDialogStore.getState()._set(req);
  });
}

function settle(value) {
  const r = resolver;
  resolver = null;
  useDialogStore.getState()._set(null);
  if (r) r(value);
}

/** Confirm dialog → resolves true (confirmed) or false (cancelled). */
export function confirmDialog(opts = {}) { return ask({ type: 'confirm', ...opts }); }
/** Prompt dialog → resolves the entered string, or null if cancelled. */
export function promptDialog(opts = {}) { return ask({ type: 'prompt', ...opts }); }
/** Alert dialog → resolves once acknowledged. */
export function alertDialog(opts = {}) { return ask({ type: 'alert', ...opts }); }

export function DialogHost() {
  const req = useDialogStore((s) => s.req);
  const [value, setValue] = useState('');
  const inputRef = useRef(null);
  const okRef = useRef(null);

  useEffect(() => {
    if (!req) return undefined;
    setValue(req.initialValue || '');
    const t = setTimeout(() => {
      if (req.type === 'prompt') inputRef.current?.focus();
      else okRef.current?.focus();
    }, 30);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); settle(req.type === 'prompt' ? null : false); }
    };
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); document.removeEventListener('keydown', onKey); };
  }, [req]);

  if (!req) return null;

  const {
    type, title, message, details, tone = 'default',
    confirmText, cancelText = 'Cancel', placeholder, inputLabel,
  } = req;
  const isDanger = tone === 'danger';
  const isPrompt = type === 'prompt';
  const isAlert = type === 'alert';

  const cancel = () => settle(isPrompt ? null : false);
  const ok = () => settle(isPrompt ? (value ?? '') : true);

  const Icon = isDanger ? FiAlertTriangle : isAlert ? FiInfo : FiHelpCircle;
  const defaultTitle = isAlert ? 'Notice' : isPrompt ? 'Enter a value' : 'Are you sure?';
  const confirmLabel = confirmText || (isDanger ? 'Delete' : isAlert ? 'OK' : 'Confirm');

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center px-4 bg-black/40 backdrop-blur-sm"
      onMouseDown={cancel}>
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-2xl overflow-hidden"
        role="dialog" aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="p-5">
          <div className="flex items-start gap-3">
            <span className={`shrink-0 grid place-items-center w-10 h-10 rounded-full ${isDanger ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-gray-600'}`}>
              <Icon size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-gray-900">{title || defaultTitle}</h2>
              {message && <p className="mt-1 text-sm text-gray-600 whitespace-pre-line break-words">{message}</p>}
              {Array.isArray(details) && details.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {details.map((d, i) => (
                    <li key={i} className="text-sm text-gray-600 flex gap-2">
                      <span className="text-gray-300">•</span><span className="break-words">{d}</span>
                    </li>
                  ))}
                </ul>
              )}
              {isPrompt && (
                <div className="mt-3">
                  {inputLabel && <label className="block text-xs font-medium text-gray-500 mb-1">{inputLabel}</label>}
                  <input
                    ref={inputRef}
                    value={value}
                    placeholder={placeholder || ''}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } }}
                    className="block w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-300"
                  />
                </div>
              )}
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            {!isAlert && (
              <button type="button" onClick={cancel}
                className="px-4 py-2 text-sm rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50">
                {cancelText}
              </button>
            )}
            <button ref={okRef} type="button" onClick={ok}
              className={`px-4 py-2 text-sm rounded-lg font-medium text-white shadow-sm ${isDanger ? 'bg-red-600 hover:bg-red-700' : 'bg-gray-900 hover:bg-gray-800'}`}>
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
