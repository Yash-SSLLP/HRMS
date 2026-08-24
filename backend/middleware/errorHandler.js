// Express error-handling middleware: a 404 fallthrough and a central error
// handler that normalises common Mongoose/Mongo errors into clean HTTP status
// codes + messages. Both are mounted last in server.js, after all routes.

/**
 * 404 fallthrough: reached when no route matched. Sets status 404 and forwards a
 * "Not found" Error to the error handler below.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 * @sideeffect Sets res.status(404) and calls next(err).
 */
function notFound(req, res, next) {
  res.status(404);
  next(new Error(`Not found - ${req.originalUrl}`));
}

/**
 * Central error handler (Express recognises it by its 4-arg signature). Derives
 * an HTTP status, remaps well-known Mongoose/Mongo errors to friendlier codes,
 * and returns JSON `{ message, stack }` (stack omitted in production).
 * @param {Error} err - Error thrown/forwarded from any route or middleware.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next - Unused; required for Express to treat this as an error handler.
 * @returns {void}
 * @sideeffect Writes the JSON error response.
 */
// Friendly names for schema paths, so an error names the field the way the UI
// labels it rather than the raw path. Unknown paths are humanised (camelCase →
// words) as a fallback.
const FIELD_LABELS = {
  reportingManager: 'reporting manager',
  hrPartner: 'HR partner',
  company: 'company',
  workLocationRef: 'work location',
  salaryStructure: 'salary structure',
  employee: 'employee',
  assignedTo: 'assignee',
  user: 'user account',
  department: 'department',
  designation: 'designation',
  dateOfJoining: 'date of joining',
  dateOfBirth: 'date of birth',
};
function labelFor(path) {
  if (!path) return 'value';
  const last = String(path).split('.').pop();
  if (FIELD_LABELS[last]) return FIELD_LABELS[last];
  // camelCase / snake_case → spaced lowercase words
  return last.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
}
// "a"/"an" for a label (HR reads as a vowel sound → "an HR partner").
const article = (label) => (/^[aeiou]/i.test(label) || /^hr\b/i.test(label) ? 'an' : 'a');
// Turn a Mongoose CastError into a human sentence (empty value = "select one").
function castMessage(e) {
  const label = labelFor(e.path);
  const empty = e.value == null || String(e.value).trim() === '';
  if (e.kind === 'ObjectId' || /ObjectId/.test(e.message || '')) {
    return empty ? `Please select ${article(label)} ${label}.` : `That ${label} is not valid. Please pick one from the list.`;
  }
  if (e.kind === 'Number') return `The ${label} must be a number.`;
  if (e.kind === 'Date') return `The ${label} is not a valid date.`;
  return empty ? `Please provide a valid ${label}.` : `The value for ${label} is not valid.`;
}

function errorHandler(err, req, res, next) {
  let status = err.status || err.statusCode
    || (res.statusCode && res.statusCode !== 200 ? res.statusCode : 500);
  let message = err.message || 'Server error';

  // Mongoose validation — build a readable sentence per failing field, and
  // translate any nested cast failure so a raw "Cast to ObjectId failed…" never
  // reaches the user.
  if (err.name === 'ValidationError' && err.errors) {
    status = 400;
    message = Object.values(err.errors)
      .map((e) => (e.name === 'CastError' ? castMessage(e) : e.message))
      .join(' ');
  }

  // Duplicate key. Controllers that can hit a unique index on a user-entered
  // field check it up front and throw their own message; this is the backstop
  // for everything else, and it names the field in the words the UI uses rather
  // than the raw schema path.
  if (err.code === 11000) {
    status = 409;
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    const value = err.keyValue?.[field];
    const LABELS = {
      employeeCode: 'Employee code',
      email: 'Email address',
      phone: 'Phone number',
      code: 'Code',
      name: 'Name',
    };
    const label = LABELS[field] || field;
    message = value
      ? `${label} "${value}" already exists. Please choose another.`
      : `${label} already exists. Please choose another.`;
  }

  // Bad cast (a standalone CastError, incl. the empty-string → ObjectId case
  // that surfaces as a BSONError). Always turned into a readable sentence.
  if (err.name === 'CastError') {
    status = 400;
    message = castMessage(err);
  }

  // Backstop: if any raw Mongoose cast text still slipped through (e.g. wrapped
  // in a generic Error), don't ship it to the user.
  if (typeof message === 'string' && /Cast to \w+ failed/i.test(message)) {
    status = status === 500 ? 400 : status;
    const m = /at path "([^"]+)"/.exec(message);
    message = m ? `The value for ${labelFor(m[1])} is not valid.` : 'One of the values entered is not valid.';
  }

  res.status(status).json({
    message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  });
}

module.exports = { notFound, errorHandler };
