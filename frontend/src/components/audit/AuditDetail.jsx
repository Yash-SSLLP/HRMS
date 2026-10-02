/**
 * AuditDetail — the Details drawer of one Audit Log entry (GET /audit/:id).
 *
 * Answers "what is this log?" in full: the entry as one sentence, the change
 * as Before → After, who made it and when, the RECORD it points at (the server
 * finds it by id wherever it lives — even when the row was written by another
 * app under a name this portal does not use — and lists its fields without
 * anything sensitive), and every change ever logged for that record.
 *
 * The list row is shown as a preview while the details load, so the drawer
 * never opens empty.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  FiX, FiArrowRight, FiExternalLink, FiTrash2, FiClock, FiAlertTriangle, FiInfo, FiCpu,
} from 'react-icons/fi';
import api from '../../api/client';
import {
  fullStamp, ago, initials, roleHue, roleText, moduleHue,
} from './auditUtil';

/** The tone-coded badge an entry is listed with ("Approved", "Edited", "Deleted"). */
export function Badge({ badge }) {
  if (!badge) return null;
  return (
    <span className={`aud-badge is-${badge.tone || 'neutral'}`} title={badge.created ? `New record, started as ${badge.text}` : badge.text}>
      {badge.created && <span className="aud-new">New</span>}
      <span className="truncate">{badge.text}</span>
    </span>
  );
}

/** Module name in its steady colour; marked when another app wrote the row. */
export function ModuleChip({ label, otherApp = false }) {
  return (
    <span className="aud-module" style={{ '--hue': otherApp ? '#64748b' : moduleHue(label) }} title={otherApp ? `${label} — written by another app` : label}>
      <span className="truncate">{label || 'Record'}</span>
      {otherApp && <span className="aud-module-tag">other app</span>}
    </span>
  );
}

/** Initials in the role's colour; a chip icon for the system. */
export function ActorAvatar({ name, role, large = false }) {
  return (
    <span className={`aud-av ${large ? 'is-lg' : ''}`} style={{ '--hue': name ? roleHue(role) : '#64748b' }} aria-hidden="true">
      {name ? initials(name) : <FiCpu size={large ? 18 : 14} />}
    </span>
  );
}

/**
 * The sentence with the actor's name in bold, when it leads. A server without
 * `summary` (deployed behind this page) still gets the old one-liner.
 */
export function Sentence({ entry }) {
  const s = entry?.summary
    || `${entry?.byName || 'System'} · ${entry?.field || 'status'}: ${entry?.fromStatus ? `${entry.fromStatus} → ` : 'created as '}${entry?.toStatus || '—'}`;
  const who = entry?.byName || '';
  if (who && s.startsWith(who)) return <><b className="text-gray-900">{who}</b>{s.slice(who.length)}</>;
  return s;
}

/** Written by another app: the server says the module is not this portal's and found no record type for it. */
export const isOtherApp = (e) => !!e && e.moduleKnown === false && !e.resolvedType;

function BeforeAfter({ entry }) {
  const badge = entry.badge || { created: !entry.fromStatus, tone: 'neutral' };
  const from = entry.fromText ?? entry.fromStatus ?? '';
  const to = entry.toText ?? entry.toStatus ?? '';
  // A reschedule logs the same status on both sides — the sentence says it all.
  if (!badge.created && from && from === to) return null;
  return (
    <div className="aud-ba" aria-label="What changed">
      <div className="aud-ba-box">
        <div className="aud-ba-k text-gray-600">Before</div>
        <div className={`aud-ba-v ${from ? 'text-gray-700' : 'text-gray-500 font-medium'}`}>
          {badge.created ? 'Nothing yet — a new record' : from || 'Empty'}
        </div>
      </div>
      <span className="aud-ba-arrow text-gray-500"><FiArrowRight size={18} /></span>
      <div className={`aud-ba-box is-after is-${badge.tone || 'neutral'}`}>
        <div className="aud-ba-k text-gray-600">After</div>
        <div className="aud-ba-v">{badge.text === 'Deleted' ? 'Deleted' : to || 'Empty'}</div>
      </div>
    </div>
  );
}

