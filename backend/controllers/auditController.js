/**
 * Audit controller — the portal-wide status-change AuditLog: reading it back
 * (filtered by entity/actor/text/date) and, for the SuperAdmin, deleting entries
 * from it permanently. Non-SuperAdmin viewers have all SuperAdmin activity
 * redacted so the SuperAdmin account stays invisible.
 */
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const {
  moduleInfo, describe, badgeFor, fieldLabel, valueText, resolveUnknownTypes, findRecord, summarizeRecord,
} = require('../services/auditDescribe');
const { istDateString, istDayRange } = require('../utils/istDate');

const badRequest = (message, status = 400) => Object.assign(new Error(message), { status });

// The screen's filters, by the names both the query string and a purge body use.
const FILTER_KEYS = ['entity', 'by', 'q', 'from', 'to'];

// One "delete selected" may name at most this many entries. The screen never
// holds more than 500 (listAudit's cap), so this is headroom rather than a limit
// anyone meets — it only stops a runaway body from building a giant $in.
const MAX_IDS = 1000;

/**
 * Read the audit filters off a query string or a request body, as trimmed strings.
 *
 * A malformed value is REFUSED, never skipped. For a list, skipping one would only
 * show too much; for a purge it would delete too much — an `entity` arriving as an
 * array and quietly dropped turns "delete this module's entries" into "delete every
 * module's". So anything that is not a plain string (including `?entity[$ne]=x`,
 * which would otherwise reach Mongo as an operator) is a 400.
 * @param {Object} source - req.query or req.body
 * @returns {{entity?: string, by?: string, q?: string, from?: string, to?: string}}
 * @throws {Error} 400 on a non-string value, a bad actor id or an unreadable date
 */
function readFilters(source = {}) {
  const out = {};
  for (const key of FILTER_KEYS) {
    const value = source[key];
    if (value == null || value === '') continue;
    if (typeof value !== 'string') throw badRequest(`Invalid "${key}" filter`);
    if (value.trim()) out[key] = value.trim();
  }
  if (out.by && !mongoose.isObjectIdOrHexString(out.by)) throw badRequest('Invalid "by" filter');
  for (const key of ['from', 'to']) {
    if (out[key] && Number.isNaN(new Date(out[key]).getTime())) throw badRequest(`Invalid "${key}" date`);
  }
  return out;
}

/**
 * The Mongo filter for a set of audit filters. The list, the count and the purge
 * all build theirs here, so "delete everything matching" can never match a
 * different set of rows from the one the screen was showing.
 * @param {{entity?: string, by?: string, q?: string, from?: string, to?: string}} filters - from readFilters
 * @param {Object} viewer - req.user
 * @returns {Object}
 */
function buildFilter({ entity, by, q, from, to }, viewer) {
  const filter = {};
  if (entity) filter.entity = entity;
  if (by) filter.by = by;
  if (from || to) {
    filter.at = {};
    // A plain 'YYYY-MM-DD' is an IST calendar day — its own midnight to
    // midnight, whatever zone the server runs in (a UTC server read "from 2 Oct"
    // as 5:30 AM IST and lost the night before it).
    const day = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
    if (from) filter.at.$gte = day(from) ? istDayRange(from)[0] : new Date(from);
    if (to) {
      if (day(to)) filter.at.$lte = istDayRange(to)[1];
      else { const d = new Date(to); d.setHours(23, 59, 59, 999); filter.at.$lte = d; }
    }
  }
  if (q) {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ entityLabel: re }, { byName: re }, { toStatus: re }, { fromStatus: re }];
  }
  // Non-SuperAdmin viewers must never learn a SuperAdmin account exists: hide
  // entries performed by a SuperAdmin and any role change to/from SuperAdmin.
  if (viewer?.role !== 'SuperAdmin') {
    filter.byRole = { $ne: 'SuperAdmin' };
    filter.fromStatus = { $ne: 'SuperAdmin' };
    filter.toStatus = { $ne: 'SuperAdmin' };
  }
  return filter;
}

/**
 * Narrow a filter to entries written at or before `asOf` (keeping an earlier
 * `to` date if the filter already has one).
 * @param {Object} filter - from buildFilter; mutated
 * @param {Date} asOf
 */
function capAt(filter, asOf) {
  filter.at = filter.at || {};
  if (!filter.at.$lte || filter.at.$lte > asOf) filter.at.$lte = asOf;
}

