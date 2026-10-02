/**
 * Book or edit a training — one modal, five numbered sections:
 *
 *   1  Details        title, category (pick, or add a new one), trainer (one of
 *                     the staff, or anybody from outside — just type the name)
 *   2  Schedule       date, start and end time — with one-tap lengths
 *   3  Meeting        create a Google Meet (invites go out by email), paste a
 *                     link, or in person
 *   4  About & files  what it covers, and files everyone on it can download
 *   5  Participants   a department-grouped tick list
 *
 * Saving is two steps when files are involved: the training itself (JSON),
 * then the new files (multipart, against the id). Files taken off the list
 * are deleted after. Whatever the server says went wrong comes back as its own
 * sentence — including a Meet link that could not be created, which does NOT
 * fail the save.
 */
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiX, FiCalendar, FiClock, FiVideo, FiLink, FiMapPin, FiUser, FiTag, FiInfo, FiCopy, FiExternalLink, FiEdit3,
} from 'react-icons/fi';
import api from '../../api/client';
import Combobox from './Combobox';
import ParticipantPicker from './ParticipantPicker';
import FileDrop from './FileDrop';
import { categoryHue, fullName, initials, durationText } from './trainingUtil';
import { toHM, toYMD } from '../../utils/time';

const LENGTHS = [30, 45, 60, 90, 120, 180];

const addMinutes = (hm, min) => {
  const [h, m] = String(hm || '00:00').split(':').map(Number);
  const total = (h * 60 + m + min + 24 * 60) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};
