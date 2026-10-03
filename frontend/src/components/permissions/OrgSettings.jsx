/**
 * OrgSettings — the switches that change the whole company, not one account
 * (AdminPermissions → "Organisation"). Super Admins only, like the endpoint:
 * GET/PUT /admin/org-settings.
 *
 * 2026-10-03 redesign (user: "make it more premium and user friendly"). These
 * used to be a column of rows above the people matrix, each carrying a
 * four-line paragraph — the page opened on a wall of text and the matrix began
 * a screen and a half down. Now they have their own tab, as cards: what the
 * setting does NOW in one line, the switch, and the full explanation one click
 * away ("How it works"). The words in that explanation are the same ones the
 * rows carried, so nothing anyone relied on was lost.
 */
import { useEffect, useState } from 'react';
import {
  FiMessageCircle, FiGlobe, FiCheckCircle, FiFileText, FiPrinter, FiChevronDown, FiCheck, FiAlertCircle,
  FiAlertTriangle,
} from 'react-icons/fi';
import api from '../../api/client';
import ToggleSwitch from '../ToggleSwitch';
import { COMPANY_NAME } from '../../config/company';

// One reader for the org payload, so a switch save cannot drop a field it does
// not know about — which is exactly how the footer would have been wiped by the
// next toggle.
const readOrg = (d = {}) => ({
  chatEnabled: !!d.chatEnabled,
  // Claude translating what people typed (2026-09-29). Default ON.
  typedTextTranslation: d.typedTextTranslation !== false,
  translation: d.translation || null,
  // A switch again since 2026-09-28. Default ON.
  khataAdvanceApprovalRequired: d.khataAdvanceApprovalRequired !== false,
  // Whether a book's PDF button offers a choice of report (2026-09-30). Off.
  khataReportChoice: !!d.khataReportChoice,
  documentFooter: {
    helpline: d.documentFooter?.helpline || '',
    note: d.documentFooter?.note || '',
  },
});

const usd = (n) => {
  const v = Number(n) || 0;
  return v > 0 && v < 0.01 ? '< $0.01' : `$${v.toFixed(2)}`;
};

/**
 * One org-wide switch as a card: icon, title, the one line that says what is
 * true right now, the switch with its state word, and the long explanation
 * behind "How it works".
 */
function SettingCard({
  icon: Icon, hue, title, summary, details, checked, onChange, busy, onLabel, offLabel, children,
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className={`prm-set${checked ? ' is-on' : ''}`} style={{ '--hue': hue }}>
      <div className="prm-set-head">
        <span className="prm-set-icon" aria-hidden="true"><Icon size={19} /></span>
        <div className="prm-set-main">
          <h3 className="prm-set-title">{title}</h3>
          <p className="prm-set-summary">{summary}</p>
        </div>
        <div className="prm-set-ctrl">
          <span className={`prm-state${checked ? ' is-on' : ''}`}>{checked ? onLabel : offLabel}</span>
          <ToggleSwitch checked={checked} onChange={onChange} busy={busy} label={title} />
        </div>
      </div>
      {children}
      {details && (
        <>
          <button type="button" className="prm-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            How it works <FiChevronDown size={13} />
          </button>
          {open && <div className="prm-details">{details}</div>}
        </>
      )}
    </section>
  );
}

