/**
 * Email templates for the exit / offboarding flow.
 */

const orgName = () => process.env.ORG_DISPLAY_NAME || 'Sequence Surface';

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'long', year: 'numeric',
  });
}

/**
 * Build the "thank you + feedback request" email sent the moment HR
 * finalises an employee's exit.
 *
 * @param {Object} ctx
 * @param {Object} ctx.employee   employee profile (with .user populated)
 * @param {Object} ctx.hr         User doc of the HR person handling the exit
 * @param {Date}   ctx.lastWorkingDay
 * @param {string} ctx.feedbackUrl
 * @param {string} [ctx.letterUrl] - the same tokenised page, which also serves
 *   the relieving letter. Omitted only if there is no token to link to.
 * @returns {{subject:string, text:string, html:string}} Ready-to-send email parts.
 */
function buildExitEmail(ctx) {
  const empFirst = ctx.employee.user?.firstName || 'there';
  const hrFirst = ctx.hr?.firstName || 'HR';
  const hrLast  = ctx.hr?.lastName  || 'Team';
  const hrName = `${hrFirst} ${hrLast}`.trim();
  const lwd = fmtDate(ctx.lastWorkingDay);
  const org = orgName();

  // The letter lives on the same tokenised page as the feedback form, so one
  // link covers both. It is called out separately because it is the thing the
  // leaver actually needs to keep.
  const letterUrl = ctx.letterUrl || ctx.feedbackUrl;

  const text =
`Dear ${empFirst},

Your last working day with ${org} was ${lwd}. On behalf of the entire team,
thank you for your time and contributions - we wish you the very best in your
future endeavours.

Your relieving letter is ready. You can download it here, without signing in
- please keep a copy for your records:
${letterUrl}

As part of our offboarding process, we'd be grateful if you could spare a
few minutes to share your feedback. Your honest input helps us become a
better workplace for everyone who comes after you. The feedback form is on
the same page.

If you have any questions or need help, feel free to reply directly to this
email - it will reach me.

Warm regards,
${hrName}
HR - ${org}`;

  const html =
`<!doctype html>
<html><body style="font-family:Helvetica,Arial,sans-serif;color:#1f2937;line-height:1.55;max-width:560px;margin:0 auto;padding:24px;">
  <p>Dear ${empFirst},</p>
  <p>Your last working day with <strong>${org}</strong> was <strong>${lwd}</strong>.
  On behalf of the entire team, thank you for your time and contributions - we wish you
  the very best in your future endeavours.</p>
  <p><strong>Your relieving letter is ready.</strong> You can download it below without
  signing in - please keep a copy for your records.</p>
  <p style="margin:24px 0;">
    <a href="${letterUrl}"
       style="display:inline-block;padding:12px 24px;background:#111111;color:#ffffff;
              text-decoration:none;border-radius:6px;font-weight:600;">
      Download your relieving letter
    </a>
  </p>
  <p>As part of our offboarding process, we'd be grateful if you could spare a few
  minutes to share your feedback. Your honest input helps us become a better workplace
  for everyone who comes after you - the feedback form is on the same page.</p>
  <p style="font-size:13px;color:#6b7280;">
    Or paste this link into your browser:<br>
    <code style="background:#f4f4f5;padding:2px 6px;border-radius:3px;">${letterUrl}</code>
  </p>
  <p>If you have any questions or need help, feel free to reply directly to this email - it will reach me.</p>
  <p style="margin-top:32px;">
    Warm regards,<br>
    <strong>${hrName}</strong><br>
    HR - ${org}
  </p>
</body></html>`;

  return {
    subject: `Thank you for your time with ${org}`,
    text,
    html,
  };
}

module.exports = { buildExitEmail };
