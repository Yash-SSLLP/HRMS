/**
 * AdminRnr — Rewards & Recognition (admin portal). HR picks the month's winners,
 * saving a hidden draft (POST /rnr) that stays secret until announced
 * (POST /rnr/:id/announce), which notifies everyone and shows a dashboard
 * banner. People/depts from GET /rnr/people.
 *
 * 2026-10-03 (user: "Give HR and Admin to create what are the categories of
 * these awards, they can add and delete them. 'Best Employee' will be there also
 * in the top"): the awards are HR-defined categories (GET/POST/DELETE
 * /rnr/categories). "Best Employee" — the original Employee of the Month,
 * key EmployeeOfMonth — is always first and cannot be deleted; every other
 * category is company-wide (one winner) or per department (one per department).
 * A save names the categories it manages, so an older app build that only knows
 * the original two never wipes the rest. Styling: styles/pages/rnr.css (`.rnr-p-*`).
 */
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiAward, FiStar, FiLock, FiPlus, FiTrash2, FiUsers, FiGrid, FiCheck, FiSend, FiSave,
} from 'react-icons/fi';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';
import SearchableSelect from '../components/SearchableSelect';
import ToggleSwitch from '../components/ToggleSwitch';
import { PersonAvatar } from '../components/permissions/permUi';
import '../styles/pages/rnr.css';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const BEST = 'EmployeeOfMonth';
const ANY = '_'; // the slot key for a company-wide category

const fullDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

