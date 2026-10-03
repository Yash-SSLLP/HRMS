/**
 * One training, in full — the side panel the admin page opens on a card.
 *
 *   Overview      when, category, trainer, the meeting link, what it covers,
 *                 the files
 *   Participants  everyone on it, with who joined (and when) and who reviewed
 *   Reviews       how clear it was: the average, the spread, every comment
 *
 * The footer carries the actions that change it, for whoever may: edit, mark
 * completed (while live), cancel / restore, delete.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiX, FiCalendar, FiVideo, FiCopy, FiExternalLink, FiCheckCircle, FiSlash, FiRotateCcw,
  FiTrash2, FiEdit2, FiUsers, FiStar, FiMessageSquare, FiClock,
} from 'react-icons/fi';
import api from '../../api/client';
import { confirmDialog } from '../dialogs';
import { formatDateTime12 } from '../../utils/time';
import {
  StatusPill, CategoryChip, Stars, FileRow, EmptyState,
} from './bits';
import {
  fullName, initials, longDate, timeRange, durationText, RATING_WORDS,
} from './trainingUtil';
import { openTrainingFile } from './fileOpen';

function Fact({ label, children }) {
  return (
    <div className="trn-fact">
      <dt className="text-gray-600">{label}</dt>
      <dd className="text-gray-900">{children}</dd>
    </div>
  );
}

export default function TrainingDetail({ id, writable, meetAvailable, onClose, onEdit, onChanged }) {
  const [t, setT] = useState(null);
  const [tab, setTab] = useState('overview');
  const [busy, setBusy] = useState('');
  const [opening, setOpening] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const { data } = await api.get(`/training/${id}`);
      setT(data.training);
      setError('');
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load this training');
    }
  };
  useEffect(() => { setT(null); setTab('overview'); load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (label, fn, okText) => {
    setBusy(label);
    try {
      const res = await fn();
      if (res?.data?.warning) toast.warning(res.data.warning, { autoClose: 8000 });
      else if (okText) toast.success(okText);
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'That did not work');
    } finally {
      setBusy('');
    }
  };

  const setStatus = async (status) => {
    if (status === 'Cancelled') {
      const yes = await confirmDialog({
        title: 'Cancel this training?',
        message: `Everyone on “${t.title}” is told it will not take place.${t.meetAuto ? ' The Google Calendar invite is withdrawn too.' : ''}`,
        tone: 'danger', confirmText: 'Cancel training', cancelText: 'Keep it',
      });
      if (!yes) return;
    }
    if (status === 'Completed') {
      const yes = await confirmDialog({
        title: 'Mark as completed?',
        message: 'The session ends now — its time taken is counted up to this moment, and participants are asked for their review.',
        confirmText: 'Mark completed',
      });
      if (!yes) return;
    }
    const words = { Cancelled: 'Training cancelled', Completed: 'Marked completed', Planned: 'Training restored' };
    await act(status, () => api.put(`/training/${id}`, { status }), words[status]);
  };

  const remove = async () => {
    const yes = await confirmDialog({
      title: 'Delete this training?',
      message: `“${t.title}”, its files, attendance and reviews are deleted for good.${['Planned', 'Ongoing'].includes(t.status) ? ' Everyone on it is told it will not take place.' : ''}`,
      tone: 'danger', confirmText: 'Delete',
    });
    if (!yes) return;
    setBusy('delete');
    try {
      await api.delete(`/training/${id}`);
      toast.success('Training deleted');
      onChanged?.();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not delete');
      setBusy('');
    }
  };

  const makeMeet = () => act('meet', () => api.post(`/training/${id}/meet`), 'Google Meet created — invites are on their way');

  const copy = async (link) => {
    try { await navigator.clipboard.writeText(link); toast.success('Link copied'); } catch { toast.info(link); }
  };

  const openFile = async (f) => {
    setOpening(String(f._id));
    await openTrainingFile(id, f);
    setOpening('');
  };

  const live = t?.status === 'Ongoing';
  const upcoming = t?.status === 'Planned' || live;
  const sum = t?.feedbackSummary;
  const joined = (t?.participants || []).filter((p) => p.joinedAt).length;
  const reviewed = (t?.participants || []).filter((p) => p.reviewed).length;

  return (
    <div className="fixed inset-0 trn-drawer-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="trn-drawer" role="dialog" aria-modal="true" aria-label={t ? t.title : 'Training'}>
        <div className={`trn-drawer-head ${live ? 'is-live' : ''}`}>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 mb-1.5">
                {t && <StatusPill status={t.status} />}
                {t && <CategoryChip name={t.category} />}
              </div>
              <h2 className="text-lg font-bold leading-snug text-gray-900 break-words">{t ? t.title : 'Loading…'}</h2>
              {t && (
                <div className="trn-meta text-gray-600">
                  <span><FiCalendar size={13} />{longDate(t.startDate)}</span>
                  <span><FiClock size={13} />{timeRange(t)}{t.durationMinutes ? ` · ${durationText(t.durationMinutes)}` : ''}</span>
                </div>
              )}
            </div>
            <button type="button" className="trn-icon-btn text-gray-500" onClick={onClose} aria-label="Close" data-modal-close><FiX size={18} /></button>
          </div>
        </div>

        <div className="trn-drawer-body">
          {error && <div className="trn-note is-warn text-gray-700 mb-3">{error}</div>}
          {!t && !error && (
            <div className="space-y-3 pt-2"><div className="skeleton h-5 rounded w-2/3" /><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-24 rounded" /></div>
          )}
          {t && (
            <>
              <div className="trn-tabs" role="tablist">
                {[
                  ['overview', 'Overview', null],
                  ['people', 'Participants', t.participants.length],
                  ['reviews', 'Reviews', sum?.count || 0],
                ].map(([k, label, n]) => (
                  <button key={k} type="button" role="tab" aria-selected={tab === k} className={`trn-tab ${tab === k ? 'is-on' : ''} text-gray-700`} onClick={() => setTab(k)}>
                    {label}{n !== null && <span className="trn-seg-count">{n}</span>}
                  </button>
                ))}
              </div>

              {tab === 'overview' && (
                <div className="space-y-5">
                  <dl className="trn-facts">
                    <Fact label="Trainer">
                      {t.trainer ? (
                        <>
                          <span className={`trn-av ${t.trainerType === 'external' ? 'is-ext' : ''}`}>{initials(t.trainer)}</span>
                          <span className="font-medium">{t.trainer}</span>
                          <span className={`trn-tag ${t.trainerType === 'employee' ? 'is-accent' : 'is-amber'}`}>{t.trainerType === 'employee' ? 'Staff' : 'Outside'}</span>
                        </>
                      ) : <span className="text-gray-500">Not named</span>}
                    </Fact>
                    <Fact label="Category"><CategoryChip name={t.category} /></Fact>
                    <Fact label="People">
                      <FiUsers size={14} className="text-gray-500" /> {t.participants.length} on the list
                      {joined > 0 && <span className="text-gray-500">· {joined} joined</span>}
                    </Fact>
                    {t.createdBy && <Fact label="Booked by">{t.createdBy.name}<span className="text-gray-500 text-xs">{t.createdAt ? `· ${formatDateTime12(t.createdAt, { year: false })}` : ''}</span></Fact>}
                  </dl>

                  <div>
                    <div className="trn-label text-gray-600">Meeting</div>
                    {t.meetingLink ? (
                      <div className="trn-link-box">
                        <span className="trn-choice-icon" style={{ color: live ? '#dc2626' : 'var(--accent)' }}><FiVideo size={16} /></span>
                        <span className="trn-link-text text-gray-800" title={t.meetingLink}>{t.meetingLink}</span>
                        <button type="button" className="trn-btn" onClick={() => copy(t.meetingLink)}><FiCopy size={13} /> Copy</button>
                        <a className={`trn-btn ${live ? 'is-live' : ''}`} href={t.meetingLink} target="_blank" rel="noopener noreferrer">
                          <FiExternalLink size={13} /> {live ? 'Join now' : 'Open'}
                        </a>
                      </div>
                    ) : (
                      <div className="trn-note text-gray-600">
                        <span className="flex-1">{t.status === 'Cancelled' ? 'No link — cancelled.' : 'No meeting link.'}</span>
                        {writable && meetAvailable && upcoming && (
                          <button type="button" className="trn-btn" onClick={makeMeet} disabled={!!busy}><FiVideo size={13} /> {busy === 'meet' ? 'Creating…' : 'Create Google Meet'}</button>
                        )}
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="trn-label text-gray-600">About</div>
                    {t.description ? <p className="trn-desc text-gray-800">{t.description}</p> : <p className="text-sm text-gray-500">No description.</p>}
                  </div>

                  <div>
                    <div className="trn-label text-gray-600">Files ({t.attachments.length})</div>
                    {t.attachments.length ? (
                      <div className="trn-files">
                        {t.attachments.map((f) => <FileRow key={f._id} file={f} onOpen={() => openFile(f)} busy={opening === String(f._id)} />)}
                      </div>
                    ) : <p className="text-sm text-gray-500">No files attached.</p>}
                  </div>
                </div>
              )}

              {tab === 'people' && (
                t.participants.length === 0 ? (
                  <EmptyState icon={FiUsers} title="Nobody on this training yet">{writable ? 'Edit it to add participants.' : null}</EmptyState>
                ) : (
                  <div>
                    <div className="flex flex-wrap gap-2 mb-3">
                      <span className="trn-tag">{t.participants.length} on the list</span>
                      <span className="trn-tag is-accent">{joined} joined from the portal</span>
                      <span className="trn-tag is-amber">{reviewed} reviewed</span>
                    </div>
                    {t.participants.map((p) => (
                      <div key={p._id} className="trn-person">
                        <span className="trn-av is-lg">{initials(fullName(p))}</span>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold text-gray-900 truncate">{fullName(p)}</div>
                          <div className="text-xs text-gray-500 truncate">{[p.employeeCode, p.designation, p.department].filter(Boolean).join(' · ') || p.email}</div>
                        </div>
                        <div className="text-right shrink-0">
                          {p.joinedAt
                            ? <div><span className="trn-yes"><FiCheckCircle size={12} /> Joined {formatDateTime12(p.joinedAt, { year: false }).split(', ')[1]}</span></div>
                            : <div className="trn-no text-gray-600">{t.status === 'Planned' ? 'Not started' : 'Did not join'}</div>}
                          {p.reviewed && (
                            <div className="text-[11px] text-gray-500 mt-0.5"><span className="inline-flex items-center gap-1"><FiStar size={10} /> Reviewed</span></div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )
              )}

              {tab === 'reviews' && (
                !sum?.count ? (
                  <EmptyState icon={FiMessageSquare} title="No reviews yet" />
                ) : (
                  <div className="space-y-4">
                    <div className="trn-fb-hero">
                      <div className="text-center">
                        <div className="trn-fb-big text-gray-900">{sum.clarity}</div>
                        <Stars value={sum.clarity} size={15} />
                        <div className="text-[11px] text-gray-500 mt-1">clarity · {sum.count} of {t.participants.length}</div>
                      </div>
                      <div className="trn-dist">
                        {[5, 4, 3, 2, 1].map((n) => {
                          const c = sum.distribution[n - 1] || 0;
                          return (
                            <div key={n} className="trn-dist-row text-gray-600">
                              <span>{n}★</span>
                              <span className="trn-dist-bar"><span style={{ width: `${sum.count ? (c / sum.count) * 100 : 0}%` }} /></span>
                              <span className="text-right">{c}</span>
                            </div>
                          );
                        })}
                      </div>
                      <div className="text-xs text-gray-600 space-y-1">
                        <div>Usefulness <b className="text-gray-900">{sum.usefulness ?? '—'}</b></div>
                        <div>Trainer <b className="text-gray-900">{sum.trainerRating ?? '—'}</b></div>
                      </div>
                    </div>
                    <div>
                      {t.feedback.map((f) => (
                        <div key={f.user._id} className="trn-review">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="trn-av">{initials(fullName(f.user))}</span>
                            <span className="text-sm font-semibold text-gray-900">{fullName(f.user) || 'Former employee'}</span>
                            {f.department && <span className="text-xs text-gray-500">{f.department}</span>}
                            <span className="ml-auto text-[11px] text-gray-500">{formatDateTime12(f.submittedAt, { year: false })}</span>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-xs text-gray-600">
                            <span className="inline-flex items-center gap-1.5">Clarity <Stars value={f.clarity} size={12} /> <b className="text-gray-800">{RATING_WORDS.clarity[f.clarity - 1]}</b></span>
                            {f.usefulness && <span>Usefulness <b className="text-gray-800">{f.usefulness}/5</b></span>}
                            {f.trainerRating && <span>Trainer <b className="text-gray-800">{f.trainerRating}/5</b></span>}
                          </div>
                          {f.comment && <div className="trn-quote text-gray-800">{f.comment}</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                )
              )}
            </>
          )}
        </div>

        {t && writable && (
          <div className="trn-drawer-foot">
            <button type="button" className="trn-btn is-danger mr-auto" onClick={remove} disabled={!!busy}><FiTrash2 size={14} /> Delete</button>
            {t.status === 'Cancelled' ? (
              <button type="button" className="trn-btn" onClick={() => setStatus('Planned')} disabled={!!busy}><FiRotateCcw size={14} /> Restore</button>
            ) : upcoming && (
              <button type="button" className="trn-btn" onClick={() => setStatus('Cancelled')} disabled={!!busy}><FiSlash size={14} /> Cancel training</button>
            )}
            {live && <button type="button" className="trn-btn" onClick={() => setStatus('Completed')} disabled={!!busy}><FiCheckCircle size={14} /> Mark completed</button>}
            <button type="button" className="trn-btn is-primary accent-bg on-accent" onClick={() => onEdit(t)} disabled={!!busy}><FiEdit2 size={14} /> Edit</button>
          </div>
        )}
      </aside>
    </div>
  );
}