export default function AuditDetail({ entryId, preview, onClose, onDelete, deleting = false }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setData(null);
    setError('');
    api.get(`/audit/${entryId}`)
      .then(({ data: d }) => { if (live) setData(d); })
      .catch((err) => { if (live) setError(err.response?.data?.message || 'Could not load this entry'); });
    return () => { live = false; };
  }, [entryId]);

  const e = data?.entry || preview;
  const mod = data?.module;
  const record = data?.record;
  const history = data?.history || [];
  const otherApp = isOtherApp(e);

  return (
    <div className="fixed inset-0 trn-drawer-wrap" onMouseDown={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}>
      <aside className="trn-drawer aud-drawer" role="dialog" aria-modal="true" aria-label="Audit entry details">
        <div className="trn-drawer-head">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                {e && <ModuleChip label={e.moduleLabel || e.entity} otherApp={otherApp} />}
                {e && <Badge badge={e.badge} />}
              </div>
              <h2 className="aud-hero-sentence text-gray-800">{e ? <Sentence entry={e} /> : 'Loading…'}</h2>
              {e && (
                <div className="trn-meta text-gray-600">
                  <span><FiClock size={13} />{fullStamp(e.at)}</span>
                  <span className="text-gray-500">{ago(e.at)}</span>
                </div>
              )}
            </div>
            <button type="button" className="trn-icon-btn text-gray-500" onClick={onClose} aria-label="Close" data-modal-close><FiX size={18} /></button>
          </div>
        </div>

        <div className="trn-drawer-body">
          {error && <div className="trn-note is-warn text-gray-700 mb-3"><FiAlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</div>}

          {e && (
            <section className="aud-sec">
              <div className="trn-label text-gray-600">What changed · {e.fieldLabel || 'Status'}</div>
              <BeforeAfter entry={e} />
            </section>
          )}

          {e && (
            <section className="aud-sec">
              <dl className="trn-facts">
                <div className="trn-fact">
                  <dt className="text-gray-600">Changed by</dt>
                  <dd className="text-gray-800">
                    <ActorAvatar name={e.byName} role={e.byRole} />
                    <span className="font-semibold">{e.byName || 'The system'}</span>
                    {e.byName ? (
                      <span className="aud-role" style={{ '--hue': roleHue(e.byRole) }}>{roleText(e.byRole)}</span>
                    ) : <span className="text-gray-500">an automatic job, not a person</span>}
                    {data?.actor && !data.actor.active && <span className="trn-tag is-amber">Account switched off</span>}
                  </dd>
                </div>
                <div className="trn-fact">
                  <dt className="text-gray-600">When</dt>
                  <dd className="text-gray-800">{fullStamp(e.at)}</dd>
                </div>
                <div className="trn-fact">
                  <dt className="text-gray-600">Module</dt>
                  <dd className="text-gray-800">
                    <ModuleChip label={e.moduleLabel || e.entity} otherApp={otherApp} />
                    {/* The raw name stays visible: it is what older screens and exports show. */}
                    {mod && mod.loggedAs && mod.loggedAs !== e.moduleLabel && (
                      <span className="text-xs text-gray-500">logged as “{mod.loggedAs}”</span>
                    )}
                  </dd>
                </div>
                <div className="trn-fact">
                  <dt className="text-gray-600">Record</dt>
                  <dd className="text-gray-800 break-words">{e.entityLabel || <span className="text-gray-500">No name was recorded</span>}</dd>
                </div>
              </dl>
              {mod?.about && (
                <div className="trn-note text-gray-700 mt-3">
                  <FiInfo size={14} className="mt-0.5 shrink-0" />
                  <span><b>What is this?</b> {mod.about}</span>
                </div>
              )}
            </section>
          )}

          <section className="aud-sec">
            <div className="trn-label text-gray-600">The record today</div>
            {!data && !error && (
              <div className="aud-fields">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-14 rounded-xl" />)}</div>
            )}
            {record && !record.found && (
              <div className="trn-note text-gray-700">
                <FiInfo size={14} className="mt-0.5 shrink-0" />
                <span>
                  {e?.entityId
                    ? 'This record no longer exists — it was deleted after this change was logged. The entry stays as the trail of what happened to it.'
                    : 'This entry does not point at a single record.'}
                </span>
              </div>
            )}
            {record?.found && (
              <>
                {(record.otherApp || (e?.resolvedType && record.typeNoun)) && (
                  <div className="trn-note text-gray-700 mb-3">
                    <FiInfo size={14} className="mt-0.5 shrink-0" />
                    <span>
                      {record.otherApp
                        ? <>This record is kept in the “{record.collection}” collection, which this portal does not manage — the entry was written by another app that shares this database (such as the separate Tasks or Cashbook app).</>
                        : <>Logged as “{mod?.loggedAs}”, but the record it points at is {/^[aeiou]/i.test(record.typeNoun) ? 'an' : 'a'} <b>{record.typeNoun}</b> ({record.typeLabel}) — so it is described as one here.</>}
                    </span>
                  </div>
                )}
                {record.fields.length ? (
                  <div className="aud-fields">
                    {record.fields.map((f) => (
                      <div key={f.label} className="aud-field">
                        <div className="aud-field-k text-gray-600">{f.label}</div>
                        <div className="aud-field-v text-gray-800">{f.value}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">Its details are private (pay, identity or bank fields), so none are shown.</p>
                )}
              </>
            )}
          </section>

          {data && (
            <section className="aud-sec">
              <div className="trn-label text-gray-600">History of this record · {history.length} {history.length === 1 ? 'change' : 'changes'}</div>
              {history.length <= 1 && <p className="text-xs text-gray-500 mb-2">This is the only change logged for this record.</p>}
              <ol className="aud-tl">
                {history.map((h) => (
                  <li key={h._id} className={`aud-tl-item is-${h.badge?.tone || 'neutral'} ${h.current ? 'is-current' : ''}`}>
                    <span className="aud-tl-dot" aria-hidden="true" />
                    <div className="aud-tl-body">
                      <div className="aud-tl-text text-gray-800"><Sentence entry={h} /></div>
                      <div className="aud-tl-when text-gray-500">
                        {fullStamp(h.at)}
                        {h.current && <span className="aud-tl-this">This entry</span>}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>

        <div className="trn-drawer-foot">
          {onDelete && (
            <button type="button" className="trn-btn is-danger mr-auto" onClick={() => onDelete(entryId)} disabled={deleting}>
              <FiTrash2 size={14} /> Delete entry
            </button>
          )}
          {mod?.link && (
            <Link to={mod.link} className="trn-btn" onClick={onClose}>
              <FiExternalLink size={14} /> Open {e?.moduleLabel || 'page'}
            </Link>
          )}
          <button type="button" className="trn-btn is-primary accent-bg on-accent" onClick={onClose}>Done</button>
        </div>
      </aside>
    </div>
  );
}
