/**
 * Audit controller — read-only access to the portal-wide status-change AuditLog.
 * Supports filtering by entity/actor/text/date, and redacts all SuperAdmin
 * activity for non-SuperAdmin viewers so the SuperAdmin account stays invisible.
 */
const asyncHandler = require('express-async-handler');
const AuditLog = require('../models/AuditLog');

/**
 * List audit-log entries with optional filters (HR / SuperAdmin).
 * @route GET /api/audit
 * @param {string} [req.query.entity] - filter by entity type
 * @param {string} [req.query.by] - filter by actor user id
 * @param {string} [req.query.q] - case-insensitive text across label/name/status
 * @param {string} [req.query.from] - start date (inclusive)
 * @param {string} [req.query.to] - end date (inclusive, end-of-day)
 * @param {number} [req.query.limit] - max rows, capped at 500 (default 200)
 * @returns {{count: number, items: Object[], entities: string[]}}
 */
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
  // Non-SuperAdmin viewers must never learn a SuperAdmin account exists: hide
  // entries performed by a SuperAdmin and any role change to/from SuperAdmin.
  if (req.user.role !== 'SuperAdmin') {
    filter.byRole = { $ne: 'SuperAdmin' };
    filter.fromStatus = { $ne: 'SuperAdmin' };
    filter.toStatus = { $ne: 'SuperAdmin' };
  }

  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const [items, entities] = await Promise.all([
    AuditLog.find(filter).sort({ at: -1 }).limit(limit).lean(),
    AuditLog.distinct('entity'),
  ]);
  res.json({ count: items.length, items, entities: entities.sort() });
});

module.exports = { listAudit };
