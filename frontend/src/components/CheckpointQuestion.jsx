import { useEffect, useState } from 'react';
import { fmtClock } from '../utils/checkpoints';

// The question card that covers a video when playback reaches a checkpoint.
// Used by both the in-portal player (CourseVideoPlayer) and the public one
// (PublicVideoPlayer), so the two behave identically.
//
// It is a full-bleed overlay ON TOP of the <video> on purpose: it also covers
// the native controls, so the only way on is through the question.
//
// Props:
//   checkpoint — { _id, question, type, options:[{text}], graded, requireCorrect }
//   onSubmit(payload) — posts the answer; resolves to
//                       { correct, graded, cleared, explanation, attempt }
//   onContinue() — called when they may carry on (playback resumes)
//   onSkip — admin preview only: dismiss without answering
//   onRewind() — a wrong answer sends the video back over the stretch that holds
//                the answer. Omitted when there is nothing to re-watch (the
//                first question, or one pinned seconds after another), and the
//                card then just offers another go.
//   rewindSec — where it goes back to, for the wording
export default function CheckpointQuestion({
  checkpoint, onSubmit, onContinue, onSkip, onRewind, rewindSec = 0,
}) {
  const [picked, setPicked] = useState([]); // option indexes
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // { correct, cleared, explanation }

  // A fresh question: forget the last one's answer and verdict.
  useEffect(() => {
    setPicked([]); setText(''); setResult(null); setError('');
  }, [checkpoint?._id]);

  if (!checkpoint) return null;
  const multi = checkpoint.type === 'multiple';
  const free = checkpoint.type === 'text';
  const options = checkpoint.options || [];

  const toggle = (i) => {
    setResult(null);
    setPicked((p) => (multi ? (p.includes(i) ? p.filter((n) => n !== i) : [...p, i]) : [i]));
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await onSubmit(free ? { text } : { optionIndexes: picked });
      setResult(r);
      // An ungraded question has nothing to say back — let them straight on.
      if (r?.cleared && !r?.graded && !r?.explanation) onContinue();
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not save your answer. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const answered = free ? text.trim().length > 0 : picked.length > 0;
  const wrong = result && !result.cleared;

  // Phone: the question takes the whole screen. A video box at 375px is only
  // ~211px tall, so an overlay confined to it cuts the choices and the Submit
  // button off. From sm up it sits over the video, its controls included — and
  // it carries no Close/Cancel control in either case, so the global Escape
  // handler (which clicks one) can't dismiss the gate.
  return (
    <div className="fixed sm:absolute inset-0 z-40 bg-gray-900/95 overflow-y-auto flex items-start sm:items-center justify-center p-3 sm:p-6">
      <div className="w-full max-w-xl bg-white rounded-xl shadow-2xl p-4 sm:p-6">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-indigo-600 mb-2">
          <span>❓ Question</span>
          <span className="text-gray-400 font-normal normal-case tracking-normal">at {fmtClock(checkpoint.atSec)}</span>
        </div>
        <h3 className="text-base sm:text-lg font-semibold text-gray-900 whitespace-pre-wrap">{checkpoint.question}</h3>
        <p className="text-xs text-gray-500 mt-1">
          {free ? 'Type your answer to carry on.' : multi ? 'Choose all that apply.' : 'Choose one answer.'}
          {' '}The video stays paused until you answer.
        </p>

        {free ? (
          <input
            autoFocus
            value={text}
            onChange={(e) => { setText(e.target.value); setResult(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && answered && !busy) submit(); }}
            placeholder="Your answer"
            className="mt-4 block w-full border rounded-lg px-3 py-2 text-sm"
          />
        ) : (
          <div className="mt-4 space-y-2">
            {options.map((o, i) => {
              const on = picked.includes(i);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => toggle(i)}
                  className={`w-full text-left flex items-start gap-3 px-3 py-2.5 rounded-lg border text-sm ${
                    on ? 'border-indigo-500 bg-indigo-50 text-indigo-900' : 'border-gray-200 hover:bg-gray-50 text-gray-800'
                  }`}
                >
                  <span className={`mt-0.5 shrink-0 w-4 h-4 flex items-center justify-center text-[10px] text-white ${multi ? 'rounded' : 'rounded-full'} ${
                    on ? 'bg-indigo-600' : 'bg-white border border-gray-300'
                  }`}>{on ? '✓' : ''}</span>
                  <span className="min-w-0 whitespace-pre-wrap">{o.text}</span>
                </button>
              );
            })}
          </div>
        )}

        {error && <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

        {result && (
          <div className={`mt-3 px-3 py-2 rounded-lg text-sm border ${
            result.cleared
              ? (result.correct ? 'bg-green-50 border-green-200 text-green-800' : 'bg-amber-50 border-amber-200 text-amber-800')
              : 'bg-red-50 border-red-200 text-red-700'
          }`}>
            <div className="font-medium">
              {!result.cleared
                ? (onRewind
                  ? `Not quite - the video goes back to ${fmtClock(rewindSec)} so you can watch that part again.`
                  : 'Not quite - have another go.')
                : result.graded ? (result.correct ? '✓ Correct' : 'Answer recorded.')
                  : '✓ Thanks - answer recorded.'}
            </div>
            {result.explanation && <div className="mt-1 whitespace-pre-wrap">{result.explanation}</div>}
          </div>
        )}

        <div className="mt-4 flex items-center gap-2">
          {onSkip && (
            <button type="button" onClick={onSkip} className="text-xs text-gray-400 hover:text-gray-600">
              Skip (preview)
            </button>
          )}
          <div className="ml-auto flex gap-2">
            {result?.cleared ? (
              <button type="button" onClick={onContinue}
                className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">
                Continue watching →
              </button>
            ) : wrong && onRewind ? (
              // The only way on from a wrong answer: back over the stretch that
              // holds it. The question is still uncleared, so it comes round
              // again when the playhead reaches it.
              <button type="button" onClick={onRewind}
                className="px-4 py-2 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700">
                ↻ Watch that part again
              </button>
            ) : (
              <button type="button" onClick={submit} disabled={busy || !answered}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">
                {busy ? 'Checking…' : wrong ? 'Try again' : 'Submit answer'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
