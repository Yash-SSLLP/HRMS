// Central company branding. The logo is bundled in /public. `logo.svg` is a
// high-quality vector rebuild of the original wordmark (traced from logo.png,
// with a premium gold gradient) — razor-sharp at any size / DPI. The raster
// `logo.png` is kept as a fallback (e.g. email/PDF where SVG isn't supported).
export const COMPANY_NAME = 'Sequence Surfaces';
// Strapline printed under the wordmark on the logo — rendered with it wherever
// the brand lockup appears (sidebar, login, public forms & letter pages).
export const COMPANY_TAGLINE = 'An Exclusive Laminate Company';
export const COMPANY_LOGO = '/logo.svg';
// Just the gold chevron mark (no wordmark) — a crisp icon for tight spots like
// the sidebar, paired with the COMPANY_NAME text so nothing is squeezed.
export const COMPANY_LOGO_MARK = '/logo-mark.svg';
export const COMPANY_LOGO_PNG = '/logo.png';
export const COMPANY_LOGO_URL = 'https://sequencesurface.com/images/logo.png';
// Brand gold, mirrored from the --gold-* tokens in index.css. For the rare spot
// that needs the value in JS (inline styles, canvas/chart fills).
export const BRAND_GOLD = '#B08843';
export const BRAND_GOLD_LIGHT = '#EBD299';