/**
 * List audit-log entries with optional filters (SuperAdmin).
 * @route GET /api/audit
 * @param {string} [req.query.entity] - filter by entity type
 * @param {string} [req.query.by] - filter by actor user id
 * @param {string} [req.query.q] - case-insensitive text across label/name/status
 * @param {string} [req.query.from] - start date (inclusive)
 * @param {string} [req.query.to] - end date (inclusive, end-of-day)
 * @param {number} [req.query.limit] - max rows, capped at 500 (default 200)
 * @param {string} [req.query.stats] - '1' adds the whole log's headline counts
 * @returns {{count: number, items: Object[], entities: string[], modules: Object[], stats?: Object}}
 *   each item also carries `moduleLabel`, `summary` (one sentence) and, when its
 *   record turned out to be of another type than the row says, `resolvedType`
 */
const listAudit = asyncHandler(async (req, res) => {
  const filter = buildFilter(readFilters(req.query), req.user);
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const [items, entities, stats] = await Promise.all([
    AuditLog.find(filter).sort({ at: -1 }).limit(limit).lean(),
    AuditLog.distinct('entity'),
    req.query.stats === '1' ? headlineCounts(req.user) : null,
  ]);
  // Best-effort: a failed look-up only means the row is described by its own name.
  const types = await resolveUnknownTypes(items).catch(() => new Map());
  const modules = entities.map((value) => {
    const m = moduleInfo(value);
    return { value, label: m.label, known: m.known };
  }).sort((a, b) => a.label.localeCompare(b.label));
  res.json({
    count: items.length,
    items: items.map((e) => withWords(e, types.get(String(e.entityId)))),
    entities: entities.sort(),
    modules,
    ...(stats ? { stats } : {}),
  });
});

/**
 * A row plus the words to show it with: the module's name, what the record
 * really is (when the row's own name is not one this portal writes) and one
 * sentence saying what happened.
 * @param {Object} e - lean AuditLog row
 * @param {string} [foundType] - the model its record was found in
 * @returns {Object}
 */
function withWords(e, foundType) {
  const logged = moduleInfo(e.entity);
  // Looked up per record id, so a row whose OWN name is that type gets it back
  // too — only a different type is a resolution.
  const resolvedType = foundType && foundType !== (logged.model || logged.key) && foundType !== e.entity ? foundType : undefined;
  const actual = resolvedType ? moduleInfo(resolvedType) : null;
  return {
    ...e,
    moduleLabel: (actual && actual.known ? actual : logged).label,
    moduleKnown: logged.known,
    ...(resolvedType ? { resolvedType } : {}),
    summary: describe(e, resolvedType),
    badge: badgeFor(e, resolvedType),
    fieldLabel: fieldLabel(e),
    fromText: valueText(e.fromStatus, e.field),
    toText: valueText(e.toStatus, e.field),
  };
}

/**
 * The whole log at a glance: entries in all, today (IST), the last 7 days, and
 * how many people made them this week. Counted under the viewer's redaction.
 * @param {Object} viewer - req.user
 * @returns {Promise<{total: number, today: number, week: number, people: number}>}
 */
async function headlineCounts(viewer) {
  const base = buildFilter({}, viewer);
  const [dayStart] = istDayRange(istDateString());
  const weekStart = new Date(dayStart.getTime() - 6 * 86400000);
  const [total, today, week, people] = await Promise.all([
    AuditLog.countDocuments(base),
    AuditLog.countDocuments({ ...base, at: { $gte: dayStart } }),
    AuditLog.countDocuments({ ...base, at: { $gte: weekStart } }),
    AuditLog.distinct('byName', { ...base, at: { $gte: weekStart } }),
  ]);
  return { total, today, week, people: people.filter(Boolean).length };
}

/**
 * Everything about one entry, for the Details panel: the entry in words, the
 * record it points at (found by id, wherever it lives, summarised without
 * sensitive fields), the record's whole logged history, and who made the change.
 * @route GET /api/audit/:id
 * @returns {{entry, module, record, history, actor}}
 */
