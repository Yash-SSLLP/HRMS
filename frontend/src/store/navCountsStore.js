import { create } from 'zustand';
import api from '../api/client';

/**
 * The live "something is waiting for you" numbers the sidebar wears as red
 * counts, and the top bar's Approvals pill reads.
 *
 * ONE STORE, NOT ONE FETCH PER BADGE. A dozen nav rows can carry a count and
 * they all come out of two endpoints, so the fan-out happens once here and every
 * badge subscribes. The alternative — a `useEffect` per row — would have put a
 * dozen requests on the wire every twenty seconds, against a browser that opens
 * six per host, for numbers that all arrive in the same two answers.
 *
 * THE TWO NUMBERS ARE DIFFERENT QUEUES and are never summed:
 *   - `mine` (GET /approvals/count) is the REPORTING-CHAIN inbox: requests
 *     addressed to you personally, waiting on your decision. Any employee can be
 *     somebody's manager, so this one is fetched for everybody.
 *   - everything else (GET /approvals/hr-count) is the HR-WIDE tally, one key
 *     per queue, each counted behind its own capability and company wall by the
 *     server. An account that may not see a queue is answered 0 for it rather
 *     than 403, so this is safe to ask for from any admin-portal account.
 *
 * Deliberately shaped like the mobile app's store/badges.js — same endpoints,
 * same de-duplication, same "a badge is never worth an error on screen" rule.
 */

// How long a just-finished refresh counts as fresh. Comfortably shorter than the
// poll, long enough that the several things that legitimately ask at once on
// first paint (the poll effect, a route change, the pill mounting) collapse into
// one fan-out.
const FRESH_MS = 5000;

// Module-level rather than store state: nothing renders them, and a promise in
// the store would notify every subscriber twice a poll.
let inFlight = null;
let lastAt = 0;

/**
 * Every key the nav may put a badge on, so a missing answer reads as 0 rather
 * than as `undefined` (which would render as a blank pill).
 *
 * The list is the contract with GET /approvals/hr-count: add a tally there and a
 * key here, and any nav row can wear it with `badge: '<key>'`.
 */
const EMPTY = {
  mine: 0,
  interviews: 0,
  leave: 0,
  expense: 0,
  travel: 0,
  regularization: 0,
  loan: 0,
  change: 0,
  docswap: 0,
  payslipRequest: 0,
  selfPayslip: 0,
  khata: 0,
  khataConfirm: 0,
  khataSanction: 0,
  voucher: 0,
  exit: 0,
  complaint: 0,
  passwordReset: 0,
  declaration: 0,
  course: 0,
  confirmation: 0,
  taskApproval: 0,
  // Items employees asked to hand back (assets.manage). The one HR-wide key a
  // My Portal row wears — see the poll in Layout.jsx.
  assetReturn: 0,
};

/** Read one key out of a server payload, defaulting anything odd to 0. */
const n = (v) => Number(v) || 0;

/**
 * The keys that come out of the PERSONAL answer (GET /approvals/count) rather
 * than the HR-wide one. They have to be listed, because the loop below fills
 * every other key from the HR payload — and `interviews` is not in it, so
 * without this it would be overwritten with 0 on every single poll.
 */
// `taskApproval` joined them on 2026-09-22, when the top bar got a Tasks pill
// for everybody. It is answered by BOTH endpoints (see countMyApprovals), and
// listing it here is what makes the personal answer win — which is the whole
// point, because the HR-wide one is not asked for in My Portal (bar an
// assets.manage holder, for the Manage Assets count — see Layout.jsx).
const PERSONAL = ['mine', 'interviews', 'taskApproval'];

export const useNavCountsStore = create((set) => ({
  counts: EMPTY,

  /**
   * Fetch the counts.
   * @param {{admin?: boolean, force?: boolean}} [opts] - `admin` adds the
   *   HR-wide tally (skip it in the employee portal unless the account holds
   *   assets.manage — "Manage Assets" is the only row there that wears one; for
   *   anyone else it would be a request per poll for numbers nobody reads).
   *   `force` ignores the freshness window — the poll passes it, and so should
   *   anything that just changed a queue.
   * @returns {Promise<void>}
   */
  refresh: async (opts = {}) => {
    if (inFlight) return inFlight;
    if (!opts.force && Date.now() - lastAt < FRESH_MS) return undefined;

    inFlight = (async () => {
      try {
        const [mine, hr] = await Promise.all([
          api.get('/approvals/count').catch(() => ({ data: {} })),
          opts.admin
            ? api.get('/approvals/hr-count').catch(() => ({ data: {} }))
            : Promise.resolve({ data: {} }),
        ]);
        const d = hr.data || {};
        // Rebuilt from EMPTY every time, so a key the server stops answering
        // falls back to 0 instead of keeping the last number it ever sent.
        const next = {
          ...EMPTY,
          mine: n(mine.data?.total),
          // Interview rounds booked with this user and not yet written up. It
          // rides along on the personal answer (one request, not two) and is
          // deliberately NOT part of that answer's `total` — an interview is
          // not an approval, so the Approvals pill must not count it.
          interviews: n(mine.data?.interviews),
          // Tasks on me, plus submissions waiting on my word. Out of the
          // personal answer so it works in BOTH portals — an employee has
          // tasks, and until now only the admin portal could count them.
          taskApproval: n(mine.data?.taskApproval),
        };
        Object.keys(EMPTY).forEach((k) => { if (!PERSONAL.includes(k)) next[k] = n(d[k]); });
        set({ counts: next });
        lastAt = Date.now();
      } catch {
        /* ignore — a badge is never worth an error on screen */
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },

  /** Back to zero on sign-out, so the next account never sees the last one's. */
  reset: () => {
    lastAt = 0;
    set({ counts: EMPTY });
  },
}));
