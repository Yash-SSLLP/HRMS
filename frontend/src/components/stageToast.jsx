/**
 * Confirmation for a hiring-stage move, with the way through to the next stage.
 *
 * Each step of the pipeline lives on its own page and filters to its own stage,
 * so advancing a candidate makes them vanish from the screen HR is looking at —
 * Recruitment → Onboarding → New Joinees → an employee record. That read as
 * "the row disappeared" rather than "the step worked", and left HR to find the
 * next page themselves.
 *
 * One toast, bottom-right (deliberately away from the list being worked on, and
 * away from the top-right toasts the rest of the app uses for errors), naming
 * what happened and linking to where that candidate now is. Destinations carry
 * `?candidate=<id>`, which their pages use to scroll to and highlight the row.
 *
 * @param {string} title - what happened, naming the candidate
 * @param {string} [detail] - one line on what is handled at the destination
 * @param {string} [to] - router path for the follow-on link
 * @param {string} [linkLabel='Open'] - link text (an arrow is appended)
 */
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'react-toastify';

export default function stageToast({ title, detail, to, linkLabel = 'Open' }) {
  return toast.success(
    ({ closeToast }) => (
      <div>
        <div className="font-semibold">{title}</div>
        {detail && <div className="text-xs mt-0.5 opacity-90">{detail}</div>}
        {to && (
          <Link to={to} onClick={closeToast} className="inline-block mt-1.5 text-xs font-semibold underline">
            {linkLabel} →
          </Link>
        )}
      </div>
    ),
    // Longer than the default 4s: this one carries an action to read and click.
    { position: 'bottom-right', autoClose: 8000 },
  );
}

/**
 * The `?candidate=<id>` arrival behaviour, shared by every destination page:
 * scroll that candidate's row into view, ring it briefly, then drop the param
 * so a later refresh doesn't re-trigger the highlight.
 *
 * Give each row `id={`${prefix}-${c._id}`}` and ring the returned id.
 *
 * @param {string} prefix - DOM id prefix used on the rows (e.g. 'onb')
 * @param {{_id: string}[]} rows - the rows currently rendered
 * @param {boolean} loading - true while rows are still being fetched
 * @returns {string|null} the candidate id to highlight right now
 */
export function useCandidateArrival(prefix, rows, loading) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [highlighted, setHighlighted] = useState(null);

  useEffect(() => {
    const id = searchParams.get('candidate');
    if (!id || loading || !rows.some((c) => c._id === id)) return undefined;
    const el = document.getElementById(`${prefix}-${id}`);
    if (!el) return undefined;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlighted(id);
    const t = setTimeout(() => {
      setHighlighted(null);
      setSearchParams({}, { replace: true });
    }, 2600);
    return () => clearTimeout(t);
  }, [prefix, rows, loading, searchParams, setSearchParams]);

  return highlighted;
}

/** Ring applied to the row a candidate link just landed on. */
export const arrivalRing = 'ring-2 ring-green-400 ring-offset-2';
