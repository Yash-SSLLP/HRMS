/**
 * AdminIncentiveLeaderboard — who may see whose points on the employee
 * leaderboard (Incentive → Leaderboard Access).
 *
 * The leaderboard on My Incentive ranks colleagues by the points they earned.
 * That is a comparison between people's earnings, so WHO APPEARS ON IT IS A
 * COMPANY DECISION, not something each department settles for itself: IT may be
 * set to see IT and HR and nobody else, Boys only Boys. This page is where the
 * decision is written down.
 *
 * SUPERADMIN ONLY, and deliberately not behind `incentive.manage` — that
 * capability belongs to whoever runs an incentive tab, and what one department
 * learns about another's earnings is not theirs to widen. The server agrees
 * (restrictTo('SuperAdmin') on both routes), so this page is not the gate, only
 * the door.
 *
 * TWO THINGS IT NEVER GOVERNS, both worth knowing before changing anything here:
 *  · A PERSON'S OWN POINTS. Everybody always sees their own, on the other tab of
 *    My Incentive, whatever is set here. This is only about the comparison.
 *  · WHAT ANYBODY IS OWED. The leaderboard shows points earned and nothing else
 *    — no paid figure, no outstanding figure, no rupees. Those live on the
 *    Points Dashboard.
 *
 * A viewer's OWN department is always readable to them, so a rule only ever has
 * to name the others; the grid shows it as ticked and disabled rather than
 * letting somebody untick something that would have no effect.
 *
 * THE DIFFERENCE BETWEEN NO RULE AND AN EMPTY RULE is the thing to hold on to:
 * no rule means "follow the default", which may be the whole company; an empty
 * rule means "own department only, deliberately". Clearing a row deletes the
 * rule; unticking every box keeps it.
 *
 * The phone carries the same screen
 * (mobile/src/screens/admin/IncentiveLeaderboardScreen.js).
 *
 * Backend: GET/PUT /incentives/leaderboard/settings
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';

// What a department with no rule of its own sees. Named rather than a boolean
// because "nothing" and "only your own team" are different answers and both are
// reasonable starting points for a company.
const SCOPES = [
  ['own', 'Own department only', 'The safe default — a department with no rule below sees only its own people.'],
  ['all', 'Everyone', 'A department with no rule below sees the whole company.'],
  ['none', 'Nobody', 'A department with no rule below gets no leaderboard at all.'],
];

export default function AdminIncentiveLeaderboard() {
  const me = useAuthStore((st) => st.user);
  const isSuperAdmin = me?.role === 'SuperAdmin';

  const [departments, setDepartments] = useState([]);
  const [enabled, setEnabled] = useState(true);
  const [defaultScope, setDefaultScope] = useState('own');
  // The rules as a map — department -> Set of departments it may see. A map
  // rather than the array the API speaks, because every gesture on this page is
  // "tick one department for one other department" and an array would be rebuilt
  // on each click.
  const [rules, setRules] = useState({});

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  /** Seed the form from a settings payload, so load and save share one path. */
  const apply = (data) => {
    const cfg = data.leaderboard || {};
    setDepartments(data.departments || []);
    setEnabled(cfg.enabled !== false);
    setDefaultScope(cfg.defaultScope || 'own');
    const next = {};
    for (const r of cfg.visibility || []) next[r.department] = new Set(r.canView || []);
    setRules(next);
  };

  useEffect(() => {
    api.get('/incentives/leaderboard/settings')
      .then(({ data }) => apply(data))
      .catch((err) => setError(err.response?.data?.message || 'Could not load the leaderboard settings'))
      .finally(() => setLoading(false));
  }, []);

  /**
   * Tick or untick one department inside another's rule.
   *
   * Ticking anything CREATES a rule for that department, which is the whole
   * point: until then it was following the default, and the moment somebody
   * makes a choice it should stop doing that.
   */
  const toggle = (viewer, target) => {
    setRules((prev) => {
      const next = { ...prev };
      const set = new Set(next[viewer] || []);
      if (set.has(target)) set.delete(target);
      else set.add(target);
      next[viewer] = set;
      return next;
    });
  };

  /** Put a department back on the default — see the docblock on why this is not
   *  the same as saving it empty. */
  const clearRule = (viewer) => {
    setRules((prev) => {
      const next = { ...prev };
      delete next[viewer];
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const visibility = Object.entries(rules).map(([department, set]) => ({
        department,
        canView: [...set],
      }));
      const { data } = await api.put('/incentives/leaderboard/settings', { enabled, defaultScope, visibility });
      // Re-seed from what the server actually stored, so a rule it normalised
      // away does not sit on screen looking saved.
      apply(data);
      toast.success('Saved — the rules are live for everyone');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  /** One line of English saying what a department will actually see. */
  const summarise = (dept) => {
    const set = rules[dept];
    if (!set) {
      if (defaultScope === 'all') return 'Everyone (following the default)';
      if (defaultScope === 'none') return 'No leaderboard (following the default)';
      return 'Own department only (following the default)';
    }
    const others = [...set].filter((d) => d !== dept);
    return others.length ? `${dept} + ${others.join(', ')}` : `${dept} only`;
  };

  if (!isSuperAdmin) {
    return (
      <div>
        <PageHeader title="Leaderboard Access" />
        <div className="bg-white shadow rounded-xl p-6 text-sm text-gray-500">
          Super Admins only. Deciding what one department learns about another&apos;s earnings is not
          part of running an incentive.
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Leaderboard Access"
        subtitle="Which departments each department can see on the employee incentive leaderboard."
      >
        <button
          onClick={save}
          disabled={saving}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save rules'}
        </button>
      </PageHeader>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <div className="space-y-4 max-w-5xl">
          <div className="bg-white shadow rounded-xl p-6">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="rounded mt-1"
              />
              <span>
                <span className="block font-medium text-gray-900">Show the leaderboard to employees</span>
                <span className="block text-sm text-gray-500 mt-0.5">
                  The ranking tab on every employee&apos;s My Incentive page. Their own points are never
                  hidden by this — only the comparison with everyone else.
                </span>
              </span>
            </label>
          </div>

          {enabled && (
            <>
              <div className="bg-white shadow rounded-xl p-6">
                <h2 className="card-title mb-1">Departments with no rule</h2>
                <p className="text-sm text-gray-500 mb-4">
                  What somebody sees when their department is not listed below.
                </p>
                <div className="space-y-2">
                  {SCOPES.map(([key, label, hint]) => (
                    <label key={key} className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="radio"
                        name="defaultScope"
                        checked={defaultScope === key}
                        onChange={() => setDefaultScope(key)}
                        className="mt-1"
                      />
                      <span>
                        <span className="block text-sm font-medium text-gray-900">{label}</span>
                        <span className="block text-xs text-gray-500">{hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="bg-white shadow rounded-xl overflow-hidden">
                <div className="px-6 pt-6 pb-3">
                  <h2 className="card-title mb-1">Per department</h2>
                  <p className="text-sm text-gray-500">
                    A row is a VIEWING department; the ticks are what its people can see. Their own
                    department is always included and cannot be unticked. Ticking anything in a row
                    gives that department a rule of its own and stops it following the default —
                    unticking everything again leaves it on &ldquo;own department only&rdquo;, which is
                    not the same thing. Use Clear to put it back on the default.
                  </p>
                </div>
                {departments.length === 0 ? (
                  <p className="px-6 pb-6 text-sm text-gray-500">
                    Departments appear here once employees are assigned to them.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead className="bg-gray-50 text-gray-500">
                        <tr>
                          <th className="px-4 py-3 text-left font-medium sticky left-0 bg-gray-50 z-10">Can see →</th>
                          {departments.map((d) => (
                            <th key={d} className="px-3 py-3 text-center font-medium whitespace-nowrap">{d}</th>
                          ))}
                          <th className="px-4 py-3 text-left font-medium">Result</th>
                          <th className="px-4 py-3" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {departments.map((viewer) => {
                          const hasRule = !!rules[viewer];
                          return (
                            <tr key={viewer} className="hover:bg-gray-50">
                              <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap sticky left-0 bg-white z-10">
                                {viewer}
                              </td>
                              {departments.map((target) => {
                                const own = target === viewer;
                                const on = own || !!rules[viewer]?.has(target);
                                return (
                                  <td key={target} className="px-3 py-3 text-center">
                                    <input
                                      type="checkbox"
                                      checked={on}
                                      disabled={own}
                                      onChange={() => toggle(viewer, target)}
                                      className="rounded disabled:opacity-50"
                                      aria-label={`${viewer} can see ${target}`}
                                    />
                                  </td>
                                );
                              })}
                              <td className="px-4 py-3 text-gray-600">{summarise(viewer)}</td>
                              <td className="px-4 py-3 text-right">
                                {hasRule && (
                                  <button
                                    onClick={() => clearRule(viewer)}
                                    className="text-xs text-gray-500 hover:text-gray-900 underline"
                                  >
                                    Clear
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
