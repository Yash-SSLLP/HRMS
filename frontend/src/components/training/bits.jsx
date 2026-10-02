/**
 * Small presentational pieces shared by every Training screen. No data
 * fetching here — see trainingUtil.js for the formatting rules they apply.
 */
import { FiStar, FiFileText, FiDownload, FiX } from 'react-icons/fi';
import {
  STATUS_META, categoryHue, dateTile, fullName, initials, prettySize, fileKind, isPdfFile,
} from './trainingUtil';

/** The calendar tile on the left of a card. */
export function DateTile({ date, status, large = false }) {
  const t = dateTile(date);
  const tone = status === 'Ongoing' ? 'is-live' : status === 'Completed' ? 'is-done' : '';
  return (
    <div className={`trn-date ${tone} ${large ? 'is-lg' : ''}`} aria-hidden="true">
      <div className="trn-date-m">{t.month}</div>
      <div className="trn-date-d text-gray-900">{t.day}</div>
      <div className="trn-date-w text-gray-600">{t.weekday}</div>
    </div>
  );
}

export function StatusPill({ status }) {
  const meta = STATUS_META[status] || STATUS_META.Planned;
  return <span className={`trn-status ${meta.cls} text-gray-700`}>{meta.label}</span>;
}

export function CategoryChip({ name }) {
  if (!name) return <span className="trn-chip is-muted">Uncategorised</span>;
  return <span className="trn-chip" style={{ '--hue': categoryHue(name) }} title={name}><span className="truncate">{name}</span></span>;
}

/** Up to `max` initials circles, then "+N". */
export function AvatarStack({ people = [], max = 4 }) {
  const shown = people.slice(0, max);
  const more = people.length - shown.length;
  return (
    <span className="trn-stack">
      {shown.map((p) => (
        <span key={p._id || fullName(p)} className="trn-av" title={fullName(p)}>{initials(fullName(p))}</span>
      ))}
      {more > 0 && <span className="trn-av trn-stack-more text-gray-700">+{more}</span>}
    </span>
  );
}

/** Read-only star row: ★★★★☆ */
export function Stars({ value = 0, size = 14 }) {
  const v = Math.round(Number(value) || 0);
  return (
    <span className="trn-stars" aria-label={`${value || 0} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <FiStar key={n} size={size} className={n <= v ? '' : 'is-off'} fill={n <= v ? 'currentColor' : 'none'} />
      ))}
    </span>
  );
}

/** ★ 4.3 · 6 reviews */
export function ScoreLine({ summary, empty = 'No reviews yet' }) {
  if (!summary || !summary.count) return <span className="text-gray-500">{empty}</span>;
  return (
    <span className="trn-score text-gray-800">
      <FiStar size={13} fill="currentColor" style={{ color: '#f59e0b' }} />
      {summary.clarity ?? '—'}
      <span className="font-normal text-gray-500">· {summary.count} review{summary.count === 1 ? '' : 's'}</span>
    </span>
  );
}

/**
 * One file row. `onOpen` makes the whole row a button; `onRemove` adds an ×.
 * A file not yet uploaded (a File object) shows as dashed.
 */
export function FileRow({ file, onOpen, onRemove, pending = false, busy = false }) {
  const pdf = isPdfFile(file);
  const body = (
    <>
      <span className={`trn-file-kind ${pdf ? 'is-pdf' : ''}`}>{pdf ? 'PDF' : fileKind(file.name)}</span>
      <span className="min-w-0 flex-1">
        <span className="trn-file-name block text-gray-900">{file.name}</span>
        <span className="trn-file-sub block text-gray-600">
          {prettySize(file.size)}{pending ? ' · will upload on save' : ''}{busy ? ' · opening…' : ''}
        </span>
      </span>
    </>
  );
  if (onOpen) {
    return (
      <button type="button" className="trn-file" onClick={onOpen} disabled={busy}>
        {body}
        <FiDownload size={15} className="text-gray-500 shrink-0" />
      </button>
    );
  }
  return (
    <div className={`trn-file ${pending ? 'is-pending' : ''}`}>
      {body}
      {onRemove && (
        <button type="button" className="trn-icon-btn text-gray-500" onClick={onRemove} aria-label={`Remove ${file.name}`} title="Remove">
          <FiX size={15} />
        </button>
      )}
    </div>
  );
}

export function EmptyState({ icon: Icon = FiFileText, title, children, action }) {
  return (
    <div className="trn-empty">
      <span className="trn-empty-icon"><Icon size={24} /></span>
      <div className="text-base font-semibold text-gray-900">{title}</div>
      {children && <p className="text-sm text-gray-600 max-w-md">{children}</p>}
      {action}
    </div>
  );
}
