// The company brand lockup, rendered the same way everywhere so the app reads
// as one identity. Styling lives in index.css (the `.brand-*` classes) and is
// built from the --gold-* brand tokens, independent of the per-portal accent.
//
//   variant="inline"  chevron mark on an onyx tile + gold wordmark + tagline
//                     (sidebar header, tight horizontal spots)
//   variant="stacked" full gold wordmark logo + tapered gold rule + tagline
//                     (login card, public forms / letter pages)
//
// Only spans are used so the inline variant can sit inside the sidebar's <Link>.
import { COMPANY_NAME, COMPANY_TAGLINE, COMPANY_LOGO, COMPANY_LOGO_MARK } from '../config/company';

export default function BrandLockup({ variant = 'inline', className = '' }) {
  if (variant === 'stacked') {
    return (
      <span className={`brand-stack ${className}`}>
        <img src={COMPANY_LOGO} alt={COMPANY_NAME} className="brand-stack-logo" />
        <span className="brand-rule" aria-hidden="true" />
        <span className="brand-tag">{COMPANY_TAGLINE}</span>
      </span>
    );
  }

  return (
    <span className={`brand-lock ${className}`}>
      <span className="brand-mark">
        {/* Decorative — the wordmark beside it already names the company. */}
        <img src={COMPANY_LOGO_MARK} alt="" aria-hidden="true" />
      </span>
      <span className="brand-text">
        <span className="brand-name">{COMPANY_NAME}</span>
        <span className="brand-tag">{COMPANY_TAGLINE}</span>
      </span>
    </span>
  );
}
