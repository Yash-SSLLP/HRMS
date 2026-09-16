/**
 * The BILLING incentive tab — Incentive ▸ Billing Incentive.
 *
 * The billing team is paid on what it invoices, and that is counted in the
 * billing system rather than here. This tab is a WINDOW onto those figures,
 * joined to the portal's own idea of who each person is: the billing system
 * supplies the name, the SSL code and the points; the portal supplies the
 * department and the designation, which it is the system of record for.
 *
 * NOTHING IS STORED. Every figure is fetched live (services/billingIncentive.js
 * explains what that costs and how the cache pays for it). There is no import,
 * no correction and no delete here, and that is deliberate: a wrong figure is
 * wrong in the billing system, and fixing it in two places means it is right in
 * neither. The one write on the whole tab is Refresh, which throws the cache
 * away and asks again.
 *
 * WHAT MAKES IT THE SAME MODULE AS THE OTHERS: billing points go into the ONE
 * company-wide pool, exactly as rolled points and credited points do. They show
 * on the Points Dashboard, they count on every leaderboard, and they are settled
 * through the same payments (see the note on the pool in incentiveController).
 * What one point is worth is the single company figure on the Point Rate tab —
 * ₹0.25, which is the billing system's own four-points-to-the-rupee.
 *
 * PEOPLE THE PORTAL CANNOT PLACE are never silently dropped. A billing row whose
 * SSL code nobody holds, or that has no code at all, comes back in `unmatched`
 * with its points and a suggested match, so the total on screen can always be
 * reconciled against the billing system's own. That is the same bargain the
 * employee import makes: never fail on a name we do not know, flag it for
 * somebody to correct at source.
 *
 * Gating lives in routes/incentiveRoutes.js — a role in the `billing` module
 * (config/incentiveRoles.js), with HR, CEO, MD and SuperAdmin managers by role.
 */
const asyncHandler = require('express-async-handler');
const billing = require('../services/billingIncentive');
const { canManageIncentive } = require('../middleware/authMiddleware');
// The points pool's own arithmetic — whose roster to resolve codes against, and
// what each person has already redeemed. Imported rather than reimplemented so
// this tab and the Points Dashboard can never disagree about either. The import
// is one-way: incentiveController knows nothing about this file.
const { peopleIncludingLeavers, lifetimePaidByEmployee } = require('./incentiveController');

