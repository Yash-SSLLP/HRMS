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
 */
function buildExitEmail(ctx) {
  const empFirst = ctx.employee.user?.firstName || 'there';
  const hrFirst = ctx.hr?.firstName || 'HR';
  const hrLast  = ctx.hr?.lastName  || 'Team';
  const hrName = `${hrFirst} ${hrLast}`.trim();
  const lwd = fmtDate(ctx.lastWorkingDay);
  const org = orgName();

  const text =
`Dear ${empFirst},

Your last working day with ${org} was ${lwd}. On behalf of the entire team,
thank you for your time and contributions - we wish you the very best in your
future endeavours.

As part of our offboarding process, we'd be grateful if you could spare a
few minutes to share your feedback. Your honest input helps us become a
better workplace for everyone who comes after you.

Please open the exit-feedback form here:
${ctx.feedbackUrl}

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
  <p>As part of our offboarding process, we'd be grateful if you could spare a few
  minutes to share your feedback. Your honest input helps us become a better workplace
  for everyone who comes after you.</p>
  <p style="margin:24px 0;">
    <a href="${ctx.feedbackUrl}"
       style="display:inline-block;padding:12px 24px;background:#111111;color:#ffffff;
              text-decoration:none;border-radius:6px;font-weight:600;">
      Share your feedback
    </a>
  </p>
  <p style="font-size:13px;color:#6b7280;">
    Or paste this link into your browser:<br>
    <code style="background:#f4f4f5;padding:2px 6px;border-radius:3px;">${ctx.feedbackUrl}</code>
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
