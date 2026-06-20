const asyncHandler = require('express-async-handler');
const AuditLog = require('../models/AuditLog');

// GET /api/audit — status-change history (HR / SuperAdmin only).
// Filters: entity, by (userId), q (text), from, to (dates), limit.
const listAudit = asyncHandler(async (req, res) => {
  const { entity, by, q, from, to } = req.query;
  const filter = {};
  if (entity) filter.entity = entity;
  if (by) filter.by = by;
  if (from || to) {
    filter.at = {};
    if (from) filter.at.$gte = new Date(from);
    if (to) { const d = new Date(to); d.setHours(23, 59, 59, 999); filter.at.$lte = d; }
  }
  if (q && q.trim()) {
    const re = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ entityLabel: re }, { byName: re }, { toStatus: re }, { fromStatus: re }];
  }

  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const [items, entities] = await Promise.all([
    AuditLog.find(filter).sort({ at: -1 }).limit(limit).lean(),
    AuditLog.distinct('entity'),
  ]);
  res.json({ count: items.length, items, entities: entities.sort() });
});

module.exports = { listAudit };
