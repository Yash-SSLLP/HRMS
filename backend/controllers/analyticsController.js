const asyncHandler = require('express-async-handler');
const EmployeeProfile = require('../models/EmployeeProfile');

// Buckets an employee's tenure (years since dateOfJoining) into a band label.
function tenureBucket(years) {
  if (years < 1) return '<1y';
  if (years < 3) return '1-3y';
  if (years < 5) return '3-5y';
  return '5y+';
}

// GET /api/analytics/overview
// Org-wide HR analytics derived entirely from EmployeeProfile documents.
// Admin-only (SuperAdmin / HRManager). Read-only — no data is mutated.
const overview = asyncHandler(async (req, res) => {
  const now = new Date();
  // Window start = 12 months ago from "now".
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

  const profiles = await EmployeeProfile.find({})
    .select(
      'gender dateOfJoining dateOfExit department employmentType confirmationStatus'
    )
    .lean();

  // --- Active set (no exit date) ---
  const active = profiles.filter((p) => !p.dateOfExit);
  const totalActive = active.length;

  // --- Headcount by department (active, sorted desc) ---
  const deptCounts = {};
  for (const p of active) {
    const key = p.department || 'Unassigned';
    deptCounts[key] = (deptCounts[key] || 0) + 1;
  }
  const headcountByDepartment = Object.entries(deptCounts)
    .map(([department, count]) => ({ department, count }))
    .sort((a, b) => b.count - a.count);

  // --- Headcount by employment type (active) ---
  const typeCounts = {};
  for (const p of active) {
    const key = p.employmentType || 'Unspecified';
    typeCounts[key] = (typeCounts[key] || 0) + 1;
  }
  const headcountByEmploymentType = Object.entries(typeCounts)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  // --- Gender diversity (active; missing bucketed as 'Unspecified') ---
  const genderCounts = {};
  for (const p of active) {
    const key = p.gender || 'Unspecified';
    genderCounts[key] = (genderCounts[key] || 0) + 1;
  }
  const genderDiversity = Object.entries(genderCounts)
    .map(([gender, count]) => ({ gender, count }))
    .sort((a, b) => b.count - a.count);

  // --- Tenure buckets (active, from dateOfJoining) ---
  const tenureCounts = { '<1y': 0, '1-3y': 0, '3-5y': 0, '5y+': 0 };
  for (const p of active) {
    if (!p.dateOfJoining) continue;
    const years = (now - new Date(p.dateOfJoining)) / (365.25 * 24 * 60 * 60 * 1000);
    tenureCounts[tenureBucket(years)] += 1;
  }
  const tenureBuckets = Object.entries(tenureCounts).map(([bucket, count]) => ({
    bucket,
    count,
  }));

  // --- Confirmation breakdown (active) ---
  const confirmCounts = {};
  for (const p of active) {
    const key = p.confirmationStatus || 'Unspecified';
    confirmCounts[key] = (confirmCounts[key] || 0) + 1;
  }
  const confirmationBreakdown = Object.entries(confirmCounts)
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);

  // --- Attrition: exits in the last 12 months grouped by YYYY-MM ---
  // Seed the last 12 month buckets (oldest -> newest) so the chart is contiguous.
  const monthKeys = [];
  const exitsByMonthMap = {};
  const hiresByMonthMap = {};
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    monthKeys.push(key);
    exitsByMonthMap[key] = 0;
    hiresByMonthMap[key] = 0;
  }

  let exitsLast12mo = 0;
  for (const p of profiles) {
    if (!p.dateOfExit) continue;
    const exit = new Date(p.dateOfExit);
    if (exit >= twelveMonthsAgo && exit <= now) {
      exitsLast12mo += 1;
      const key = `${exit.getFullYear()}-${String(exit.getMonth() + 1).padStart(2, '0')}`;
      if (key in exitsByMonthMap) exitsByMonthMap[key] += 1;
    }
  }
  const exitsByMonth = monthKeys.map((month) => ({
    month,
    count: exitsByMonthMap[month],
  }));

  // --- Attrition rate (%) ---
  // Simple formula: exits in the last 12 months divided by the average
  // headcount over the period, expressed as a percentage. We approximate the
  // average headcount as (current active headcount + exits in the period),
  // i.e. the population that was "at risk" of leaving during the window.
  //   attritionRate = exitsLast12mo / max(1, avgHeadcount) * 100
  const avgHeadcount = totalActive + exitsLast12mo;
  const attritionRate = Math.round((exitsLast12mo / Math.max(1, avgHeadcount)) * 100 * 10) / 10;

  // --- New hires in the last 12 months (total + by YYYY-MM) ---
  let newHiresLast12mo = 0;
  for (const p of profiles) {
    if (!p.dateOfJoining) continue;
    const join = new Date(p.dateOfJoining);
    if (join >= twelveMonthsAgo && join <= now) {
      newHiresLast12mo += 1;
      const key = `${join.getFullYear()}-${String(join.getMonth() + 1).padStart(2, '0')}`;
      if (key in hiresByMonthMap) hiresByMonthMap[key] += 1;
    }
  }
  const hiresByMonth = monthKeys.map((month) => ({ month, count: hiresByMonthMap[month] }));

  res.json({
    totalActive,
    headcountByDepartment,
    headcountByEmploymentType,
    genderDiversity,
    tenureBuckets,
    confirmationBreakdown,
    exitsByMonth,
    exitsLast12mo,
    attritionRate,
    newHiresLast12mo,
    hiresByMonth,
  });
});

module.exports = { overview };
