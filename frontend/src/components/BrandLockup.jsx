// The company brand lockup, rendered the same way everywhere so the app reads
// as one identity. Styling lives in index.css (the `.brand-*` classes).
//
// 2026-09-30 (user: "use this logo as it in website"): both variants show the
// company's own logo image AS SUPPLIED (/logo-full.png — wordmark, arrow and
// tagline in one), instead of a typed wordmark and tagline beside a mark.
//
//   variant="inline"  the logo (sidebar header). The collapsed icon rail is too
//                     narrow for it, so there — and only there — the small
//                     chevron mark on its onyx tile shows instead (index.css
//                     `.sidebar-shell.is-rail`).
//   variant="stacked" the logo, larger (login card, public forms / letter pages)
//
// Only spans are used so the inline variant can sit inside the sidebar's <Link>.
import { COMPANY_NAME, COMPANY_LOGO_FULL, COMPANY_LOGO_MARK } from '../config/company';

export default function BrandLockup({ variant = 'inline', className = '' }) {
  if (variant === 'stacked') {
    return (
      <span className={`brand-stack ${className}`}>
        <img src={COMPANY_LOGO_FULL} alt={COMPANY_NAME} className="brand-stack-full" />
      </span>
    );
  }

  return (
    <span className={`brand-lock ${className}`}>
      <img src={COMPANY_LOGO_FULL} alt={COMPANY_NAME} className="brand-full" />
      {/* The collapsed rail's stand-in — hidden everywhere else. */}
      <span className="brand-mark">
        <img src={COMPANY_LOGO_MARK} alt="" aria-hidden="true" />
      </span>
    </span>
  );
}