const minutesBetween = (a, b) => {
  const [ah, am] = String(a).split(':').map(Number);
  const [bh, bm] = String(b).split(':').map(Number);
  return (bh * 60 + bm) - (ah * 60 + am);
};
const joinLocal = (ymd, hm) => {
  if (!ymd || !hm) return null;
  const d = new Date(`${ymd}T${hm}:00`);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** The next round hour from now, as the default start of a new booking. */
function nextHour() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

function initialForm(t) {
  if (!t) {
    const s = nextHour();
    return {
      title: '', category: '', trainerText: '', trainerUserId: '',
      date: toYMD(s), startTime: toHM(s), endTime: addMinutes(toHM(s), 60), multiDay: false, endDate: toYMD(s),
      meetingMode: null, meetingLink: '', description: '', participants: [],
    };
  }
  const s = t.startDate ? new Date(t.startDate) : null;
  const e = t.endDate ? new Date(t.endDate) : null;
  const multi = !!(s && e && toYMD(s) !== toYMD(e));
  return {
    title: t.title || '',
    category: t.category || '',
    trainerText: t.trainer || '',
    trainerUserId: t.trainerUser?._id ? String(t.trainerUser._id) : '',
    date: s ? toYMD(s) : '',
    startTime: s ? toHM(s) : '',
    endTime: e ? toHM(e) : (s ? addMinutes(toHM(s), 60) : ''),
    multiDay: multi,
    endDate: e ? toYMD(e) : (s ? toYMD(s) : ''),
    meetingMode: t.meetingLink ? 'keep' : 'none',
    meetingLink: t.meetingLink || '',
    description: t.description || '',
    participants: (t.participants || []).map((p) => String(p._id || p)),
  };
}

function Section({ n, title, hint, children }) {
  return (
    <section className="trn-section">
      <div className="trn-sec-head">
        <span className="trn-sec-n">{n}</span>
        <div className="min-w-0">
          <div className="trn-sec-title text-gray-900">{title}</div>
          {hint && <div className="trn-sec-hint text-gray-600">{hint}</div>}
        </div>
      </div>
      {children}
    </section>
  );
}

export default function TrainingForm({
  training, people = [], includeExecutives = false, categories = [], meetAvailable = false,
  onClose, onSaved, onCategoriesChanged,
}) {
  const editing = !!training?._id;
  const [form, setForm] = useState(() => initialForm(training));
  const [newFiles, setNewFiles] = useState([]);
  const [removed, setRemoved] = useState([]);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  // A new booking defaults to a Google Meet when the server can make one.
  useEffect(() => {
    if (!editing && form.meetingMode === null) set({ meetingMode: meetAvailable ? 'auto' : 'link' });
  }, [editing, meetAvailable]); // eslint-disable-line react-hooks/exhaustive-deps

  const known = useMemo(() => Object.fromEntries((training?.participants || [])
    .filter((p) => p && p._id).map((p) => [String(p._id), p])), [training]);

  const start = joinLocal(form.date, form.startTime);
  const end = joinLocal(form.multiDay ? form.endDate : form.date, form.endTime);
  const minutes = start && end ? Math.round((end - start) / 60000) : null;
  const backwards = minutes !== null && minutes <= 0;

  const trainerGroups = useMemo(() => [{
    label: 'Staff',
    options: people.map((p) => ({
      key: String(p._id),
      label: fullName(p),
      sub: [p.designation, p.department].filter(Boolean).join(' · ') || p.role,
      icon: <span className="trn-av">{initials(fullName(p))}</span>,
    })),
  }], [people]);
  const categoryGroups = useMemo(() => [{
    options: categories.map((c) => ({
      key: String(c._id),
      label: c.name,
      icon: <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: categoryHue(c.name) }} />,
    })),
  }], [categories]);

  const addCategory = async (name) => {
    try {
      const { data } = await api.post('/training/categories', { name });
      onCategoriesChanged?.(data.categories);
      set({ category: data.category.name });
      toast.success(`Category “${data.category.name}” added`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not add the category');
    }
  };

  const pickLength = (min) => {
    if (!form.startTime) return;
    if (form.multiDay) {
      const s = joinLocal(form.date, form.startTime);
      if (!s) return;
      const e = new Date(s.getTime() + min * 60000);
      set({ endDate: toYMD(e), endTime: toHM(e) });
    } else {
      const crosses = minutesBetween(form.startTime, addMinutes(form.startTime, min)) <= 0;
      if (crosses) {
        const s = joinLocal(form.date, form.startTime);
        const e = new Date(s.getTime() + min * 60000);
        set({ multiDay: true, endDate: toYMD(e), endTime: toHM(e) });
      } else set({ endTime: addMinutes(form.startTime, min) });
    }
  };

  const onStartTime = (v) => {
    // Keep the length the person already chose when the start moves.
    const keep = minutes && minutes > 0 && !form.multiDay ? minutes : 60;
    const patch = { startTime: v };
    if (v && !form.multiDay && minutesBetween(v, addMinutes(v, keep)) > 0) patch.endTime = addMinutes(v, keep);
    set(patch);
  };

  const copyLink = async (link) => {
    try { await navigator.clipboard.writeText(link); toast.success('Link copied'); } catch { toast.info(link); }
  };

  const validate = () => {
    if (!form.title.trim()) return 'Give the training a title.';
    if (!form.date || !form.startTime || !form.endTime) return 'Set the date and the start and end times.';
    if (form.multiDay && !form.endDate) return 'Set the day it ends.';
    if (backwards) return 'The end has to be after the start.';
    if (form.meetingMode === 'link' && form.meetingLink.trim() && !/^https?:\/\//i.test(form.meetingLink.trim())) {
      return 'Paste the full meeting link, starting with https://';
    }
    return '';
  };

  const save = async (e) => {
    e.preventDefault();
    const problem = validate();
    if (problem) { setError(problem); return; }
    setError('');
    setSaving('Saving…');
    try {
      const payload = {
        title: form.title.trim(),
        description: form.description.trim(),
        category: form.category.trim(),
        trainerUser: form.trainerUserId || null,
        trainer: form.trainerText.trim(),
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        participants: form.participants,
      };
      if (form.meetingMode === 'auto') payload.createMeet = true;
      if (form.meetingMode === 'link') payload.meetingLink = form.meetingLink.trim();
      if (form.meetingMode === 'none') payload.meetingLink = '';
      if (form.meetingMode === 'auto' && editing) payload.meetingLink = '';

      const { data } = editing
        ? await api.put(`/training/${training._id}`, payload)
        : await api.post('/training', payload);
      const id = data.training._id;

      if (newFiles.length) {
        setSaving(`Uploading ${newFiles.length} file${newFiles.length === 1 ? '' : 's'}…`);
        const fd = new FormData();
        newFiles.forEach((f) => fd.append('files', f, f.name));
        try {
          await api.post(`/training/${id}/files`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        } catch (err) {
          toast.error(`Training saved, but the files did not upload: ${err.response?.data?.message || err.message}`);
        }
      }
      for (const fileId of removed) {
        try { await api.delete(`/training/${id}/files/${fileId}`); } catch { /* the next edit will show it again */ }
      }
      if (data.warning) toast.warning(data.warning, { autoClose: 8000 });
      else toast.success(editing ? 'Training updated' : 'Training booked — everyone on it has been told');
      onSaved?.(id, !editing);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save the training');
    } finally {
      setSaving('');
    }
  };

  const existingFiles = (training?.attachments || []).filter((f) => !removed.includes(String(f._id)));
  const picked = people.find((p) => String(p._id) === form.trainerUserId);
  const peopleCount = form.participants.length;

  return (
    <div className="fixed inset-0 bg-black/40 trn-modal-wrap" role="dialog" aria-modal="true" aria-label={editing ? 'Edit training' : 'New training'}>
      <div className="trn-modal trn-card-base flex flex-col">
      <form onSubmit={save} className="flex flex-col flex-1 min-h-0">
        <div className="trn-modal-head">
          <span className="trn-kpi-icon" style={{ '--kpi-hue': 'var(--accent)' }}><FiCalendar size={18} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-lg font-bold text-gray-900">{editing ? 'Edit training' : 'New training'}</div>
            <div className="text-xs text-gray-600">
              {editing ? 'Changes to the time, people or link are sent to everyone on it.' : 'Everyone you add is told in the app, with the details and the join link.'}
            </div>
          </div>
          <button type="button" className="trn-icon-btn text-gray-500" onClick={onClose} aria-label="Close" data-modal-close><FiX size={18} /></button>
        </div>

        <div className="trn-modal-body overflow-y-auto">
          <Section n={1} title="Details">
            <div className="trn-grid is-2">
              <div className="trn-span-all">
                <label className="trn-field-label text-gray-700" htmlFor="trn-title">Training title *</label>
                <input id="trn-title" className="trn-input text-gray-900" value={form.title} autoFocus={!editing}
                  onChange={(e) => set({ title: e.target.value })} placeholder="e.g. HRMS app training for the sales team" maxLength={140} />
              </div>
              <div>
                <label className="trn-field-label text-gray-700" htmlFor="trn-cat"><FiTag size={11} className="inline mr-1" />Category</label>
                <Combobox
                  id="trn-cat"
                  value={form.category}
                  onChange={(v) => set({ category: v })}
                  onPick={(o) => set({ category: o.label })}
                  groups={categoryGroups}
                  placeholder={categories.length ? 'Pick or type a new one' : 'Type a category, e.g. Sales'}
                  addLabel={(t) => `Add “${t}” as a new category`}
                  onAdd={addCategory}
                  leading={form.category ? <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: categoryHue(form.category) }} /> : null}
                />
              </div>
              <div>
                <label className="trn-field-label text-gray-700" htmlFor="trn-trainer"><FiUser size={11} className="inline mr-1" />Trainer</label>
                <Combobox
                  id="trn-trainer"
                  value={form.trainerText}
                  onChange={(v) => set({ trainerText: v, trainerUserId: picked && fullName(picked) === v ? form.trainerUserId : '' })}
                  onPick={(o) => set({ trainerText: o.label, trainerUserId: o.key })}
                  groups={trainerGroups}
                  addFirst
                  addLabel={(t) => `Use “${t}” — outside trainer`}
                  onAdd={(t) => set({ trainerText: t, trainerUserId: '' })}
                  placeholder="Pick a colleague, or type any name"
                  leading={form.trainerText ? <span className={`trn-av ${form.trainerUserId ? '' : 'is-ext'}`} style={{ width: '1.6rem', height: '1.6rem', borderWidth: 0 }}>{initials(form.trainerText)}</span> : null}
                />
                <div className="mt-1.5 text-xs text-gray-500 min-h-[1rem]">
                  {form.trainerUserId ? (
                    <span className="trn-tag is-accent">Staff · sees it in My Trainings</span>
                  ) : form.trainerText.trim() ? (
                    <span className="trn-tag is-amber">Outside trainer</span>
                  ) : 'Optional'}
                </div>
              </div>
            </div>
          </Section>

          <Section n={2} title="Schedule" hint="Shown to everyone in their own time — 12-hour clock.">
            <div className="trn-grid is-3">
              <div>
                <label className="trn-field-label text-gray-700" htmlFor="trn-date"><FiCalendar size={11} className="inline mr-1" />{form.multiDay ? 'Starts on *' : 'Date *'}</label>
                <input id="trn-date" type="date" className="trn-input text-gray-900" value={form.date}
                  onChange={(e) => set({ date: e.target.value, endDate: form.multiDay && form.endDate >= e.target.value ? form.endDate : e.target.value })} />
              </div>
              <div>
                <label className="trn-field-label text-gray-700" htmlFor="trn-start"><FiClock size={11} className="inline mr-1" />Start time *</label>
                <input id="trn-start" type="time" step={300} className="trn-input text-gray-900" value={form.startTime} onChange={(e) => onStartTime(e.target.value)} />
              </div>
              <div>
                <label className="trn-field-label text-gray-700" htmlFor="trn-end"><FiClock size={11} className="inline mr-1" />End time *</label>
                <input id="trn-end" type="time" step={300} className="trn-input text-gray-900" value={form.endTime} onChange={(e) => set({ endTime: e.target.value })} />
              </div>
              {form.multiDay && (
                <div>
                  <label className="trn-field-label text-gray-700" htmlFor="trn-end-date">Ends on *</label>
                  <input id="trn-end-date" type="date" className="trn-input text-gray-900" value={form.endDate} min={form.date}
                    onChange={(e) => set({ endDate: e.target.value })} />
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 mt-3">
              <div className="trn-quick" role="group" aria-label="Length">
                {LENGTHS.map((m) => (
                  <button key={m} type="button" className={minutes === m ? 'is-on' : ''} onClick={() => pickLength(m)}>{durationText(m)}</button>
                ))}
              </div>
              <div className="flex items-center gap-3 text-xs">
                <label className="inline-flex items-center gap-1.5 text-gray-600 cursor-pointer">
                  <input type="checkbox" checked={form.multiDay} onChange={(e) => set({ multiDay: e.target.checked, endDate: form.date })} />
                  Ends on another day
                </label>
                {minutes !== null && (
                  <span className={`trn-tag ${backwards ? 'is-amber' : 'is-accent'}`}>{backwards ? 'Ends before it starts' : `Length ${durationText(minutes)}`}</span>
                )}
              </div>
            </div>
          </Section>

          <Section n={3} title="Meeting" hint="Participants join from their own My Trainings page, like an interview.">
            {form.meetingMode === 'keep' ? (
              <div className="space-y-2">
                <div className="trn-link-box">
                  <span className="trn-choice-icon" style={{ color: 'var(--accent)' }}><FiVideo size={16} /></span>
                  <span className="trn-link-text text-gray-800">{form.meetingLink}</span>
                  <button type="button" className="trn-btn" onClick={() => copyLink(form.meetingLink)}><FiCopy size={13} /> Copy</button>
                  <a className="trn-btn" href={form.meetingLink} target="_blank" rel="noopener noreferrer"><FiExternalLink size={13} /> Open</a>
                </div>
                {training?.meetAuto && (
                  <div className="trn-note text-gray-600"><FiInfo size={14} className="shrink-0 mt-0.5" />
                    Made with Google Meet — the calendar invite moves on its own when you change the time or the people.
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="trn-btn" onClick={() => set({ meetingMode: 'link', meetingLink: '' })}><FiEdit3 size={13} /> Use a different link</button>
                  {meetAvailable && <button type="button" className="trn-btn" onClick={() => set({ meetingMode: 'auto' })}><FiVideo size={13} /> New Google Meet</button>}
                  <button type="button" className="trn-btn is-danger" onClick={() => set({ meetingMode: 'none', meetingLink: '' })}>Remove link</button>
                </div>
              </div>
            ) : (
              <>
                <div className="trn-choices">
                  <button type="button" className={`trn-choice ${form.meetingMode === 'auto' ? 'is-on' : ''}`} disabled={!meetAvailable}
                    onClick={() => set({ meetingMode: 'auto' })} title={meetAvailable ? '' : 'Google Meet is not set up on the server'}>
                    <span className="trn-choice-icon"><FiVideo size={16} /></span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-gray-900">Create Google Meet</span>
                      <span className="block text-xs text-gray-500">{meetAvailable ? 'Link made for you; invites emailed' : 'Not set up on the server'}</span>
                    </span>
                  </button>
                  <button type="button" className={`trn-choice ${form.meetingMode === 'link' ? 'is-on' : ''}`} onClick={() => set({ meetingMode: 'link' })}>
                    <span className="trn-choice-icon"><FiLink size={16} /></span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-gray-900">Paste a link</span>
                      <span className="block text-xs text-gray-500">Meet, Zoom, Teams…</span>
                    </span>
                  </button>
                  <button type="button" className={`trn-choice ${form.meetingMode === 'none' ? 'is-on' : ''}`} onClick={() => set({ meetingMode: 'none' })}>
                    <span className="trn-choice-icon"><FiMapPin size={16} /></span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-gray-900">In person</span>
                      <span className="block text-xs text-gray-500">No meeting link</span>
                    </span>
                  </button>
                </div>
                {form.meetingMode === 'link' && (
                  <input className="trn-input text-gray-900 mt-3" value={form.meetingLink} onChange={(e) => set({ meetingLink: e.target.value })}
                    placeholder="https://meet.google.com/abc-defg-hij" inputMode="url" />
                )}
                {form.meetingMode === 'auto' && (
                  <div className="trn-note text-gray-600 mt-3"><FiInfo size={14} className="shrink-0 mt-0.5" />
                    A Google Meet link is created when you save, and Google emails the calendar invite to everyone on the training.
                  </div>
                )}
              </>
            )}
          </Section>

          <Section n={4} title="About & files" hint="Everyone on the training can read this and download the files.">
            <textarea className="trn-input text-gray-900" rows={4} value={form.description} maxLength={5000}
              onChange={(e) => set({ description: e.target.value })}
              placeholder="What it covers, what to prepare, anything to bring…" />
            <div className="mt-3">
              <FileDrop
                existing={existingFiles}
                pending={newFiles}
                onAddFiles={(files) => setNewFiles((f) => [...f, ...files])}
                onRemovePending={(i) => setNewFiles((f) => f.filter((_, j) => j !== i))}
                onRemoveExisting={(f) => setRemoved((r) => [...r, String(f._id)])}
              />
            </div>
          </Section>

          <Section n={5} title="Participants" hint={peopleCount ? `${peopleCount} selected — each of them is told in the app.` : 'Nobody yet — you can add people later too.'}>
            <ParticipantPicker
              people={people}
              value={form.participants}
              onChange={(ids) => set({ participants: ids })}
              includeExecutives={includeExecutives}
              known={known}
            />
          </Section>
        </div>

        <div className="trn-modal-foot">
          <div className="text-xs text-gray-600 min-w-0 flex-1">
            {error ? <span className="text-red-600 font-medium">{error}</span>
              : minutes > 0 && start ? `${start.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })} · ${durationText(minutes)} · ${peopleCount} participant${peopleCount === 1 ? '' : 's'}` : ''}
          </div>
          <div className="flex gap-2 ml-auto">
            <button type="button" className="trn-btn" onClick={onClose} disabled={!!saving}>Cancel</button>
            <button type="submit" className="trn-btn is-primary accent-bg on-accent" disabled={!!saving}>
              {saving || (editing ? 'Save changes' : 'Book training')}
            </button>
          </div>
        </div>
      </form>
      </div>
    </div>
  );
}
