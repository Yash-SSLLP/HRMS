/**
 * Keep the category list — add, rename, take off. Whoever runs training owns
 * it (a rename is carried onto every training filed under the old name; taking
 * one off the list leaves past trainings their name, it just stops being offered).
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { FiX, FiTag, FiPlus, FiEdit2, FiTrash2, FiCheck } from 'react-icons/fi';
import api from '../../api/client';
import { confirmDialog } from '../dialogs';
import { categoryHue } from './trainingUtil';

export default function CategoryManager({ onClose, onChanged }) {
  const [list, setList] = useState(null);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const { data } = await api.get('/training/categories');
      setList(data.categories);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load the categories');
      setList([]);
    }
  };
  useEffect(() => { load(); }, []);

  const done = async (data) => {
    if (data?.categories) onChanged?.(data.categories);
    await load();
  };

  const add = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const { data } = await api.post('/training/categories', { name: name.trim() });
      setName('');
      toast.success(`“${data.category.name}” is on the list`);
      await done(data);
    } catch (err) { toast.error(err.response?.data?.message || 'Could not add it'); }
    finally { setBusy(false); }
  };

  const rename = async (c) => {
    if (!draft.trim() || draft.trim() === c.name) { setEditing(null); return; }
    setBusy(true);
    try {
      const { data } = await api.put(`/training/categories/${c._id}`, { name: draft.trim() });
      setEditing(null);
      toast.success(c.trainings ? `Renamed — ${c.trainings} training${c.trainings === 1 ? '' : 's'} updated` : 'Renamed');
      await done(data);
    } catch (err) { toast.error(err.response?.data?.message || 'Could not rename it'); }
    finally { setBusy(false); }
  };

  const remove = async (c) => {
    const yes = await confirmDialog({
      title: `Take “${c.name}” off the list?`,
      message: c.trainings
        ? `${c.trainings} training${c.trainings === 1 ? ' keeps' : 's keep'} this name — it just stops being offered for new ones.`
        : 'Nothing uses it yet.',
      tone: 'danger', confirmText: 'Remove',
    });
    if (!yes) return;
    setBusy(true);
    try {
      const { data } = await api.delete(`/training/categories/${c._id}`);
      await done(data);
    } catch (err) { toast.error(err.response?.data?.message || 'Could not remove it'); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 trn-modal-wrap" role="dialog" aria-modal="true" aria-label="Training categories">
      <div className="trn-modal trn-card-base flex flex-col" style={{ maxWidth: '30rem' }}>
        <div className="trn-modal-head">
          <span className="trn-kpi-icon"><FiTag size={18} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-lg font-bold text-gray-900">Categories</div>
            <div className="text-xs text-gray-600">What trainings are filed under. You can also add one straight from the booking form.</div>
          </div>
          <button type="button" className="trn-icon-btn text-gray-500" onClick={onClose} aria-label="Close" data-modal-close><FiX size={18} /></button>
        </div>
        <div className="trn-modal-body overflow-y-auto">
          <form onSubmit={add} className="flex gap-2 pt-3">
            <input className="trn-input text-gray-900" value={name} onChange={(e) => setName(e.target.value)} placeholder="New category, e.g. Product knowledge" maxLength={60} />
            <button type="submit" className="trn-btn is-primary accent-bg on-accent" disabled={busy || !name.trim()}><FiPlus size={14} /> Add</button>
          </form>
          <div className="mt-4">
            {list === null ? (
              <div className="space-y-2"><div className="skeleton h-9 rounded" /><div className="skeleton h-9 rounded" /></div>
            ) : list.length === 0 ? (
              <p className="text-sm text-gray-500 py-6 text-center">No categories yet — add the first one above.</p>
            ) : list.map((c) => (
              <div key={c._id} className="trn-person">
                <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: categoryHue(c.name) }} />
                {editing === c._id ? (
                  <form className="flex-1 flex gap-2" onSubmit={(e) => { e.preventDefault(); rename(c); }}>
                    <input autoFocus className="trn-input text-gray-900" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={60}
                      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); } }} />
                    <button type="submit" className="trn-btn" disabled={busy} aria-label="Save name"><FiCheck size={14} /></button>
                  </form>
                ) : (
                  <>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-gray-900 truncate">{c.name}</div>
                      <div className="text-xs text-gray-500">{c.trainings ? `${c.trainings} training${c.trainings === 1 ? '' : 's'}` : 'Not used yet'}</div>
                    </div>
                    <button type="button" className="trn-icon-btn text-gray-500" onClick={() => { setEditing(c._id); setDraft(c.name); }} aria-label={`Rename ${c.name}`} title="Rename"><FiEdit2 size={14} /></button>
                    <button type="button" className="trn-icon-btn text-red-600" onClick={() => remove(c)} aria-label={`Remove ${c.name}`} title="Remove"><FiTrash2 size={14} /></button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="trn-modal-foot">
          <span className="text-xs text-gray-500">{list ? `${list.length} categor${list.length === 1 ? 'y' : 'ies'}` : ''}</span>
          <button type="button" className="trn-btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
