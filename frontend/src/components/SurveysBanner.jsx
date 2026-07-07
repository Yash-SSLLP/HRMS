import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FiClipboard } from 'react-icons/fi';
import api from '../api/client';
import SurveyRespondModal from './SurveyRespondModal';

// A poll is really just a short survey (a single choice question); label it as
// such so the "Surveys & Polls" framing reads right.
const labelOf = (s) => {
  const qs = s.questions || [];
  return qs.length === 1 && qs[0].type !== 'text' ? 'Poll' : 'Survey';
};

// Surfaces every survey/poll the employee hasn't answered yet, on the overview
// page — right alongside the announcements banner — so they don't get missed.
export default function SurveysBanner() {
  const [items, setItems] = useState([]);
  const [active, setActive] = useState(null);

  useEffect(() => {
    api.get('/surveys')
      .then(({ data }) => setItems((data.surveys || []).filter((s) => !s.answered)))
      .catch(() => {});
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="mb-4 space-y-2">
      {items.map((s) => {
        const tag = labelOf(s);
        const qCount = (s.questions || []).length;
        return (
          <div key={s._id} className="bg-white shadow rounded-lg p-4 border-l-4" style={{ borderLeftColor: '#8b5cf6' }}>
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <FiClipboard className="text-violet-500 shrink-0" size={15} />
              <span className="font-semibold text-gray-900">{s.title}</span>
              <span className="text-[10px] font-medium rounded-full px-2 py-0.5 bg-violet-100 text-violet-800">{tag}</span>
            </div>
            {s.description && <p className="text-sm text-gray-700 whitespace-pre-wrap">{s.description}</p>}
            <div className="flex items-center justify-between gap-3 mt-2">
              <span className="text-xs text-gray-400">
                {qCount} question{qCount === 1 ? '' : 's'}{s.anonymous ? ' · anonymous' : ''}
              </span>
              <button type="button" onClick={() => setActive(s)}
                className="shrink-0 px-3 py-1.5 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">
                Respond →
              </button>
            </div>
          </div>
        );
      })}
      <div className="text-right">
        <Link to="/employee/surveys" className="text-xs text-blue-600 hover:underline">All surveys &amp; polls →</Link>
      </div>

      {active && (
        <SurveyRespondModal
          survey={active}
          onClose={() => setActive(null)}
          onDone={() => { const id = active._id; setActive(null); setItems((list) => list.filter((x) => x._id !== id)); }}
        />
      )}
    </div>
  );
}