const getAuditDetails = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isObjectIdOrHexString(id)) throw badRequest('Invalid entry id');
  const redaction = buildFilter({}, req.user);
  const entry = await AuditLog.findOne({ ...redaction, _id: id }).lean();
  if (!entry) throw badRequest('That entry is no longer in the audit log — it may have been deleted.', 404);

  const logged = moduleInfo(entry.entity);
  const found = await findRecord(entry).catch(() => ({ type: null, collection: null, doc: null, viaModel: false }));
  const ownType = logged.model || logged.key;
  // Only call it something else when the record really is something else.
  const resolvedType = found.type && found.type !== ownType && found.type !== entry.entity ? found.type : null;
  const actual = moduleInfo(found.type || resolvedType || entry.entity);

  const [fields, historyRows, actor] = await Promise.all([
    summarizeRecord(found.type, found.doc).catch(() => []),
    // The latest 100, shown oldest first — so a record with a long past still
    // shows the entry being looked at.
    entry.entityId
      ? AuditLog.find({ ...redaction, entityId: entry.entityId }).sort({ at: -1 }).limit(100).lean().then((rows) => rows.reverse())
      : [entry],
    entry.by && mongoose.isValidObjectId(entry.by)
      ? User.findById(entry.by).select('firstName lastName role isActive').lean().catch(() => null)
      : null,
  ]);

  res.json({
    entry: withWords(entry, resolvedType),
    module: {
      loggedAs: entry.entity,
      label: logged.label,
      known: logged.known,
      link: (actual.known && actual.link) || logged.link || null,
      // What this kind of record is, for a module whose statuses do not speak for themselves.
      about: (actual.known && actual.about) || logged.about || null,
    },
    record: {
      found: !!found.doc,
      type: found.type,
      typeLabel: found.type ? moduleInfo(found.type).label : null,
      typeNoun: found.type ? moduleInfo(found.type).noun : null,
      collection: found.collection,
      // In this database but in no model this portal has — a sibling app's record.
      otherApp: !!found.doc && !found.viaModel,
      fields,
    },
    history: historyRows.map((h) => ({
      _id: h._id,
      at: h.at,
      byName: h.byName,
      byRole: h.byRole,
      field: h.field,
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      summary: describe(h, resolvedType),
      badge: badgeFor(h, resolvedType),
      current: String(h._id) === String(entry._id),
    })),
    actor: actor ? {
      name: `${actor.firstName || ''} ${actor.lastName || ''}`.trim(),
      role: actor.role,
      active: actor.isActive !== false,
    } : null,
  });
});

/**
 * How many entries the filters match right now — the list stops at 500, so the
 * "delete everything matching" confirmation asks here for the real number.
 * @route GET /api/audit/count
 * @param {string} [req.query.entity|by|q|from|to] - same filters as the list
 * @returns {{count: number, asOf: Date}} `asOf` is the moment counted; the purge
 *   takes it back as its cut-off so it deletes exactly what was counted.
 */
const countAudit = asyncHandler(async (req, res) => {
  const asOf = new Date();
  const filter = buildFilter(readFilters(req.query), req.user);
  capAt(filter, asOf);
  res.json({ count: await AuditLog.countDocuments(filter), asOf });
});

/**
 * Permanently delete the chosen entries. There is no bin: a deleted entry is gone
 * from the Audit Log and from any status history built from it (expense-claim
 * "History", the rest-day decision trail).
 * @route POST /api/audit/delete
 * @param {string[]} req.body.ids - AuditLog ids, 1..MAX_IDS
 * @returns {{deleted: number}}
 */
const deleteAuditEntries = asyncHandler(async (req, res) => {
  const raw = req.body?.ids;
  if (!Array.isArray(raw) || raw.length === 0) throw badRequest('Pick at least one entry to delete');
  if (raw.length > MAX_IDS) throw badRequest(`Delete at most ${MAX_IDS} entries at a time`);
  const ids = [...new Set(raw.map(String))];
  if (ids.some((id) => !mongoose.isObjectIdOrHexString(id))) throw badRequest('Invalid entry id');
  const { deletedCount } = await AuditLog.deleteMany({ _id: { $in: ids } });
  res.json({ deleted: deletedCount });
});

/**
 * Permanently delete EVERY entry matching the filters — not just the page on
 * screen. With no filters at all this empties the whole log, so that case must be
 * asked for in so many words (`everything: true`): a request that merely lost its
 * filters on the way must not be able to wipe the table.
 * @route POST /api/audit/purge
 * @param {string} [req.body.entity|by|q|from|to] - same filters as the list
 * @param {string} [req.body.asOf] - from GET /count; nothing written after it is touched
 * @param {boolean} [req.body.everything] - required when no filter is given
 * @returns {{deleted: number}}
 */
const purgeAudit = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const filters = readFilters(body);
  if (!Object.keys(filters).length && body.everything !== true) {
    throw badRequest('No filters were given — confirm that the whole audit log should be deleted');
  }
  const filter = buildFilter(filters, req.user);
  // The log keeps growing while the confirmation is open; "Delete 1,204 entries"
  // must not also take the ones written since the count.
  if (body.asOf != null && body.asOf !== '') {
    const asOf = new Date(body.asOf);
    if (Number.isNaN(asOf.getTime())) throw badRequest('Invalid "asOf" time');
    capAt(filter, asOf);
  }
  const { deletedCount } = await AuditLog.deleteMany(filter);
  res.json({ deleted: deletedCount });
});

module.exports = {
  listAudit, countAudit, getAuditDetails, deleteAuditEntries, purgeAudit,
};
