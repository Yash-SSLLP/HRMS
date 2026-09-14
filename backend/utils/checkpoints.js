/**
 * In-video checkpoint questions — the rules, in one place.
 *
 * A checkpoint is a question pinned to a timestamp inside a video lesson. The
 * player stops there and will not go on until the learner answers it. This file
 * holds the three things both the internal (courseController) and the public
 * (publicCourseController) sides need to agree on:
 *
 *   normalizeCheckpoints — what an author is allowed to save
 *   learnerCheckpoint    — what a learner is allowed to SEE (never the answer)
 *   gradeAnswer / gateSec — what counts as answered, and where playback stops
 *
 * GRADED vs UNGRADED is not a flag the author sets — it falls out of the
 * options. Mark an option `correct` and the question is graded; mark none and
 * it's a poll: the answer is logged and the learner moves on either way.
 */

const CHECKPOINT_TYPES = ['single', 'multiple', 'text'];

const err = (message, status = 400) => {
  const e = new Error(message);
  e.status = status;
  return e;
};

/** mm:ss for error messages, so an author is told which question by timestamp. */
function clock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Loose text match for `text` answers: trimmed, collapsed spaces, caseless. */
const normText = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Does this question have a right answer at all? */
const isGraded = (cp) => (cp.options || []).some((o) => o.correct);

/**
 * Clean and validate the checkpoints an author submitted for one video lesson.
 * Throws a 400 naming the lesson and the timestamp so the message is actionable.
 * @param {Array} list raw checkpoints from the request body
 * @param {string} label human label for the lesson ("Lesson 2 (\"Safety\")")
 * @returns {Array} normalized checkpoints, sorted by timestamp
 */
function normalizeCheckpoints(list, label) {
  if (!Array.isArray(list)) return [];
  const out = list
    .filter((c) => c && String(c.question || '').trim())
    .map((c) => {
      const atSec = Math.max(0, Math.round(Number(c.atSec) || 0));
      const where = `${label} - question at ${clock(atSec)}`;
      const type = CHECKPOINT_TYPES.includes(c.type) ? c.type : 'single';
      const options = (Array.isArray(c.options) ? c.options : [])
        .map((o) => ({ text: String(o?.text ?? o ?? '').trim().slice(0, 300), correct: !!o?.correct }))
        .filter((o) => o.text);

      if (type !== 'text' && options.length < 2) {
        throw err(`${where}: add at least two answer choices.`);
      }
      if (type === 'single' && options.filter((o) => o.correct).length > 1) {
        throw err(`${where}: a single-choice question can only have one right answer. Switch it to "Choose all that apply" if more than one is.`);
      }

      const cp = {
        atSec,
        question: String(c.question).trim().slice(0, 500),
        type,
        options,
        explanation: String(c.explanation || '').trim().slice(0, 1000),
        // Only meaningful on a graded question; harmless otherwise.
        requireCorrect: c.requireCorrect !== false,
      };
      if (c._id) cp._id = c._id; // keep the id so the answer log still points at it
      return cp;
    });
  // Sorted so "the next question" is simply the next entry, everywhere.
  return out.sort((a, b) => a.atSec - b.atSec);
}

/**
 * The learner-safe shape of a checkpoint: the question and the choices, with
 * every `correct` flag and the explanation stripped. Nothing here tells a
 * learner (or the network tab) which answer is right.
 */
function learnerCheckpoint(cp) {
  return {
    _id: cp._id,
    atSec: cp.atSec,
    question: cp.question,
    type: cp.type,
    options: (cp.options || []).map((o) => ({ text: o.text })),
    graded: isGraded(cp),
    requireCorrect: cp.requireCorrect !== false,
  };
}

/**
 * Mark an answer. `body` is what the player posted:
 *   { optionIndexes: [0, 2] }  — single / multiple
 *   { text: "…" }              — text
 * @returns {{answer: string[], graded: boolean, correct: boolean, cleared: boolean}}
 *   `cleared` = may they carry on (right answer, or the question isn't gated on one)
 * @throws 400 when nothing was answered — that's the whole rule of the feature
 */
function gradeAnswer(cp, body = {}) {
  const options = cp.options || [];
  const graded = isGraded(cp);
  let answer = [];
  let correct = false;

  if (cp.type === 'text') {
    const given = String(body.text || '').trim().slice(0, 500);
    if (!given) throw err('Type your answer to carry on.');
    answer = [given];
    correct = graded ? options.some((o) => o.correct && normText(o.text) === normText(given)) : true;
  } else {
    const raw = Array.isArray(body.optionIndexes)
      ? body.optionIndexes
      : (body.optionIndex === undefined || body.optionIndex === null ? [] : [body.optionIndex]);
    const picked = [...new Set(raw.map((n) => Number(n)))]
      .filter((n) => Number.isInteger(n) && n >= 0 && n < options.length)
      .sort((a, b) => a - b);
    if (!picked.length) throw err('Pick an answer to carry on.');
    if (cp.type === 'single' && picked.length > 1) throw err('Pick one answer.');
    answer = picked.map((i) => options[i].text);
    if (graded) {
      const wanted = options.map((o, i) => (o.correct ? i : -1)).filter((i) => i >= 0);
      // single: the pick must be a right one. multiple: exactly the right set.
      correct = cp.type === 'single'
        ? wanted.includes(picked[0])
        : picked.length === wanted.length && picked.every((i) => wanted.includes(i));
    } else {
      correct = true;
    }
  }

  // A wrong answer only blocks when the question is graded AND gated on it.
  const cleared = correct || !graded || cp.requireCorrect === false;
  return { answer, graded, correct, cleared };
}

/**
 * Where playback has to stop: the timestamp of the first checkpoint in this
 * video the learner hasn't got past yet, or null when they're all cleared.
 * @param {Object} module a video module
 * @param {Set<string>} clearedSet checkpoint ids already cleared (as strings)
 */
function gateSec(module, clearedSet) {
  const pending = (module?.checkpoints || [])
    .filter((c) => !clearedSet.has(String(c._id)))
    .map((c) => c.atSec);
  return pending.length ? Math.min(...pending) : null;
}

module.exports = {
  CHECKPOINT_TYPES,
  normalizeCheckpoints,
  learnerCheckpoint,
  gradeAnswer,
  gateSec,
  isGraded,
  clock,
};
