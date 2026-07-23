import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// A styled, in-app replacement for window.prompt — a small modal with a labeled
// input, Add/Cancel, inline error and busy state. onSubmit(value) may throw
// (its message is shown inline) or resolve; on success the dialog closes.
export default function PromptDialog({
  title,
  label,
  placeholder = '',
  submitLabel = 'Add',
  initialValue = '',
  onSubmit,
  onClose,
}) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const submit = async (e) => {
    e.preventDefault();
    // This dialog is often opened from inside another <form> (e.g. the Edit
    // Employee form). Stop the submit from bubbling to that outer form, which
    // would otherwise save/close it instead of adding here.
    e.stopPropagation();
    const v = value.trim();
    if (!v) { setError('Please enter a value.'); return; }
    setBusy(true); setError('');
    try {
      await onSubmit(v);
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-[60]" onMouseDown={() => !busy && onClose()}>
      <div className="bg-white rounded-xl shadow-lg w-full max-w-sm p-6" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>
        <form onSubmit={submit}>
          {label && <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>}
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            className="block w-full border rounded-lg px-3 py-2 text-sm"
          />
          {error && <div className="mt-2 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
          <div className="flex justify-end gap-2 mt-4">
            <button type="button" onClick={onClose} disabled={busy} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50 disabled:opacity-60">Cancel</button>
            <button type="submit" disabled={busy} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
              {busy ? 'Saving…' : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
