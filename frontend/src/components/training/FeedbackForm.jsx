/**
 * "How clear was the training?" — the review every participant is asked for
 * once a session is over. Clarity is the one required answer; usefulness, the
 * trainer and a comment are optional. Saving again replaces the earlier answers.
 */
import { useState } from 'react';
import { toast } from 'react-toastify';
import { FiStar, FiSend } from 'react-icons/fi';
import api from '../../api/client';
import { FEEDBACK_QUESTIONS, RATING_WORDS } from './trainingUtil';

function StarInput({ value, onChange, label }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return (
    <div className="trn-star-btns" role="radiogroup" aria-label={label} onMouseLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} — ${RATING_WORDS.clarity[n - 1]}`}
          className={`trn-star-btn ${n <= shown ? 'is-on' : ''}`}
          onMouseEnter={() => setHover(n)}
          onClick={() => onChange(value === n ? 0 : n)}
        >
          <FiStar size={24} fill={n <= shown ? 'currentColor' : 'none'} />
        </button>
      ))}
    </div>
  );
}

export default function FeedbackForm({ training, onSaved, onCancel, submitLabel }) {
  const prev = training.myFeedback || {};
  const [ans, setAns] = useState({
    clarity: prev.clarity || 0,
    usefulness: prev.usefulness || 0,
    trainerRating: prev.trainerRating || 0,
    comment: prev.comment || '',
  });
  const [saving, setSaving] = useState(false);
  const questions = FEEDBACK_QUESTIONS.filter((q) => q.key !== 'trainerRating' || training.trainer);

  const submit = async (e) => {
    e.preventDefault();
    if (!ans.clarity) { toast.error('Tap a star to say how clear it was.'); return; }
    setSaving(true);
    try {
      const { data } = await api.post(`/training/${training._id}/feedback`, {
        clarity: ans.clarity,
        usefulness: ans.usefulness || null,
        trainerRating: ans.trainerRating || null,
        comment: ans.comment.trim(),
      });
      toast.success(prev.clarity ? 'Review updated — thank you' : 'Thanks for the review!');
      onSaved?.(data.myFeedback);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save your review');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="trn-rate">
        {questions.map((q) => (
          <div key={q.key} className="trn-rate-row">
            <div className="min-w-0">
              <div className="trn-rate-q text-gray-900">{q.label}{q.required && <span className="text-red-600"> *</span>}</div>
              {q.key === 'trainerRating' && <div className="text-xs text-gray-500">{training.trainer}</div>}
            </div>
            <div className="flex items-center gap-2">
              <StarInput value={ans[q.key]} label={q.label} onChange={(v) => setAns((a) => ({ ...a, [q.key]: v }))} />
              <span className="trn-rate-word">{ans[q.key] ? RATING_WORDS[q.key][ans[q.key] - 1] : ''}</span>
            </div>
          </div>
        ))}
      </div>
      <textarea
        className="trn-input text-gray-900 mt-2"
        rows={3}
        maxLength={2000}
        value={ans.comment}
        onChange={(e) => setAns((a) => ({ ...a, comment: e.target.value }))}
        placeholder="Anything that was not clear, or would make the next session better? (optional)"
      />
      <div className="flex flex-wrap items-center justify-between gap-2 mt-3">
        <span className="text-xs text-gray-500">Shared with the training team, with your name.</span>
        <div className="flex gap-2 ml-auto">
          {onCancel && <button type="button" className="trn-btn" onClick={onCancel} disabled={saving}>Cancel</button>}
          <button type="submit" className="trn-btn is-primary accent-bg on-accent" disabled={saving || !ans.clarity}>
            <FiSend size={14} /> {saving ? 'Sending…' : (submitLabel || (prev.clarity ? 'Update review' : 'Send review'))}
          </button>
        </div>
      </div>
    </form>
  );
}
