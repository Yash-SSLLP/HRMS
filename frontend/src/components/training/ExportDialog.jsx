/**
 * Download one month's training report (Excel): every session with its time
 * taken, trainer, participants, attendance and ratings; a sheet per person per
 * session; and a summary by category and trainer. Built on the server
 * (GET /training/export?month=YYYY-MM) so it carries the company wall and the
 * names of people the browser was never sent.
 */
import { useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { FiX, FiDownload, FiFileText } from 'react-icons/fi';
import { downloadFile } from '../../api/download';
import { monthKey, monthLabel, durationText } from './trainingUtil';

export default function ExportDialog({ trainings = [], onClose }) {
  const [month, setMonth] = useState(monthKey(new Date()));
  const [busy, setBusy] = useState(false);

  // The months that actually had trainings, newest first — one tap each.
  const recent = useMemo(() => {
    const keys = new Set([monthKey(new Date())]);
    trainings.forEach((t) => { if (t.startDate) keys.add(monthKey(t.startDate)); });
    return [...keys].sort().reverse().slice(0, 8);
  }, [trainings]);

  const preview = useMemo(() => {
    const inMonth = trainings.filter((t) => t.startDate && monthKey(t.startDate) === month);
    const held = inMonth.filter((t) => t.status !== 'Cancelled');
    return {
      sessions: held.length,
      cancelled: inMonth.length - held.length,
      minutes: held.reduce((s, t) => s + (t.durationMinutes || 0), 0),
      seats: held.reduce((s, t) => s + (t.participantCount || 0), 0),
    };
  }, [trainings, month]);

  const go = async () => {
    setBusy(true);
    try {
      await downloadFile(`/training/export?month=${month}`, `Training_${month}.xlsx`);
      toast.success('Report downloaded');
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not download the report');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 trn-modal-wrap" role="dialog" aria-modal="true" aria-label="Export training report">
      <div className="trn-modal trn-card-base flex flex-col" style={{ maxWidth: '30rem' }}>
        <div className="trn-modal-head">
          <span className="trn-kpi-icon" style={{ '--kpi-hue': '#16a34a' }}><FiFileText size={18} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-lg font-bold text-gray-900">Monthly training report</div>
            <div className="text-xs text-gray-600">Excel · sessions, time taken, trainer, participants, attendance and reviews.</div>
          </div>
          <button type="button" className="trn-icon-btn text-gray-500" onClick={onClose} aria-label="Close" data-modal-close><FiX size={18} /></button>
        </div>
        <div className="trn-modal-body overflow-y-auto">
          <div className="pt-3">
            <label className="trn-field-label text-gray-700" htmlFor="trn-month">Month</label>
            <input id="trn-month" type="month" className="trn-input text-gray-900" value={month} onChange={(e) => setMonth(e.target.value)} max={monthKey(new Date(Date.now() + 365 * 864e5))} />
            <div className="trn-quick">
              {recent.map((k) => (
                <button key={k} type="button" className={k === month ? 'is-on' : ''} onClick={() => setMonth(k)}>{monthLabel(k)}</button>
              ))}
            </div>
          </div>
          <div className="trn-kpis mt-4" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
            <div className="trn-kpi" style={{ padding: '0.7rem' }}><div className="min-w-0"><div className="trn-kpi-value text-gray-900">{preview.sessions}</div><div className="trn-kpi-label text-gray-600">Sessions</div></div></div>
            <div className="trn-kpi" style={{ padding: '0.7rem' }}><div className="min-w-0"><div className="trn-kpi-value text-gray-900">{durationText(preview.minutes) || '0m'}</div><div className="trn-kpi-label text-gray-600">Time</div></div></div>
            <div className="trn-kpi" style={{ padding: '0.7rem' }}><div className="min-w-0"><div className="trn-kpi-value text-gray-900">{preview.seats}</div><div className="trn-kpi-label text-gray-600">Seats</div></div></div>
          </div>
          <p className="text-xs text-gray-500 mt-3">
            {monthLabel(month)}{preview.cancelled ? ` · ${preview.cancelled} cancelled (listed, not counted)` : ''}. Three sheets: Summary, Trainings, Participants.
          </p>
        </div>
        <div className="trn-modal-foot">
          <button type="button" className="trn-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="trn-btn is-primary accent-bg on-accent" onClick={go} disabled={busy || !month}>
            <FiDownload size={14} /> {busy ? 'Preparing…' : 'Download Excel'}
          </button>
        </div>
      </div>
    </div>
  );
}
