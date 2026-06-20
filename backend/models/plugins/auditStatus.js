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
 */
module.exports = function auditStatus(schema, options = {}) {
  const fields = options.fields || ['status'];

  const labelOf = (doc) => {
    try {
      if (typeof options.label === 'function') return options.label(doc);
      if (typeof options.label === 'string') return doc[options.label];
      return doc.name || doc.title || undefined;
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

  const logChange = (model, doc, field, from, to) => {
    if (from === to) return;
    if (from === undefined && (to === undefined || to === null || to === '')) return;
    const user = currentUser();
    writeLog({
      entity: entityName(model),
      entityId: doc?._id,
      entityLabel: labelOf(doc),
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
      for (const c of changes) logChange(doc.constructor, doc, c.field, c.from, c.to);
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
        .select([...fields, 'name', 'title'].join(' '))
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
        logChange(this.model, before, f, before[f], set[f]);
      }
    } catch (_) { /* ignore */ }
  });
};
