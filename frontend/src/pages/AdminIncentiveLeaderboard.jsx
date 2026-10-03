/**
 * AdminIncentiveLeaderboard — who may see whose points on the employee
 * leaderboard (Incentive → Leaderboard Access).
 *
 * The leaderboard on My Incentive ranks colleagues by the points they have
 * earned since they started. That is a comparison between people's earnings, so
 * WHO APPEARS ON IT IS A COMPANY DECISION, not something each department settles
 * for itself: IT may be set to see IT and HR and nobody else, Boys only Boys.
 * This page is where the decision is written down.
 *
 * SUPERADMIN ONLY, and deliberately not behind `incentive.manage` — that
 * capability belongs to whoever runs an incentive tab, and what one department
 * learns about another's earnings is not theirs to widen. The server agrees
 * (restrictTo('SuperAdmin') on both routes), so this page is not the gate, only
 * the door.
 *
 * WHAT A RULE HERE ACTUALLY OPENS UP, because it is more than it used to be. The
 * leaderboard's five columns are Name (SSL code), Department, Designation,
 * Current Points and Total Points, both figures counting every month since the
 * person started: total is everything they have earned, current is what is left
 * after everything they have redeemed. The difference between the two is
 * therefore what they have been paid, and for exactly that reason the board was
 * to carry the total alone (user decision 2026-09-11). That rule stood until the
 * company reversed it — a standing is what you have left as well as what you
 * earned (user decision 2026-09-16) — so ticking a box on this page now lets one
 * department read both figures for another. Still not
 * on the board, whatever is ticked here: rupees, a paid figure standing on its
 * own, and any breakdown of where somebody's points came from.
 *
 * ONE THING IT NEVER GOVERNS: A PERSON'S OWN POINTS. Everybody always sees their
 * own, on the other tab of My Incentive, whatever is set here. This is only ever
 * about the comparison.
 *
 * A viewer's OWN department is always readable to them, so a rule only ever has
 * to name the others; the grid shows that cell as locked rather than letting
 * somebody untick something that would have no effect.
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
 *
 * 2026-10-03 redesign (presentation only): setting cards with a switch and a
 * segmented default, and the rules as a matrix with a sticky department column,
 * locked own-department cells and a short Result chip (the full sentence is its
 * tooltip). Styling: styles/pages/cashbook-leaderboard.css (`.lba-*`).
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { FiSave, FiAward, FiSliders, FiGrid, FiLock, FiUser, FiGlobe, FiEyeOff, FiRotateCcw, FiUsers } from 'react-icons/fi';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import ToggleSwitch from '../components/ToggleSwitch';
import '../styles/pages/cashbook-leaderboard.css';

// What a department with no rule of its own sees. Named rather than a boolean
// because "nothing" and "only your own team" are different answers and both are
// reasonable starting points for a company.
const SCOPES = [
  ['own', 'Own department only', 'The safe default — a department with no rule below sees only its own people.'],
  ['all', 'Everyone', 'A department with no rule below sees the whole company.'],
  ['none', 'Nobody', 'A department with no rule below gets no leaderboard at all.'],
];
const SCOPE_ICONS = { own: FiUser, all: FiGlobe, none: FiEyeOff };

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

  /** The Result column's chip: a few words, with summarise() as its tooltip. */
  const shortResult = (dept) => {
    const set = rules[dept];
    if (!set) {
      if (defaultScope === 'all') return { text: 'Everyone', cls: 'is-default' };
      if (defaultScope === 'none') return { text: 'No board', cls: 'is-default is-none' };
      return { text: 'Own only', cls: 'is-default' };
    }
    const others = [...set].filter((d) => d !== dept);
    const everyone = departments.length > 1 && departments.every((d) => d === dept || set.has(d));
    return { text: everyone ? 'Everyone' : others.length ? `Own + ${others.length}` : 'Own only', cls: 'is-rule' };
  };

  if (!isSuperAdmin) {
    return (
      <div>
        <PageHeader title="Leaderboard Access" />
        <div className="prm-list">
          <div className="trn-empty">
            <span className="trn-empty-icon"><FiLock size={24} /></span>
            <p className="text-sm font-semibold">Super Admins only.</p>
          </div>
        </div>
      </div>
    );
  }

  const ruleCount = departments.filter((d) => rules[d]).length;

  return (
    <div>
      <PageHeader title="Leaderboard Access">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="trn-btn is-primary accent-bg text-white"
        >
          <FiSave size={15} /> {saving ? 'Saving…' : 'Save rules'}
        </button>
      </PageHeader>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2.5 rounded-xl">{error}</div>}

      {loading ? (
        <div className="lba-stack">
          <div className="skeleton h-20 rounded-2xl" />
          <div className="skeleton h-20 rounded-2xl" />
          <div className="skeleton h-64 rounded-2xl" />
        </div>
      ) : (
        <div className="lba-stack">
          {/* WHAT A TICK ON THIS PAGE DISCLOSES — both current and total points,
              never rupees — now rides on the matrix heading's tooltip (the
              no-helper-text rule), where the ticks are made. */}
          <section className={`prm-set lba-set${enabled ? ' is-on' : ''}`}>
            <div className="prm-set-head">
              <span className="prm-set-icon" aria-hidden="true"><FiAward size={18} /></span>
              <div className="prm-set-main">
                <div className="prm-set-title">Show the leaderboard to employees</div>
              </div>
              <div className="prm-set-ctrl">
                <span className={`prm-state${enabled ? ' is-on' : ''}`}>{enabled ? 'On' : 'Off'}</span>
                <ToggleSwitch
                  checked={enabled}
                  onChange={() => setEnabled((v) => !v)}
                  label="Show the leaderboard to employees"
                />
              </div>
            </div>
          </section>

          {enabled && (
            <>
              <section className="prm-set lba-set">
                <div className="lba-set-row">
                  <div className="prm-set-head">
                    <span className="prm-set-icon" aria-hidden="true"><FiSliders size={18} /></span>
                    <div className="prm-set-main">
                      <div className="prm-set-title" title="What somebody sees when their department is not listed below.">Departments with no rule</div>
                    </div>
                  </div>
                  <div className="trn-seg" role="radiogroup" aria-label="Departments with no rule">
                    {SCOPES.map(([key, label, hint]) => {
                      const Icon = SCOPE_ICONS[key];
                      const on = defaultScope === key;
                      return (
                        <button
                          key={key}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          title={hint}
                          onClick={() => setDefaultScope(key)}
                          className={`trn-seg-btn${on ? ' is-on' : ''}`}
                        >
                          <Icon size={14} /> {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </section>

              <section className="lba-card">
                <div className="lba-card-head">
                  <div
                    className="lba-card-title"
                    title="A row is a viewing department; the ticks are what its people can see. Their own department is always included. Use Clear to put a row back on the default. Ticks share both current and total points, never rupees."
                  >
                    <span className="prm-set-icon" aria-hidden="true"><FiGrid size={17} /></span>
                    Per department
                  </div>
                  {departments.length > 0 && (
                    <span className="lba-card-sub">
                      {departments.length} {departments.length === 1 ? 'department' : 'departments'} · {ruleCount} with a rule
                    </span>
                  )}
                </div>
                {departments.length === 0 ? (
                  <div className="trn-empty">
                    <span className="trn-empty-icon"><FiUsers size={24} /></span>
                    <p className="text-sm font-semibold">Departments appear here once employees are assigned to them.</p>
                  </div>
                ) : (
                  <div className="lba-scroll">
                    <table className="lba-grid">
                      <thead>
                        <tr>
                          <th scope="col" className="lba-viewer">Can see →</th>
                          {departments.map((d) => (
                            <th key={d} scope="col">{d}</th>
                          ))}
                          <th scope="col" className="lba-res-h">Result</th>
                          <th scope="col"><span className="sr-only">Clear</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {departments.map((viewer) => {
                          const hasRule = !!rules[viewer];
                          const res = shortResult(viewer);
                          return (
                            <tr key={viewer}>
                              <th scope="row" className="lba-viewer">{viewer}</th>
                              {departments.map((target) => {
                                const own = target === viewer;
                                const on = own || !!rules[viewer]?.has(target);
                                if (own) {
                                  return (
                                    <td key={target} className="lba-cell is-own" title="Own department — always included">
                                      <span className="lba-lock" role="img" aria-label={`${viewer} can see ${target} (own department, always on)`}>
                                        <FiLock size={12} />
                                      </span>
                                    </td>
                                  );
                                }
                                return (
                                  <td key={target} className={`lba-cell${on ? ' is-on' : ''}`}>
                                    <label className="lba-hit" title={`${viewer} can see ${target}`}>
                                      <input
                                        type="checkbox"
                                        checked={on}
                                        onChange={() => toggle(viewer, target)}
                                        aria-label={`${viewer} can see ${target}`}
                                      />
                                    </label>
                                  </td>
                                );
                              })}
                              <td className="lba-res">
                                <span className={`lba-result ${res.cls}`} title={summarise(viewer)}>
                                  {res.text}
                                  {!hasRule && <span className="lba-result-tag">Default</span>}
                                </span>
                              </td>
                              <td className="lba-act">
                                {hasRule && (
                                  <button
                                    type="button"
                                    onClick={() => clearRule(viewer)}
                                    className="trn-btn lba-clear"
                                    title="Put this row back on the default"
                                  >
                                    <FiRotateCcw size={13} /> Clear
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
              </section>
            </>
          )}
        </div>
      )}
    </div>
  );
}
