// TEMPORARY dev harness (delete after verifying). Renders the REAL
// EmployeeReviews page with the axios adapter swapped for fixtures.
import { createRoot } from 'react-dom/client';
import api from './api/client';
import EmployeeReviews from './pages/EmployeeReviews';
import './index.css';

const CYCLE = { _id: 'c1', name: 'H1 2026 Appraisal', status: 'Active', competencies: ['Communication', 'Ownership', 'Technical', 'Teamwork'] };
const FIXTURES = {
  '/reviews/me/assigned': {
    count: 1,
    reviews: [{
      _id: 'r1',
      employee: { _id: 'e1', firstName: 'Ankit', lastName: 'Roy' },
      cycle: CYCLE,
      relationship: 'peer',
      status: 'Pending',
      ratings: CYCLE.competencies.map((c) => ({ competency: c, comment: '' })),
    }],
  },
  '/reviews/me/about': { count: 0, reviews: [] },
};

window.__requests = [];
api.defaults.adapter = async (config) => {
  window.__requests.push({ method: config.method, url: config.url, body: config.data ? JSON.parse(config.data) : null });
  return { data: FIXTURES[config.url] || {}, status: 200, statusText: 'OK', headers: {}, config };
};

// Record every repaint of the first star row so a real-mouse sweep can be
// replayed afterwards: [time, filledCount, label].
window.__trace = [];
const observe = () => {
  const row = document.querySelector('.rating-card .flex.items-center.gap-0\\.5');
  if (!row) return setTimeout(observe, 200);
  const snap = () => {
    const filled = [...row.querySelectorAll('.star-btn')].filter((b) => b.classList.contains('is-on')).length;
    const last = window.__trace[window.__trace.length - 1];
    if (!last || last[1] !== filled) window.__trace.push([Math.round(performance.now()), filled]);
  };
  new MutationObserver(snap).observe(row, { attributes: true, subtree: true, attributeFilter: ['class'] });
  snap();
};
observe();

document.documentElement.classList.add('dark');
document.documentElement.setAttribute('data-role', 'Employee');
document.documentElement.setAttribute('data-portal', 'employee');

createRoot(document.getElementById('root')).render(
  <div className="p-6"><EmployeeReviews /></div>
);
