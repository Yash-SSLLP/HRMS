import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { FiAward, FiStar, FiLock } from 'react-icons/fi';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const fullDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

// Admin → Rewards & Recognition. HR picks one Employee of the Month and one Key
// Achiever per department. The selection is a secret Draft until Announced, when
// every employee is notified and sees the dashboard banner for 2 working days.
export default function AdminRnr() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const [people, setPeople] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [award, setAward] = useState(null); // existing award for this month, or null

  const [eom, setEom] = useState('');            // userId
  const [keyByDept, setKeyByDept] = useState({}); // { [department]: userId }
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const announced = award?.status === 'Announced';

  useEffect(() => {
    api.get('/rnr/people')
      .then(({ data }) => { setPeople(data.people || []); setDepartments(data.departments || []); })
      .catch(() => {});
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/rnr?year=${year}&month=${month}`);
      const a = data.award || null;
      setAward(a);
      const eomWinner = a?.winners?.find((w) => w.category === 'EmployeeOfMonth');
      setEom(eomWinner ? String(eomWinner.user) : '');
      const map = {};
      (a?.winners || []).filter((w) => w.category === 'KeyAchiever').forEach((w) => {
        if (w.department) map[w.department] = String(w.user);
      });
      setKeyByDept(map);
    } catch {
      toast.error('Failed to load');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [year, month]);

  const nameOf = (userId) => people.find((p) => String(p.user) === String(userId))?.name || '';
  const peopleByDept = (dept) => people.filter((p) => p.department === dept);

  const buildWinners = () => {
    const winners = [];
    if (eom) winners.push({ category: 'EmployeeOfMonth', user: eom });
    Object.entries(keyByDept).forEach(([department, user]) => {
      if (user) winners.push({ category: 'KeyAchiever', department, user });
    });
    return winners;
  };

  const save = async () => {
    const { data } = await api.post('/rnr', { year, month, winners: buildWinners() });
    setAward(data.award);
    return data.award;
  };

  const onSaveDraft = async () => {
    if (!eom && Object.values(keyByDept).every((v) => !v)) {
      toast.info('Pick at least one winner first');
      return;
    }
    setBusy(true);
    try {
      await save();
      toast.success('Draft saved (hidden from employees)');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Save failed');
    } finally { setBusy(false); }
  };

  const onAnnounce = async () => {
    if (!eom && Object.values(keyByDept).every((v) => !v)) {
      toast.info('Pick at least one winner first');
      return;
    }
    const ok = await confirmDialog({
      message: `Announce ${MONTHS[month - 1]} ${year} winners to all employees now? Everyone will be notified and the banner shows for 2 working days.`,
      confirmText: 'Announce',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const a = await save();
      await api.post(`/rnr/${a._id}/announce`);
      toast.success('Announced — employees notified 🎉');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Announce failed');
    } finally { setBusy(false); }
  };

  const selectedCount = (eom ? 1 : 0) + Object.values(keyByDept).filter(Boolean).length;

  return (
    <div>
      <PageHeader title="Rewards & Recognition" subtitle="Pick the monthly Employee of the Month and one Key Achiever per department — kept secret until you announce." />

      <div className="bg-white p-3 rounded-lg shadow-sm mb-4 flex gap-2 items-center flex-wrap">
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="border rounded-lg px-3 py-2 text-sm bg-white">
          {Array.from({ length: 4 }, (_, i) => now.getFullYear() + 1 - i).map((y) => <option key={y}>{y}</option>)}
        </select>
        <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className="border rounded-lg px-3 py-2 text-sm bg-white">
          {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        {announced ? (
          <span className="ml-auto text-xs px-2.5 py-1 rounded-full font-semibold bg-green-100 text-green-800 inline-flex items-center gap-1">
            <FiLock size={12} /> Announced {fullDate(award.announcedAt)} · banner until {fullDate(award.bannerExpiresAt)}
          </span>
        ) : (
          <span className="ml-auto text-xs px-2.5 py-1 rounded-full font-semibold bg-gray-100 text-gray-600">
            Draft · {selectedCount} selected · hidden from employees
          </span>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-gray-400 italic">Loading…</p>
      ) : (
        <div className="space-y-4">
          {/* Employee of the Month */}
          <div className="bg-white shadow rounded-xl p-5">
            <h3 className="font-semibold text-gray-800 mb-3 flex items-center gap-2">
              <FiStar className="text-amber-500" /> Employee of the Month
            </h3>
            <select
              value={eom}
              disabled={announced}
              onChange={(e) => setEom(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm bg-white w-full max-w-md disabled:bg-gray-50"
            >
              <option value="">— Select employee —</option>
              {people.map((p) => (
                <option key={String(p.user)} value={String(p.user)}>
                  {p.name}{p.department ? ` · ${p.department}` : ''}{p.designation ? ` · ${p.designation}` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Key Achievers by department */}
          <div className="bg-white shadow rounded-xl p-5">
            <h3 className="font-semibold text-gray-800 mb-1 flex items-center gap-2">
              <FiAward className="text-amber-500" /> Key Achiever · one per department
            </h3>
            {departments.length === 0 ? (
              <p className="text-sm text-gray-400 italic mt-2">No departments found. Set employee departments first.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                {departments.map((dept) => (
                  <div key={dept} className="border border-gray-100 rounded-lg p-3">
                    <div className="text-xs font-semibold text-gray-500 mb-1.5">{dept}</div>
                    <select
                      value={keyByDept[dept] || ''}
                      disabled={announced}
                      onChange={(e) => setKeyByDept((m) => ({ ...m, [dept]: e.target.value }))}
                      className="border rounded-lg px-3 py-2 text-sm bg-white w-full disabled:bg-gray-50"
                    >
                      <option value="">— Select —</option>
                      {peopleByDept(dept).map((p) => (
                        <option key={String(p.user)} value={String(p.user)}>
                          {p.name}{p.designation ? ` · ${p.designation}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Actions */}
          {announced ? (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
              This month has been announced and is now visible to all employees — it can no longer be edited.
            </div>
          ) : (
            <div className="flex flex-wrap justify-end gap-2">
              <button onClick={onSaveDraft} disabled={busy}
                className="px-4 py-2 text-sm border border-indigo-300 text-indigo-700 rounded-lg hover:bg-indigo-50 disabled:opacity-50">
                Save Draft
              </button>
              <button onClick={onAnnounce} disabled={busy}
                className="px-5 py-2 text-sm bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50">
                Announce to Everyone
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
