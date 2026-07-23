/**
 * GlobalModalEscape — app-wide "press Esc to close the open modal".
 *
 * Rather than wiring an Escape handler into every one of the app's ~dozens of
 * modals, this single always-mounted listener finds the top-most open modal
 * overlay and triggers its own close control (a ×/Close/Cancel button, or an
 * element tagged `data-modal-close`). That reuses each modal's existing close
 * logic — including any state cleanup — without touching every page.
 *
 * Shared dialogs (components/dialogs.jsx) already handle Escape and call
 * preventDefault, so this handler bails when the event was already handled.
 * Renders nothing.
 */
import { useEffect } from 'react';

// Full-screen fixed overlays currently painted on screen (our modal backdrops).
const MODAL_OVERLAY_SELECTOR = '.fixed.inset-0';

function isVisible(el) {
  const cs = window.getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  const r = el.getBoundingClientRect();
  return r.width > 4 && r.height > 4;
}

// Sort ascending by stacking order: z-index, then DOM order (later = on top).
function byStackOrder(a, b) {
  const za = parseInt(window.getComputedStyle(a).zIndex, 10) || 0;
  const zb = parseInt(window.getComputedStyle(b).zIndex, 10) || 0;
  if (za !== zb) return za - zb;
  // eslint-disable-next-line no-bitwise
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

// Find the close control inside one modal overlay, in priority order.
function findCloseControl(root) {
  const explicit = root.querySelector('[data-modal-close]');
  if (explicit) return explicit;
  const aria = root.querySelector('button[aria-label="Close" i], button[aria-label="Dismiss" i]');
  if (aria) return aria;
  const buttons = Array.from(root.querySelectorAll('button')).filter((b) => !b.disabled);
  const byText = (texts) => buttons.find((b) => texts.includes((b.textContent || '').trim()));
  // Prefer an explicit dismiss glyph, then Close, then Cancel.
  return byText(['×', '✕', '✖', '⨯', '╳']) || byText(['Close']) || byText(['Cancel']) || null;
}

function closeTopmostModal(e) {
  const overlays = Array.from(document.querySelectorAll(MODAL_OVERLAY_SELECTOR)).filter(isVisible);
  if (!overlays.length) return;
  overlays.sort(byStackOrder);
  // Try the top-most overlay first, falling through to any beneath it.
  for (let i = overlays.length - 1; i >= 0; i -= 1) {
    const btn = findCloseControl(overlays[i]);
    if (btn) {
      e.preventDefault();
      btn.click();
      return;
    }
  }
}

export default function GlobalModalEscape() {
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      closeTopmostModal(e);
    };
    // Bubble phase on window: runs after any modal's own document-level handler,
    // so their preventDefault (shared dialogs) suppresses this fallback.
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  return null;
}
