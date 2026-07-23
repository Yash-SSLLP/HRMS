/**
 * Default "no-dues" clearance sections for an employee exit. Each section is
 * owned by a department manager who ticks off the company assets/dues handed
 * back before the login is released. HR assigns the responsible manager per
 * exit; the assigned manager (or HR) ticks their own section.
 *
 * `key` is a stable id (never shown); `title` is the role label; `department`
 * hints who should own it; `items` are the individual no-dues checks.
 *
 * Overridable per-environment via EXIT_CLEARANCE_JSON (a JSON array with the
 * same shape) without touching code.
 */
const DEFAULT_CLEARANCE_SECTIONS = [
  { key: 'it', title: 'IT Manager', department: 'IT', items: ['Mobile', 'Laptop', 'App access', 'Mail access'] },
  { key: 'hr', title: 'HR Manager', department: 'HR', items: ['Sim card taken'] },
  { key: 'accounts', title: 'Account Manager', department: 'Accounts', items: ['Advance taken', 'Any fines'] },
  { key: 'sales', title: 'Sales Manager', department: 'Sales', items: ['Samples of laminate'] },
];

function loadSections() {
  if (process.env.EXIT_CLEARANCE_JSON) {
    try {
      const parsed = JSON.parse(process.env.EXIT_CLEARANCE_JSON);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (_) {
      console.warn('EXIT_CLEARANCE_JSON is not valid JSON — using defaults.');
    }
  }
  return DEFAULT_CLEARANCE_SECTIONS;
}

// Build a fresh clearanceSections array (unticked, unassigned) for a new exit.
function buildDefaultSections() {
  return loadSections().map((s) => ({
    key: s.key,
    title: s.title,
    department: s.department || '',
    assignedTo: null,
    assignedToName: '',
    items: (s.items || []).map((label) => ({ label, done: false, note: '' })),
    completed: false,
  }));
}

module.exports = { DEFAULT_CLEARANCE_SECTIONS, buildDefaultSections, loadSections };