export default function OrgSettings() {
  const [org, setOrg] = useState(readOrg());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Which switch is saving — per switch, so flipping one never spins the rest.
  const [busyField, setBusyField] = useState('');
  // What flipping the advance switch did to requests in flight, said once.
  const [orgNotice, setOrgNotice] = useState('');
  // The footer inputs are edited freely and saved on a button, unlike the
  // switches — so they need their own draft, or every keystroke would be a PUT.
  const [footer, setFooter] = useState({ helpline: '', note: '' });
  const [footerSaving, setFooterSaving] = useState(false);
  const [footerSaved, setFooterSaved] = useState(false);

  useEffect(() => {
    let live = true;
    api.get('/admin/org-settings')
      .then(({ data }) => {
        if (!live) return;
        const next = readOrg(data);
        setOrg(next);
        setFooter(next.documentFooter);
      })
      .catch((err) => live && setError(err.response?.data?.message || 'Could not load the organisation settings'))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, []);

  // Optimistic toggle that reverts if the save fails. Functional updates, so two
  // switches flipped in quick succession cannot overwrite each other's paint.
  const toggleOrg = async (field, errorText) => {
    const next = !org[field];
    setBusyField(field); setError(''); setOrgNotice('');
    setOrg((o) => ({ ...o, [field]: next }));
    try {
      const { data } = await api.put('/admin/org-settings', { [field]: next });
      setOrg(readOrg(data));
      // The advance switch moves requests already waiting (2026-09-28) — say
      // how many, and where to, so the move is never a surprise.
      if (field === 'khataAdvanceApprovalRequired' && data?.advancesMoved > 0) {
        const n = data.advancesMoved;
        setOrgNotice(`${n} advance request${n === 1 ? '' : 's'} ${n === 1 ? 'was' : 'were'} moved to ${
          next ? 'the CEO/MD for approval' : 'the cashbook manager'}.`);
      }
    } catch (err) {
      setOrg((o) => ({ ...o, [field]: !next }));
      setError(err.response?.data?.message || errorText);
    } finally {
      setBusyField('');
    }
  };

  // The contact strip printed along the bottom of the cashbook statement PDF.
  const saveFooter = async () => {
    setFooterSaving(true); setError(''); setFooterSaved(false);
    try {
      const { data } = await api.put('/admin/org-settings', { documentFooter: footer });
      const next = readOrg(data);
      setOrg(next);
      setFooter(next.documentFooter);
      setFooterSaved(true);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save the statement footer');
    } finally {
      setFooterSaving(false);
    }
  };
  const footerDirty = footer.helpline !== org.documentFooter.helpline || footer.note !== org.documentFooter.note;

  const t = org.translation;
  const month = t?.thisMonth || {};
  const onCount = ['chatEnabled', 'typedTextTranslation', 'khataAdvanceApprovalRequired', 'khataReportChoice']
    .filter((k) => org[k]).length;

  return (
    <div>
      {error && (
        <div className="mb-4 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2.5 rounded-lg">
          <FiAlertCircle className="mt-0.5 shrink-0" size={16} />
          <span>{error}</span>
        </div>
      )}

      <div className="prm-head" style={{ marginTop: 0 }}>
        <span className="prm-head-title">Switches</span>
        <span className="prm-head-sub">{loading ? 'Loading…' : `${onCount} of 4 on`}</span>
      </div>

      {loading ? (
        <div className="prm-set-grid">
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-28 rounded-2xl" />)}
        </div>
      ) : (
        <div className="prm-set-grid">
          <SettingCard
            icon={FiMessageCircle} hue="#0ea5e9"
            title="Chat / Messages"
            summary={org.chatEnabled
              ? 'The chat dock and the app’s Chat tab are on for everyone.'
              : 'Chat is hidden from every portal and from the app. Conversations are kept.'}
            details="When off, the chat dock is hidden from every portal and the mobile Chat tab disappears. Existing conversations are kept and come back untouched if you switch it on again."
            checked={org.chatEnabled} busy={busyField === 'chatEnabled'}
            onLabel="Enabled" offLabel="Disabled"
            onChange={() => toggleOrg('chatEnabled', 'Could not update the chat setting')} />

          {/* THE API KEY'S OFF SWITCH (2026-09-29), with what it has cost. */}
          <SettingCard
            icon={FiGlobe} hue="#8b5cf6"
            title="Translate typed text (Claude API)"
            summary={org.typedTextTranslation
              ? 'What people typed is translated for anyone using Hindi, Kannada, Tamil, Telugu or Malayalam.'
              : 'Everything is shown as it was typed, and the API key is not used.'}
            details={org.typedTextTranslation
              ? 'On. For anyone who set the app to Hindi, Kannada, Tamil, Telugu or Malayalam, what other people typed — task titles and descriptions, remarks, names and notifications — is translated by the Claude API. Each text is translated once per language and saved, so it is paid for once. Switch it off to stop all use of the API key; everybody then reads it as it was typed.'
              : 'Off. Task titles, remarks, names and notifications are shown as they were typed, and the API key is not used. Switch it on to translate them for anyone who set the app to Hindi, Kannada, Tamil, Telugu or Malayalam.'}
            checked={org.typedTextTranslation} busy={busyField === 'typedTextTranslation'}
            onLabel="On" offLabel="Off"
            onChange={() => toggleOrg('typedTextTranslation', 'Could not update the translation setting')}>
            {t && (
              <>
                <div className="prm-metrics">
                  <div className="prm-metric">
                    <div className="prm-metric-value">{month.calls || 0}</div>
                    <div className="prm-metric-label">Calls this month</div>
                  </div>
                  <div className="prm-metric">
                    <div className="prm-metric-value">{month.strings || 0}</div>
                    <div className="prm-metric-label">Texts translated</div>
                  </div>
                  <div className="prm-metric">
                    <div className="prm-metric-value">{usd(month.costUsd)}</div>
                    <div className="prm-metric-label">
                      Cost{t.lastMonth?.calls ? ` · last ${usd(t.lastMonth.costUsd)}` : ''}
                    </div>
                  </div>
                </div>
                <p className="text-[11px] mt-2 opacity-60">Model: {t.model}</p>
                {!t.keySet && (
                  <div className="prm-notice is-warn">
                    <FiAlertTriangle size={14} className="mt-0.5 shrink-0" />
                    No API key is set on the server, so nothing is translated even when this is on.
                  </div>
                )}
              </>
            )}
          </SettingCard>

          {/* A SWITCH AGAIN (2026-09-28): is CEO/MD approval mandatory for an advance. */}
          <SettingCard
            icon={FiCheckCircle} hue="#d97706"
            title="CEO / MD approval for cash advances"
            summary={org.khataAdvanceApprovalRequired
              ? 'Advance requests go to the CEO or MD first, then to the cashbook manager who pays them.'
              : 'Advance requests go straight to the cashbook manager.'}
            details={org.khataAdvanceApprovalRequired
              ? 'Required. An employee’s advance request goes to the CEO and the MD first — either of them can approve it — and then to the cashbook manager, who pays it from a cash account. Only then does the amount reach the employee’s wallet. Switch it off and requests go straight to the cashbook manager; any still waiting on the CEO/MD go with them. A CEO or MD asking for their own advance always goes straight to the cashbook manager.'
              : 'Not required. An employee’s advance request goes straight to the cashbook manager, who decides it and pays it from a cash account. Switch it on and every request goes to the CEO and the MD first; any not yet paid that were filed while it was off go to them too.'}
            checked={org.khataAdvanceApprovalRequired} busy={busyField === 'khataAdvanceApprovalRequired'}
            onLabel="Required" offLabel="Not required"
            onChange={() => toggleOrg('khataAdvanceApprovalRequired', 'Could not update the advance approval setting')}>
            {orgNotice && (
              <div className="prm-notice" role="status">
                <FiCheck size={14} className="mt-0.5 shrink-0" /> {orgNotice}
              </div>
            )}
          </SettingCard>

          {/* THE ONE-TAP BOOK PDF (2026-09-30). */}
          <SettingCard
            icon={FiFileText} hue="#16a34a"
            title="Cashbook PDF — choice of report"
            summary={org.khataReportChoice
              ? 'The PDF button offers a choice: Day-wise with category summary (picked) or All entries.'
              : 'The PDF button builds the Day-wise with category summary in one tap, bills attached.'}
            details={org.khataReportChoice
              ? 'On. A book’s PDF button opens a short choice — Day-wise with category summary (already picked) or All entries — with the option to attach the bills, then builds it. Switch it off and the button builds the Day-wise with category summary in one tap.'
              : 'Off. A book’s PDF button builds the Day-wise with category summary in one tap, bills attached — no choice to make. Switch it on to offer All entries beside it as well.'}
            checked={org.khataReportChoice} busy={busyField === 'khataReportChoice'}
            onLabel="Choice offered" offLabel="Day-wise only"
            onChange={() => toggleOrg('khataReportChoice', 'Could not update the cashbook PDF setting')} />
        </div>
      )}

      <div className="prm-head">
        <span className="prm-head-title">Printed documents</span>
      </div>

      {/* The contact strip on the cashbook statement PDF. Only a Super Admin can
          change it, because the document goes outside the company. */}
      <section className="prm-set is-wide">
        <div className="prm-set-head">
          <span className="prm-set-icon" aria-hidden="true"><FiPrinter size={19} /></span>
          <div className="prm-set-main">
            <h3 className="prm-set-title">Statement footer</h3>
            <p className="prm-set-summary">Bottom line of every cashbook statement PDF.</p>
          </div>
        </div>

        <div className="prm-fields">
          <div>
            <label className="prm-label" htmlFor="footer-helpline">Help / contact number</label>
            <input id="footer-helpline" value={footer.helpline} maxLength={40} placeholder="+91 96069 98652"
              disabled={loading}
              onChange={(e) => { setFooter({ ...footer, helpline: e.target.value }); setFooterSaved(false); }}
              className="prm-input" />
          </div>
          <div>
            <label className="prm-label" htmlFor="footer-note">Small print (optional)</label>
            <input id="footer-note" value={footer.note} maxLength={120}
              placeholder="Queries on this statement within 7 days of receipt."
              disabled={loading}
              onChange={(e) => { setFooter({ ...footer, note: e.target.value }); setFooterSaved(false); }}
              className="prm-input" />
          </div>
        </div>

        {/* How the strip prints, from what is typed — the same one line
            services/cashbookEntriesPdf.js draws (drawFooter): "Generated by …
            HRMS · number · note", page count on the right. */}
        <div className="prm-preview" aria-label="Footer preview">
          <div className="prm-preview-cap">Preview · bottom of every page</div>
          <div className="prm-preview-strip">
            <span className="min-w-0 flex-1">
              {[`Generated by ${COMPANY_NAME} HRMS`, footer.helpline.trim(), footer.note.trim()].filter(Boolean).join(' · ')}
            </span>
            <span className="prm-preview-muted">Page 1 of 1</span>
          </div>
        </div>

        <div className="prm-save-row">
          <button type="button" onClick={saveFooter} disabled={footerSaving || loading || !footerDirty}
            className="trn-btn is-primary accent-bg text-white">
            {footerSaving ? 'Saving…' : 'Save footer'}
          </button>
          {footerDirty && (
            <button type="button" className="trn-btn" onClick={() => { setFooter(org.documentFooter); setFooterSaved(false); }}>
              Discard
            </button>
          )}
          {footerDirty ? (
            <span className="prm-dirty">Unsaved changes</span>
          ) : footerSaved ? (
            <span className="prm-saved"><FiCheck size={13} /> Saved</span>
          ) : null}
        </div>
      </section>
    </div>
  );
}
