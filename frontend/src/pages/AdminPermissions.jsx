/**
 * AdminPermissions — every access decision in the portal, on one screen.
 *
 * 2026-10-03 REDESIGN (user: "redesign this whole page to make it more premium
 * and user friendly"). The tabs are now cards that say what each is for, and
 * each tab opens with a short "how this works" banner:
 *
 *   People & access        (Super Admin)  components/permissions/PeopleAccess
 *     one row per account with what it holds; a drawer with every grant
 *     explained; the old people × grants matrix kept as a second view.
 *   Organisation           (Super Admin)  components/permissions/OrgSettings
 *     the company-wide switches as cards, the long explanations folded away,
 *     and the statement footer with a live preview. These used to sit above the
 *     matrix as a wall of paragraphs; they are their own tab now.
 *   Leave approvals        (leaveHierarchy.manage)
 *   Regularization approvals (regularizationHierarchy.manage / hierarchy.manage)
 *     each employee's ladder drawn as connected steps.
 *   Cash Out categories    (canManageCashOutCategories)
 *     the list beside a live preview of the dropdown employees see.
 *
 * WHO SEES WHICH TAB is unchanged — each tab keeps the grant it always had, so
 * nobody gained or lost anything in the redesign. The `/admin/users/...` and
 * `/admin/org-settings` endpoints are restrictTo('SuperAdmin'); the ladders are
 * gated by hasExplicitPermission (which passes a Super Admin and an exec in
 * edit mode); the category list by the server's requireCashOutCategoryEditor,
 * mirrored here — which is also why this page is mounted in the employee
 * portal (/employee/permissions): a cashbook grant holder may have no admin
 * portal at all, and sees that one tab there. The sidebar entry is gated on the
 * same grants (`canOpenPermissions` in config/nav.jsx). An account holding none
 * of them gets the refusal card; the nav never offers them the page.
 *
 * The tab id is in the URL (useTabParam), so global search and a shared link
 * land on one. 'access' keeps its old id so existing links still work.
 */
import { useState } from 'react';
import {
  FiInfo, FiAlertCircle, FiUsers, FiSettings, FiCalendar, FiClock, FiTag,
} from 'react-icons/fi';
import PageHeader from '../components/PageHeader';
import { useTabParam } from '../hooks/useTabParam';
import PeopleAccess from '../components/permissions/PeopleAccess';
import OrgSettings from '../components/permissions/OrgSettings';
import LeaveApprovalHierarchy from '../components/permissions/LeaveApprovalHierarchy';
import RegularizationApprovalSetup from '../components/permissions/RegularizationApprovalSetup';
import CashOutCategories from '../components/permissions/CashOutCategories';
import { hasExplicitPermission, canManageCashOutCategories } from '../config/permissions';
import { useAuthStore } from '../store/authStore';

export default function AdminPermissions() {
  const me = useAuthStore((s) => s.user);
  const isSuperAdmin = me?.role === 'SuperAdmin';
  const canLeaveLadder = hasExplicitPermission(me, 'leaveHierarchy.manage');
  // Two keys, because `hierarchy.manage` governed this ladder before it was
  // given a key of its own.
  const canRegLadder = hasExplicitPermission(me, 'regularizationHierarchy.manage')
    || hasExplicitPermission(me, 'hierarchy.manage');
  // The server's own gate (requireCashOutCategoryEditor), mirrored — so a
  // read-only CEO/MD sees it too.
  const canCashOut = canManageCashOutCategories(me);

  const tabs = [
    ...(isSuperAdmin ? [
      { id: 'access', label: 'People & access', caption: 'What each account can reach', icon: FiUsers },
      { id: 'org', label: 'Organisation', caption: 'Company-wide switches', icon: FiSettings },
    ] : []),
    ...(canLeaveLadder ? [{ id: 'leave', label: 'Leave approvals', caption: 'Who signs off whose leave', icon: FiCalendar }] : []),
    ...(canRegLadder ? [{ id: 'regularization', label: 'Regularization approvals', caption: 'Who signs off attendance fixes', icon: FiClock }] : []),
    ...(canCashOut ? [{ id: 'cashout', label: 'Cash Out categories', caption: 'What expenses are filed under', icon: FiTag }] : []),
  ];
  // Falls back to whichever tab this account HAS.
  const [tab, setTab] = useTabParam(tabs[0]?.id || 'access', tabs.map((t) => t.id));
  // Owned here so the button can sit in the page header — the header is one
  // element across every tab, so the title never jumps as you switch.
  const [showGuide, setShowGuide] = useState(false);

  if (!tabs.length) {
    return (
      <div>
        <PageHeader title="Permissions" />
        <div className="prm-card flex items-start gap-3">
          <FiAlertCircle className="text-amber-600 mt-0.5 shrink-0" size={18} />
          <div>
            <p className="text-sm font-semibold">Super Admins only</p>
            <p className="text-sm opacity-65 mt-0.5">
              Granting access is the one thing that stays with the accounts that administer the system.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Permissions">
        {tab === 'access' && (
          <button type="button" onClick={() => setShowGuide((v) => !v)} aria-expanded={showGuide}
            className={`trn-btn${showGuide ? ' is-primary accent-bg text-white' : ''}`}>
            <FiInfo size={15} /> What these grants mean
          </button>
        )}
      </PageHeader>

      {/* Tab cards: icon, name, and one line on what the tab decides. No strip
          at all for an account that holds exactly one tab. */}
      {tabs.length > 1 && (
        <nav className="prm-tabs mb-5" aria-label="Permission areas">
          {tabs.map((t) => {
            const Icon = t.icon;
            return (
              <button key={t.id} type="button" onClick={() => setTab(t.id)}
                aria-current={tab === t.id ? 'page' : undefined}
                className={`prm-tab${tab === t.id ? ' is-on' : ''}`}>
                <span className="prm-tab-icon" aria-hidden="true"><Icon size={18} /></span>
                <span className="prm-tab-text">
                  <span className="prm-tab-label">{t.label}</span>
                  <span className="prm-tab-cap">{t.caption}</span>
                </span>
              </button>
            );
          })}
        </nav>
      )}

      {tab === 'leave' && canLeaveLadder ? <LeaveApprovalHierarchy />
        : tab === 'regularization' && canRegLadder ? <RegularizationApprovalSetup />
        : tab === 'cashout' && canCashOut ? <CashOutCategories />
        : tab === 'org' && isSuperAdmin ? <OrgSettings />
        : isSuperAdmin ? <PeopleAccess showGuide={showGuide} setShowGuide={setShowGuide} />
        : null}
    </div>
  );
}