export default function AdminRnr() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const [people, setPeople] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [categories, setCategories] = useState([]);
  const [award, setAward] = useState(null); // existing award for this month, or null

  // picks[categoryKey][department | '_'] = userId; citation for Best Employee.
  const [picks, setPicks] = useState({});
  const [citation, setCitation] = useState('');
  // Only the FIRST load blanks the page; later fetches keep the cards on screen.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);

  // New category form
  const [newName, setNewName] = useState('');
  const [newPerDept, setNewPerDept] = useState(false);
  const [catBusy, setCatBusy] = useState(false);

  const announced = award?.status === 'Announced';

  useEffect(() => {
    api.get('/rnr/people')
      .then(({ data }) => { setPeople(data.people || []); setDepartments(data.departments || []); })
      .catch(() => {});
    api.get('/rnr/categories')
      .then(({ data }) => setCategories(data.categories || []))
      .catch(() => toast.error('Could not load the award categories'));
  }, []);

  const load = async () => {
    setRefreshing(true);
    try {
      const { data } = await api.get(`/rnr?year=${year}&month=${month}`);
      const a = data.award || null;
      setAward(a);
      const next = {};
      let cite = '';
      (a?.winners || []).forEach((w) => {
        const slot = w.category === BEST ? ANY : (w.department || ANY);
        next[w.category] = { ...(next[w.category] || {}), [slot]: String(w.user) };
        if (w.category === BEST) cite = w.citation || '';
      });
      setPicks(next);
      setCitation(cite);
    } catch {
      toast.error('Failed to load');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [year, month]);

  const personOf = (userId) => people.find((p) => String(p.user) === String(userId));
  const avatarUser = (p) => (p ? { _id: p.user, photo: p.photo, firstName: p.name.split(' ')[0], lastName: p.name.split(' ').slice(1).join(' ') } : null);
  const setPick = (key, slot, userId) => setPicks((m) => ({ ...m, [key]: { ...(m[key] || {}), [slot]: userId } }));

  const best = categories.find((c) => c.key === BEST);
  const others = categories.filter((c) => c.key !== BEST);
  // A per-department category offers every department; a winner already saved
  // for a department nobody is in any more is still shown.
  const deptsFor = (cat) => {
    const saved = Object.keys(picks[cat.key] || {}).filter((d) => d !== ANY);
    return [...new Set([...departments, ...saved])].sort();
  };

  const slotsTotal = (best ? 1 : 0) + others.reduce((n, c) => n + (c.perDepartment ? deptsFor(c).length : 1), 0);
  const picked = useMemo(() => categories.reduce((n, c) => n
    + Object.entries(picks[c.key] || {}).filter(([slot, v]) => v && (c.perDepartment ? slot !== ANY : slot === ANY)).length, 0),
  [categories, picks]);

  const buildWinners = () => {
    const winners = [];
    categories.forEach((c) => {
      Object.entries(picks[c.key] || {}).forEach(([slot, user]) => {
        if (!user) return;
        if (c.perDepartment && slot !== ANY) winners.push({ category: c.key, department: slot, user });
        if (!c.perDepartment && slot === ANY) {
          winners.push({ category: c.key, user, ...(c.key === BEST && citation.trim() ? { citation: citation.trim() } : {}) });
        }
      });
    });
    return winners;
  };

  const save = async () => {
    const { data } = await api.post('/rnr', {
      year, month, winners: buildWinners(), categories: categories.map((c) => c.key),
    });
    setAward(data.award);
    return data.award;
  };

  const onSaveDraft = async () => {
    if (!picked) { toast.info('Pick at least one winner first'); return; }
    setBusy(true);
    try {
      await save();
      toast.success('Draft saved (hidden from employees)');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Save failed');
    } finally { setBusy(false); }
  };

  const onAnnounce = async () => {
    if (!picked) { toast.info('Pick at least one winner first'); return; }
    const ok = await confirmDialog({
      message: `Announce ${MONTHS[month - 1]} ${year} winners to all employees now? Everyone will be notified and the banner shows for 2 working days.`,
      confirmText: 'Announce',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const a = await save();
      await api.post(`/rnr/${a._id}/announce`);
      toast.success('Announced - employees notified');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Announce failed');
    } finally { setBusy(false); }
  };

  // ---- Categories ----
  const addCategory = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setCatBusy(true);
    try {
      const { data } = await api.post('/rnr/categories', { name: newName.trim(), perDepartment: newPerDept });
      setCategories(data.categories || []);
      setNewName('');
      setNewPerDept(false);
      toast.success('Award added');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not add the award');
    } finally { setCatBusy(false); }
  };

  const removeCategory = async (cat) => {
    const ok = await confirmDialog({
      title: `Delete "${cat.name}"?`,
      message: 'Unannounced picks for it are removed. Announced months keep it.',
      confirmText: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      const { data } = await api.delete(`/rnr/categories/${cat._id}`);
      setCategories(data.categories || []);
      setPicks((m) => { const n = { ...m }; delete n[cat.key]; return n; });
      toast.success('Award deleted');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not delete the award');
    }
  };

  const picker = (cat, slot, options, placeholder) => (
    <SearchableSelect
      value={picks[cat.key]?.[slot] || ''}
      disabled={announced}
      onChange={(e) => setPick(cat.key, slot, e.target.value)}
      className="block w-full border rounded-lg px-3 py-2 text-sm"
    >
      <option value="">{placeholder}</option>
      {options.map((p) => (
        <option key={String(p.user)} value={String(p.user)}>
          {p.name}{p.designation ? ` · ${p.designation}` : ''}{!cat.perDepartment && p.department ? ` · ${p.department}` : ''}
        </option>
      ))}
    </SearchableSelect>
  );

  const bestPerson = best ? personOf(picks[BEST]?.[ANY]) : null;

  return (
    <div>
      <PageHeader title="Rewards & Recognition">
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="trn-select" aria-label="Year">
          {Array.from({ length: 4 }, (_, i) => now.getFullYear() + 1 - i).map((y) => <option key={y}>{y}</option>)}
        </select>
        <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className="trn-select" aria-label="Month">
          {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
      </PageHeader>

      {/* Where this month stands */}
      <div className={`rnr-p-status${announced ? ' is-live' : ''}${refreshing ? ' is-stale' : ''}`}>
        <span className="rnr-p-status-icon" aria-hidden="true">{announced ? <FiLock size={17} /> : <FiAward size={17} />}</span>
        <div className="min-w-0 flex-1">
          <div className="rnr-p-status-title">{MONTHS[month - 1]} {year} · {announced ? 'Announced' : 'Draft'}</div>
          <div className="rnr-p-status-sub">
            {announced
              ? `Announced ${fullDate(award.announcedAt)} · banner until ${fullDate(award.bannerExpiresAt)}`
              : `${picked} of ${slotsTotal} picked · hidden from employees`}
          </div>
        </div>
        {!announced && slotsTotal > 0 && (
          <div className="rnr-p-meter" aria-hidden="true"><span style={{ width: `${Math.min(100, (picked / slotsTotal) * 100)}%` }} /></div>
        )}
      </div>

      {loading ? (
        <div className="space-y-3 mt-4">
          <div className="skeleton h-40 rounded-2xl" />
          <div className="skeleton h-56 rounded-2xl" />
        </div>
      ) : (
        <>
          {/* Best Employee — always first */}
          {best && (
            <section className="rnr-p-hero">
              <div className="rnr-p-hero-main">
                <div className="rnr-p-hero-label"><FiStar size={14} /> {best.name}</div>
                <div className="rnr-p-hero-pick">{picker(best, ANY, people, 'Select employee')}</div>
                <label className="block mt-3">
                  <span className="prm-label">Citation</span>
                  <input value={citation} maxLength={500} disabled={announced} onChange={(e) => setCitation(e.target.value)}
                    className="prm-input" placeholder="Optional" />
                </label>
              </div>
              <div className="rnr-p-hero-winner">
                {bestPerson ? (
                  <>
                    <span className="rnr-p-hero-ring"><PersonAvatar user={avatarUser(bestPerson)} size="lg" /></span>
                    <div className="rnr-p-hero-name">{bestPerson.name}</div>
                    <div className="rnr-p-hero-role">{[bestPerson.designation, bestPerson.department].filter(Boolean).join(' · ') || '—'}</div>
                  </>
                ) : (
                  <span className="rnr-p-hero-empty"><FiAward size={30} /></span>
                )}
              </div>
            </section>
          )}

          {/* Every other award */}
          <div className="prm-head">
            <span className="prm-head-title">Awards</span>
            <span className="prm-head-sub">{others.length} {others.length === 1 ? 'category' : 'categories'}</span>
          </div>
          <div className="rnr-p-grid">
            {others.map((cat) => {
              const depts = cat.perDepartment ? deptsFor(cat) : [];
              const n = cat.perDepartment
                ? depts.filter((d) => picks[cat.key]?.[d]).length
                : (picks[cat.key]?.[ANY] ? 1 : 0);
              return (
                <section key={cat._id} className={`rnr-p-cat${cat.perDepartment ? ' is-wide' : ''}`}>
                  <div className="rnr-p-cat-head">
                    <span className="rnr-p-cat-icon" aria-hidden="true"><FiAward size={16} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="rnr-p-cat-name">{cat.name}</div>
                      <div className="rnr-p-cat-meta">
                        <span className="rnr-p-scope">{cat.perDepartment ? <><FiGrid size={11} /> One per department</> : <><FiUsers size={11} /> Company-wide</>}</span>
                        <span className="rnr-p-count">{n}/{cat.perDepartment ? depts.length : 1}</span>
                      </div>
                    </div>
                    <button type="button" className="trn-icon-btn rnr-p-del" onClick={() => removeCategory(cat)}
                      aria-label={`Delete ${cat.name}`} title="Delete this award">
                      <FiTrash2 size={15} />
                    </button>
                  </div>
                  {cat.perDepartment ? (
                    depts.length === 0 ? (
                      <p className="text-sm opacity-60">No departments yet.</p>
                    ) : (
                      <div className="rnr-p-depts">
                        {depts.map((dept) => {
                          const chosen = personOf(picks[cat.key]?.[dept]);
                          return (
                            <div key={dept} className={`rnr-p-dept${chosen ? ' is-set' : ''}`}>
                              <div className="rnr-p-dept-head">
                                <span className="rnr-p-dept-name">{dept}</span>
                                {chosen && <PersonAvatar user={avatarUser(chosen)} size="sm" />}
                              </div>
                              {picker(cat, dept, people.filter((p) => p.department === dept), 'Select')}
                            </div>
                          );
                        })}
                      </div>
                    )
                  ) : (
                    <div className="rnr-p-single">
                      {personOf(picks[cat.key]?.[ANY]) && <PersonAvatar user={avatarUser(personOf(picks[cat.key]?.[ANY]))} />}
                      <div className="min-w-0 flex-1">{picker(cat, ANY, people, 'Select employee')}</div>
                    </div>
                  )}
                </section>
              );
            })}

            {/* Add an award */}
            <form className="rnr-p-cat rnr-p-add" onSubmit={addCategory}>
              <div className="rnr-p-cat-head">
                <span className="rnr-p-cat-icon is-add" aria-hidden="true"><FiPlus size={16} /></span>
                <div className="rnr-p-cat-name">New award</div>
              </div>
              <label className="block">
                <span className="prm-label">Name</span>
                <input value={newName} maxLength={60} onChange={(e) => setNewName(e.target.value)} className="prm-input" placeholder="e.g. Team Player" />
              </label>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">One per department</span>
                <ToggleSwitch checked={newPerDept} onChange={() => setNewPerDept((v) => !v)} label="One winner per department" />
              </div>
              <button type="submit" disabled={catBusy || !newName.trim()} className="trn-btn is-primary accent-bg text-white">
                <FiPlus size={15} /> {catBusy ? 'Adding…' : 'Add award'}
              </button>
            </form>
          </div>

          {/* Save / announce */}
          <div className="rnr-p-actions">
            {announced ? (
              <span className="rnr-p-locked"><FiCheck size={15} /> Announced — locked</span>
            ) : (
              <>
                <button type="button" onClick={onSaveDraft} disabled={busy} className="trn-btn">
                  <FiSave size={15} /> Save draft
                </button>
                <button type="button" onClick={onAnnounce} disabled={busy} className="trn-btn rnr-p-announce">
                  <FiSend size={15} /> Announce to everyone
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
