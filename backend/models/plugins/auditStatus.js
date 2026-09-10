const { currentUser } = require('../../middleware/requestContext');

/**
 * Mongoose plugin that records status/stage changes to the AuditLog, attributing
 * each change to the acting user (from the request context). Covers both
 * document `save()` and `findOneAndUpdate()` paths. Everything is best-effort —
 * a failure here must never break the underlying write.
 *
 * Usage:  schema.plugin(auditStatus, { fields: ['status'], label: (d) => d.name })
 *   fields  array of watched paths (default ['status'])
 *   entity  override entity name (default = model name)
 *   label   fn(doc) => string, or a field name (default tries name/title)
 *   person  path holding the person the record is ABOUT, e.g. 'employee'. Used
 *           as the label when the record has no name of its own — see below.
 *
 * NAMING A RECORD THAT HAS NO NAME. `entityLabel` is the "Record" column of the
 * audit screen, and it is what makes a line readable: "Vikas S approved
 * Priya Sharma's leave" rather than "Vikas S approved 59487c". The default label
 * looks for `name` or `title`, which the request-shaped models — a leave, a
 * regularisation, a reimbursement, a payslip — simply do not have, so a third of
 * the trail was logging an id fragment and nothing else. Those records are all
 * ABOUT somebody, and that person is their name: hence `person`.
 *
 * It is resolved at WRITE time, not at read time, for two reasons. An audit line
 * should say what was true when it happened — a name that re-resolves years later
 * is not a record of the event — and the label is what the screen's text search
 * filters on, which a value invented during the response could never be.
 */
module.exports = function auditStatus(schema, options = {}) {
  const fields = options.fields || ['status'];

  // What this schema audits, readable back off the schema. Each model already
  // declares it right here; a tool that needs the same answer — scripts/
  // backfillAuditLabels.js does — should ask the model rather than keep a second
  // copy of the list, which is the copy that goes stale.
  schema.$auditPerson = options.person;
  schema.$auditEntity = options.entity;

  const labelOf = (doc) => {
    try {
      if (typeof options.label === 'function') return options.label(doc);
      if (typeof options.label === 'string') return doc[options.label];
      return doc.name || doc.title || undefined;
    } catch (_) { return undefined; }
  };

  /**
   * Full name of the person a record is about, or undefined.
   *
   * Follows the ref declared on the schema rather than being told what it is —
   * `employee` points at a User on some models and at an EmployeeProfile on
   * others, and a registration that had to state which would go stale silently
   * the day a model changed. An EmployeeProfile carries no name of its own, so
   * it costs one more hop to the User behind it.
   *
   * Best-effort like everything else here: a dangling ref, a deleted person or a
   * database hiccup leaves the label empty, which is what it is today anyway.
   * @param {object} doc - The document being logged; may be lean.
   * @returns {Promise<string|undefined>}
   */
  const personNameOf = async (doc) => {
    const path = options.person;
    if (!path) return undefined;
    try {
      const raw = doc?.[path] ?? (typeof doc?.get === 'function' ? doc.get(path) : undefined);
      // Populated already? Then the name is in hand and costs nothing.
      const id = raw?._id || raw;
      if (!id) return undefined;
      const mongoose = require('mongoose');
      const refName = schema.path(path)?.options?.ref;
      if (!refName) return undefined;
      let person = raw?.firstName
        ? raw
        : await mongoose.model(refName).findById(id).select('firstName lastName user').lean();
      // An EmployeeProfile is a pointer, not a person — hop once more.
      if (person && !person.firstName && person.user) {
        person = await mongoose.model('User').findById(person.user).select('firstName lastName').lean();
      }
      if (!person?.firstName) return undefined;
      return `${person.firstName} ${person.lastName || ''}`.trim();
    } catch (_) { return undefined; }
  };

  // Lazy require to avoid any load-order cycles.
  const writeLog = (entry) => {
    try {
      const AuditLog = require('../AuditLog');
      AuditLog.create(entry).catch(() => {});
    } catch (_) { /* ignore */ }
  };

  const entityName = (model) => options.entity || model?.modelName || 'Record';

  const logChange = async (model, doc, field, from, to) => {
    if (from === to) return;
    if (from === undefined && (to === undefined || to === null || to === '')) return;
    // Read the actor BEFORE the first await: currentUser() comes from an
    // AsyncLocalStorage store tied to the request, and awaiting first risks
    // logging the change with nobody attached to it.
    const user = currentUser();
    // A record's own name wins; the person it is about is the fallback, so a
    // model that later grows a title starts using it without a change here.
    const label = labelOf(doc) || await personNameOf(doc);
    writeLog({
      entity: entityName(model),
      entityId: doc?._id,
      entityLabel: label,
      field,
      fromStatus: from === undefined || from === null ? '' : String(from),
      toStatus: to === undefined || to === null ? '' : String(to),
      by: user?._id,
      byName: user?.fullName,
      byRole: user?.role,
      at: new Date(),
    });
  };

  // ---- document.save() path ----
  schema.post('init', function captureOriginal() {
    try {
      this.$locals.__auditOrig = {};
      for (const f of fields) this.$locals.__auditOrig[f] = this.get(f);
    } catch (_) { /* ignore */ }
  });

  schema.pre('save', function detectSaveChanges(next) {
    try {
      const changes = [];
      const orig = this.$locals.__auditOrig || {};
      for (const f of fields) {
        if (!this.isModified(f)) continue;
        const from = this.isNew ? undefined : orig[f];
        const to = this.get(f);
        if (from !== to) changes.push({ field: f, from, to });
      }
      this.$locals.__auditChanges = changes;
    } catch (_) { this.$locals.__auditChanges = []; }
    next();
  });

  schema.post('save', function writeSaveChanges(doc) {
    try {
      const changes = doc.$locals.__auditChanges || [];
      // Fire-and-forget, as before — the log must never delay or fail the write
      // that caused it. `logChange` became async when labels grew a lookup, so
      // the rejection has to be swallowed here or Node would take the process
      // down for an unhandled one.
      for (const c of changes) logChange(doc.constructor, doc, c.field, c.from, c.to).catch(() => {});
      // Refresh the baseline for any further saves on the same instance.
      doc.$locals.__auditOrig = doc.$locals.__auditOrig || {};
      for (const f of fields) doc.$locals.__auditOrig[f] = doc.get(f);
    } catch (_) { /* ignore */ }
  });

  // ---- findOneAndUpdate() path ----
  schema.pre('findOneAndUpdate', async function captureBeforeUpdate() {
    try {
      const update = this.getUpdate() || {};
      const set = update.$set || update;
      const touched = fields.filter((f) => set[f] !== undefined);
      if (!touched.length) return;
      this._auditBefore = await this.model.findOne(this.getQuery())
        // `person` belongs here too: without it the lean snapshot has no ref to
        // follow and this path alone would keep writing unlabelled rows.
        .select([...fields, 'name', 'title', options.person].filter(Boolean).join(' '))
        .lean();
    } catch (_) { /* ignore */ }
  });

  schema.post('findOneAndUpdate', function writeUpdateChanges() {
    try {
      const before = this._auditBefore;
      if (!before) return;
      const update = this.getUpdate() || {};
      const set = update.$set || update;
      for (const f of fields) {
        if (set[f] === undefined) continue;
        logChange(this.model, before, f, before[f], set[f]).catch(() => {});
      }
    } catch (_) { /* ignore */ }
  });
};
