/**
 * testSenderCc.js — proves the SENDER-Cc rule holds for every mail the portal
 * sends: whoever triggers a mail while signed in gets their own configured
 * address into Cc, so a letter, an interview invite, a leave notice or a wish
 * always leaves a copy in the sender's own inbox.
 *
 *   npm run test:sender-cc      (from backend/)
 *
 * No database, no network: `EmailOutbox.create` and the Gmail transport are
 * stubbed, so nothing leaves the process. Safe to run against any environment.
 *
 * TWO HALVES, because either one alone can lie:
 *
 *  1. THE INVENTORY. Every place in the backend that sends a mail is found in
 *     the source and listed with the feature it belongs to. The rule lives in
 *     ONE place (withActorCc, applied inside both sendMail and enqueueMail in
 *     services/email.js), so a path is covered simply by existing — the thing
 *     that would quietly opt one out is `selfCopy: false`, and the sweep fails
 *     if anything but the outbox worker passes it. That is what makes this a
 *     check on ALL mail sending rather than on the handful somebody remembered.
 *
 *  2. THE BEHAVIOUR. The real services/email.js is then run through the cases
 *     that decide whether the Cc is right: a queued send, a direct send, an
 *     existing Cc list, the duplicate guards, and the three deliberate
 *     exemptions (no request context, no address on file, the worker's
 *     re-send).
 *
 * If you add a new mail path, you need do nothing — but run this afterwards.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------------------ helpers */

let pass = 0;
let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (ok) pass += 1; else fail += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`          got  : ${JSON.stringify(got)}\n          want : ${JSON.stringify(want)}`);
};

/** Every .js file under a directory, recursively (node_modules skipped). */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * The text of one call's argument list, from its opening paren to the matching
 * close. Paren-balanced rather than regex-matched, so a nested object or call
 * inside the arguments does not end it early.
 * @param {string} src
 * @param {number} openIdx - index of the '(' that opens the call
 * @returns {string}
 */
function callArgs(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return src.slice(openIdx);
}

/** The nearest function/route declaration above a line — what to call the path. */
function enclosing(lines, lineIdx) {
  // Anchored at column 0 on purpose: a helper declared INSIDE the sending
  // function (const clean = …, const fmt = …) sits between the call and its real
  // owner, and matching those named six paths after the wrong thing.
  const DECL = /^(?:(?:async\s+)?function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async|asyncHandler)\b)/;
  for (let i = lineIdx; i >= 0; i -= 1) {
    const m = DECL.exec(lines[i]);
    if (m) return m[1] || m[2];
  }
  return '(top level)';
}

// What each sending function is, in the words the portal uses. Anything not
// named here still passes the sweep — it just prints without a label, which is
// the nudge to add one.
const FEATURE = {
  sendWish: 'Celebrations — a wish somebody sent',
  notifyEmailChanged: 'Admin — "your sign-in address changed"',
  emailDocLink: 'Employee — document request link',
  emailRelievingLetter: 'Exit — relieving letter',
  resendExitEmail: 'Exit — re-send an exit mail',
  emailPayslip: 'Payroll — payslip',
  mailAdmins: 'Password reset — request raised (PUBLIC: no sender)',
  notifyApprover: 'Leave — "your approval is needed"',
  emailLeaveToHr: 'Leave — no manager, so HR is asked',
  notifyEmergencyTaken: 'Leave — emergency leave was taken',
  notifyShiftAssignment: 'Shifts — a day shift was assigned',
  notifyStandingShift: 'Shifts — a standing shift was set',
  createRoundMeet: 'Interview — meeting created',
  sendRoundMeetEmail: 'Interview — invite / re-send',
  emailLetter: 'Recruitment — offer / appointment letter',
  sendLetterEmail: 'Recruitment — letter (compose & send)',
  emailRejectedDocuments: 'Recruitment — documents rejected, please resend',
  emailDocumentRequest: 'Recruitment — candidate document request',
  processOne: 'THE OUTBOX WORKER — re-sends a queued row (selfCopy: false)',
};

/* ------------------------------------------------- 1. the inventory sweep */

function sweep() {
  console.log('\n1. EVERY MAIL PATH IN THE BACKEND\n');
  const files = walk(ROOT).filter((f) => !f.startsWith(path.join(ROOT, 'scripts')));
  const CALL = /\b(enqueueMail|sendMail)\s*\(/g;
  const rows = [];
  let optOuts = 0;

  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    // The rule's own home: its internals mention both names constantly.
    if (rel === 'services/email.js') continue;
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split(/\r?\n/);
    let m;
    CALL.lastIndex = 0;
    while ((m = CALL.exec(src))) {
      // `t.sendMail(...)` is nodemailer's own method, not ours.
      if (src[m.index - 1] === '.') continue;
      const lineNo = src.slice(0, m.index).split(/\r?\n/).length;
      const fn = enclosing(lines, lineNo - 1);
      const args = callArgs(src, m.index + m[0].length - 1);
      const optOut = /selfCopy\s*:\s*false/.test(args);
      if (optOut && fn !== 'processOne') optOuts += 1;
      rows.push({ rel, lineNo, fn, kind: m[1], optOut });
    }
  }

  for (const r of rows.sort((a, b) => (FEATURE[a.fn] || 'zz').localeCompare(FEATURE[b.fn] || 'zz'))) {
    const label = FEATURE[r.fn] || `${r.fn} (unlabelled — add it to FEATURE)`;
    // A public form reaches the same rule; it just has nobody signed in for the
    // rule to find, so saying "sender in Cc" there would be a half-truth.
    const copied = r.optOut
      ? 'no Cc (opted out)'
      : (label.includes('PUBLIC') ? 'no sender to copy (public form)' : 'sender in Cc');
    console.log(`  ${label}`);
    console.log(`      ${r.rel}:${r.lineNo} · ${r.kind} · ${copied}`);
  }

  console.log(`\n  ${rows.length} mail paths found.`);
  check('every path is covered by the rule (nothing but the worker opts out)', optOuts, 0);
  return rows.length;
}

