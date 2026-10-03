// The company brand lockup, rendered the same way everywhere so the app reads
// as one identity. Styling lives in index.css (the `.brand-*` classes).
//
// 2026-09-30 (user: "use this logo as it in website"): both variants show the
// company's own logo image AS SUPPLIED — wordmark, arrow and tagline in one,
// instead of a typed wordmark and tagline beside a mark.
// 2026-10-03 (user: "use this logo in the web"): the monochrome artwork, cut to
// a transparent ground in two inks — near-black on the light theme, white on
// the dark one. Both images are in the page; CSS shows the one for the theme
// (`.brand-ink` / `.brand-white`), so a theme switch never waits on a load.
//
//   variant="inline"  the logo (sidebar header). The collapsed icon rail is too
//                     narrow for it, so there — and only there — the small
//                     chevron mark on its onyx tile shows instead (index.css
//                     `.sidebar-shell.is-rail`).
//   variant="stacked" the logo, larger (login card, public forms / letter pages)
//
// SIDEBAR HEADER, OPTION E (2026-09-30, picked from mockups): the logo left,
// a hairline divider, then "HRMS" in gold over the portal's name ("Admin
// portal" / "My portal" / …) — pass `portal`. Without it only the logo shows.
//
// Only spans are used so the inline variant can sit inside the sidebar's <Link>.
import { COMPANY_NAME, COMPANY_LOGO_INK, COMPANY_LOGO_WHITE, COMPANY_LOGO_MARK } from '../config/company';

function Logo({ className }) {
  return (
    <>
      <img src={COMPANY_LOGO_INK} alt={COMPANY_NAME} className={`${className} brand-ink`} />
      <img src={COMPANY_LOGO_WHITE} alt="" aria-hidden="true" className={`${className} brand-white`} />
    </>
  );
}

export default function BrandLockup({ variant = 'inline', portal = '', className = '' }) {
  if (variant === 'stacked') {
    return (
      <span className={`brand-stack ${className}`}>
        <Logo className="brand-stack-full" />
      </span>
    );
  }

  return (
    <span className={`brand-lock ${className}`}>
      <Logo className="brand-full" />
      {portal ? (
        <>
          <span className="brand-divider" aria-hidden="true" />
          <span className="brand-portal">
            <span className="brand-portal-name">HRMS</span>
            <span className="brand-portal-sub">{portal}</span>
          </span>
        </>
      ) : null}
      {/* The collapsed rail's stand-in — hidden everywhere else. */}
      <span className="brand-mark">
        <img src={COMPANY_LOGO_MARK} alt="" aria-hidden="true" />
      </span>
    </span>
  );
}