/** Points read back without float dust. */
const paise = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** "Ramesh Kumar" from a populated profile. */
const fullName = (p) => `${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim();

/** 'YYYY-MM' for now, in local time. */
const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/** The month asked for, or this one. */
const askedMonth = (query) => (/^\d{4}-\d{2}$/.test(String(query.month || '')) ? String(query.month) : thisMonth());

/**
 * One month of billing, per person, joined to the portal's records.
 *
 * The tab's main read. The month is the unit the billing system settles in, so
 * it is the unit the screen shows; the LIFETIME figures that the leaderboards
 * rank on are fetched alongside it, because "what have I earned altogether" is
 * the question anybody looking at one month immediately asks next.
 *
 * @route GET /api/incentives/billing?month=YYYY-MM&q=&refresh=true
 * @returns {{configured: boolean, month: string, months: string[], source: string,
 *   generatedAt: string|null, people: Object[], unmatched: Object[],
 *   failed: Object[], totals: object, can: object}}
 */
const board = asyncHandler(async (req, res) => {
  const month = askedMonth(req.query);
  // `refresh=true` is a READ that skips the cache, not a write — a manager
  // pressing Refresh and a viewer reloading want the same thing, and neither
  // changes anything at the billing end.
  const force = String(req.query.refresh || '') === 'true';

  if (!billing.isConfigured()) {
    return res.json({
      configured: false,
      month,
      months: [],
      source: '',
      generatedAt: null,
      people: [],
      unmatched: [],
      failed: [],
      totals: {
        people: 0, earners: 0, points: 0, placedPoints: 0, lifetimePoints: 0, units: 0,
        unmatchedPoints: 0, billingSystemPoints: 0,
      },
      can: { refresh: false },
    });
  }

  const [roster, monthData, life] = await Promise.all([
    peopleIncludingLeavers(req),
    billing.monthByCode(month, { force }),
    billing.lifetimeByCode({ force }),
  ]);

  const join = billing.attachToRoster(life.byCode, roster, life.codeless);
  const monthJoin = billing.attachToRoster(monthData.byCode, roster, monthData.codeless);

  // What each person has been handed already, over all time — the other half of
  // "current points". Payments are per month, so a lifetime figure is every row.
  const paid = await lifetimePaidByEmployee(req);

  const codeOf = (p) => billing.normaliseCode(p.employeeCode);
  const people = roster
    .filter((p) => life.byCode.has(codeOf(p)) || monthData.byCode.has(codeOf(p)))
    .map((p) => {
      const id = String(p._id);
      const m = monthData.byCode.get(codeOf(p)) || null;
      const totalPoints = paise(join.byEmployee.get(id) || 0);
      const paidPoints = paise(paid.get(id) || 0);
      return {
        employee: id,
        name: fullName(p),
        employeeCode: p.employeeCode || '',
        department: p.department || '',
        designation: p.designation || '',
        left: !!p.left,
        // This month, straight from the billing system — the working behind the
        // points, which is the whole reason this tab exists rather than just a
        // column on the leaderboard.
        units: m?.units || 0,
        lines: m?.lines || 0,
        invoices: m?.invoices || 0,
        average: m?.average || 0,
        target: m?.target || 0,
        band: m?.band || '',
        calculation: m?.calculation || '',
        grossPoints: m?.grossPoints || 0,
        points: m?.points || 0,
        // The two figures every leaderboard in the portal now ranks and reads on.
        totalPoints,
        currentPoints: paise(totalPoints - paidPoints),
        paidPoints,
      };
    });

  // Most points this month first; somebody with nothing this month but a
  // lifetime total still belongs on the list, below them.
  people.sort((a, b) => b.points - a.points || b.totalPoints - a.totalPoints
    || String(a.name).localeCompare(String(b.name)));

  const q = String(req.query.q || '').trim().toLowerCase();
  const shown = q
    ? people.filter((p) => `${p.name} ${p.employeeCode} ${p.department} ${p.designation}`.toLowerCase().includes(q))
    : people;

  res.json({
    configured: true,
    month,
    // Every month the billing system has, so the picker cannot offer one that
    // answers empty.
    months: billing.monthsUpTo(),
    source: monthData.month?.source || '',
    generatedAt: monthData.month?.generatedAt || null,
    people: shown,
    // BOTH sets of flags, kept apart: a code the portal cannot place THIS MONTH
    // is the thing to fix now; the lifetime list is what the totals column is
    // missing. They are usually the same people.
    unmatched: monthJoin.unmatched,
    unmatchedLifetime: join.unmatched,
    // Months the billing system could not be read for. The totals are short by
    // whatever these hold, and the screen says so rather than quietly showing a
    // smaller number.
    failed: [...monthData.failed, ...life.failed],
    totals: {
      people: shown.length,
      earners: shown.filter((p) => p.points > 0).length,
      // The rows ON SCREEN — narrowed by ?q= like everything else in `shown`.
      points: paise(shown.reduce((s, p) => s + p.points, 0)),
      units: shown.reduce((s, p) => s + p.units, 0),
      lifetimePoints: paise(shown.reduce((s, p) => s + p.totalPoints, 0)),
      currentPoints: paise(shown.reduce((s, p) => s + p.currentPoints, 0)),
      // THE SAME MONTH, UNFILTERED — everybody the portal could place, whether or
      // not a search is narrowing the table. The reconciliation below is against
      // the billing system's whole month, so it has to be compared with our whole
      // month; using the filtered figure made a screen announce a huge shortfall
      // the moment somebody typed in the search box.
      placedPoints: paise(people.reduce((s, p) => s + p.points, 0)),
      // What the billing system counted that the portal could not place. Printed
      // beside the total so the two systems can be reconciled in one glance.
      unmatchedPoints: monthJoin.unmatchedPoints,
      // The billing system's OWN total for the month, before any of our
      // matching. If this and `placedPoints + unmatchedPoints` ever disagree, the
      // join above has a bug — and the tab shows both so it would be noticed.
      billingSystemPoints: monthData.month?.totals?.points || 0,
    },
    // MANAGER, not merely anybody who may open the tab. The GET is open to any
    // role in the billing module; the refresh reaches into somebody else's
    // system, so it is gated one notch tighter on the server — and a button
    // drawn for somebody the server would refuse is a button that lies.
    can: { refresh: canManageIncentive(req.user, 'billing') },
  });
});

/**
 * Throw the cached billing answers away, so the next read goes upstream.
 *
 * The one write on the tab, and it writes nothing anywhere — it only admits that
 * what is on screen may be out of date. Manager-gated all the same: a refresh is
 * a call to somebody else's system, and a page that let anybody hammer it would
 * eventually be the reason the billing team turned the key off.
 *
 * @route POST /api/incentives/billing/refresh
 * @returns {{refreshed: boolean, months: string[]}}
 */
const refreshBoard = asyncHandler(async (req, res) => {
  billing.refresh();
  res.json({ refreshed: true, months: billing.monthsUpTo() });
});

module.exports = {
  board,
  refreshBoard,
};
