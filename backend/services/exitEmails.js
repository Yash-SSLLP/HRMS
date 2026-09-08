/**
 * The exit / offboarding email.
 *
 * ONE mail covers both halves of an exit: the relieving letter and the feedback
 * form live on the SAME tokenised page, so a single link serves both. (That is
 * why the registry's 'relieving.mail' has no send site of its own.)
 *
 * The wording comes from the editable registry — 'exit.feedback' — so what HR
 * types in Settings → Templates is what goes out. The HTML alternative is built
 * FROM that same rendered text rather than kept as a second copy, because two
 * copies drift: the plain part would follow an edit and the branded part would
 * not, and most clients show the branded one.
 */
const { renderMail } = require('./templates');
const COMPANY = require('../config/company');

const orgName = () => COMPANY.name;

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'long', year: 'numeric',
  });
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

/**
 * Wrap the rendered plain text in the branded HTML, with the download button.
 *
 * The link is turned into a button AND left printed in full, because plenty of
 * corporate clients strip or rewrite anchors. A paragraph that is nothing but
 * the URL becomes the button rather than a second bare copy of it.
 */
function toHtml(text, url) {
  const blocks = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const parts = blocks.map((p) => {
    if (p === url) {
      return `<p style="margin:24px 0;">
    <a href="${esc(url)}"
       style="display:inline-block;padding:12px 24px;background:#111111;color:#ffffff;
              text-decoration:none;border-radius:6px;font-weight:600;">
      Download your relieving letter
    </a>
  </p>`;
    }
    // A paragraph that ENDS with the link (the letter sentence) keeps its words
    // and gets the button underneath.
    if (p.endsWith(url)) {
      const lead = p.slice(0, -url.length).trimEnd();
      return `<p style="margin:0 0 14px;white-space:pre-wrap;">${esc(lead)}</p>
  <p style="margin:24px 0;">
    <a href="${esc(url)}"
       style="display:inline-block;padding:12px 24px;background:#111111;color:#ffffff;
              text-decoration:none;border-radius:6px;font-weight:600;">
      Download your relieving letter
    </a>
  </p>`;
    }
    return `<p style="margin:0 0 14px;white-space:pre-wrap;">${esc(p)}</p>`;
  });

  return `<!doctype html>
<html><body style="font-family:Helvetica,Arial,sans-serif;color:#1f2937;line-height:1.55;max-width:560px;margin:0 auto;padding:24px;">
  ${parts.join('\n  ')}
  <p style="font-size:13px;color:#6b7280;">
    Or paste this link into your browser:<br>
    <code style="background:#f4f4f5;padding:2px 6px;border-radius:3px;">${esc(url)}</code>
  </p>
</body></html>`;
}

/**
 * Build the "thank you + relieving letter + feedback request" email sent when
 * HR finalises an employee's exit.
 *
 * ASYNC because the wording is resolved from the template registry. Both call
 * sites (completeExit, resendExitEmail) already await it.
 *
 * @param {Object} ctx
 * @param {Object} ctx.employee   employee profile (with .user populated)
 * @param {Object} ctx.hr         User doc of the HR person handling the exit
 * @param {Date}   ctx.lastWorkingDay
 * @param {string} ctx.feedbackUrl
 * @param {string} [ctx.letterUrl] - the same tokenised page, which also serves
 *   the relieving letter. Omitted only if there is no token to link to.
 * @returns {Promise<{subject:string, text:string, html:string}>} Ready-to-send parts.
 */
async function buildExitEmail(ctx) {
  const empFirst = ctx.employee.user?.firstName || 'there';
  const hrFirst = ctx.hr?.firstName || 'HR';
  const hrLast = ctx.hr?.lastName || 'Team';
  const hrName = `${hrFirst} ${hrLast}`.trim();
  const lwd = fmtDate(ctx.lastWorkingDay);
  const org = orgName();

  // The letter lives on the same tokenised page as the feedback form, so one
  // link covers both. It is called out separately because it is the thing the
  // leaver actually needs to keep.
  const letterUrl = ctx.letterUrl || ctx.feedbackUrl;

  const fallbackBody =
`Dear ${empFirst},

Your last working day with ${org} was ${lwd}. On behalf of the entire team, thank you for your time and contributions - we wish you the very best in your future endeavours.

Your relieving letter is ready. You can download it here, without signing in - please keep a copy for your records:
${letterUrl}

As part of our offboarding process, we'd be grateful if you could spare a few minutes to share your feedback. Your honest input helps us become a better workplace for everyone who comes after you. The feedback form is on the same page.

If you have any questions or need help, feel free to reply directly to this email - it will reach me.

Warm regards,
${hrName}
HR - ${org}`;

  const { subject, text } = await renderMail('exit.feedback', {
    employeeName: empFirst,
    employeeCode: ctx.employee.employeeCode,
    companyName: org,
    link: letterUrl,
    lastWorkingDay: lwd,
    hrName,
  }, { subject: `Thank you for your time with ${org}`, body: fallbackBody });

  return { subject, text, html: toHtml(text, letterUrl) };
}

module.exports = { buildExitEmail };