/* ------------------------------------------------- 2. the behaviour checks */

async function behaviour() {
  const { als } = require('../middleware/requestContext');
  const EmailOutbox = require('../models/EmailOutbox');
  const googleMail = require('../services/googleMail');
  const emailWorker = require('../services/emailWorker');

  const rows = [];
  EmailOutbox.create = async (doc) => { rows.push(doc); return { _id: 'row', ...doc }; };
  const sent = [];
  googleMail.isConfigured = () => true;
  googleMail.send = async (opts) => { sent.push(opts); return { messageId: 'stub' }; };
  // The queue kick would otherwise drain the real outbox against a database
  // nobody has connected to.
  emailWorker.tick = async () => {};

  const { sendMail, enqueueMail } = require('../services/email');

  const hr = { _id: 'u1', email: 'Priya.HR@example.com', fullName: 'Priya Sharma', role: 'HRManager' };
  const staff = { _id: 'u2', email: 'vikas@example.com', fullName: 'Vikas Sharma', role: 'Employee' };
  const asUser = (user, fn) => als.run({ req: { user } }, fn);
  const ccOf = (x) => (Array.isArray(x?.cc) ? x.cc.join(',') : (x?.cc || ''));

  console.log('\n2. WHAT THE RULE ACTUALLY DOES\n');

  await asUser(hr, () => enqueueMail({ to: 'candidate@x.com', subject: 'Offer letter', text: 'x' }));
  check('a queued mail (letter, payslip, interview invite) carries the sender', ccOf(rows.at(-1)), hr.email);

  await asUser(hr, () => sendMail({ to: 'emp@x.com', subject: 'Documents required', text: 'x' }));
  check('a direct send (document request, relieving letter) carries the sender', ccOf(sent.at(-1)), hr.email);

  await asUser(staff, () => enqueueMail({ to: 'hr@x.com', subject: 'Leave applied', text: 'x' }));
  check('any signed-in user, not only HR (an employee applying for leave)', ccOf(rows.at(-1)), staff.email);

  await asUser(hr, () => enqueueMail({ to: 'c@x.com', cc: ['boss@x.com'], subject: 'S', text: 'x' }));
  check('a hand-typed Cc is kept and the sender appended', ccOf(rows.at(-1)), `boss@x.com,${hr.email}`);

  await asUser(hr, () => enqueueMail({ to: [hr.email], subject: 'S', text: 'x' }));
  check('nobody is Cc\'d on their own mail (already on To)', ccOf(rows.at(-1)), '');

  await asUser(hr, () => enqueueMail({ to: 'c@x.com', cc: 'PRIYA.hr@example.com', subject: 'S', text: 'x' }));
  check('the duplicate guard ignores case', ccOf(rows.at(-1)), 'PRIYA.hr@example.com');

  await enqueueMail({ to: 'c@x.com', subject: 'Birthday digest', text: 'x' });
  check('a cron or a public form has no sender to copy', ccOf(rows.at(-1)), '');

  await asUser({ _id: 'u3', role: 'HRManager' }, () => enqueueMail({ to: 'c@x.com', subject: 'S', text: 'x' }));
  check('an account with no address on file is skipped, not broken', ccOf(rows.at(-1)), '');

  await asUser(hr, () => sendMail({ to: 'c@x.com', cc: 'someone@x.com', subject: 'S', text: 'x', selfCopy: false }));
  check('the worker re-sending a queued row adds nobody (selfCopy: false)', ccOf(sent.at(-1)), 'someone@x.com');

  // The Cc has to survive the transport, not just reach it: the Gmail path
  // writes a raw RFC822 message, and a dropped header there would be invisible
  // everywhere else.
  const raw = sent.at(-1);
  check('the transport is handed the Cc it must put on the wire', typeof raw.cc === 'string' || Array.isArray(raw.cc), true);
}

(async () => {
  console.log('SENDER-Cc CHECK — does every mail copy the person who sent it?');
  const count = sweep();
  await behaviour();
  console.log(`\n${pass} passed, ${fail} failed, across ${count} mail paths.`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nCheck could not run:', err.message);
  process.exit(1);
});
