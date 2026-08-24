/**
 * PermissionsScreen — the Backend's access controls on the phone.
 *
 * Lists login accounts and opens one to grant or revoke what it may reach:
 * the standalone module grants (cashbook, expenses, employee advances and its
 * separate download, assets), the two per-employee attendance grants, an HR
 * Manager's capability list, and — for a CEO/MD — which companies they cover
 * and whether they may edit rather than only read.
 *
 * SUPER ADMIN ONLY, and not merely by hiding the menu row: every endpoint here
 * is `restrictTo('SuperAdmin')` on the server, so a non-SuperAdmin who reached
 * this screen would see a wall of switches that all fail. It refuses up front
 * instead.
 *
 * DELIBERATELY NOT HERE: org-wide settings (the chat switch, the document
 * footer text, logo and signature uploads). Those are typed, not toggled, and
 * belong on the web console — the footnote says so.
 *
 * Backend: GET /admin/users, GET /admin/permissions/catalog,
 * PATCH /admin/users/:id/{cashbook,expenses,assets,khata,khata-export,
 * exec-edit,wfh,remote-punch}-access, PATCH /admin/users/:id/permissions,
 * PATCH /admin/users/:id/companies.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Switch } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { toast } from '../../components/Toast';
import api, { errMsg } from '../../api/client';
import { useAuth } from '../../store/auth';
import { colors, radius, spacing, font } from '../../theme';
import {
  Screen, Card, Avatar, Input, Pill, EmptyState, ModalSheet, refresher, Ionicons, SkeletonScreen,
} from '../../components/ui';

const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();
const idOf = (u) => u?._id || u?.id;

// The standalone grants, in the order the web console lists them. `show` keeps a
// switch off the sheet when it cannot apply to that account.
const GRANTS = [
  {
    path: 'cashbook-access', field: 'cashbookAccess', label: 'Cashbook',
    hint: 'Open the cash accounts and their ledger, whatever their role.',
  },
  {
    path: 'expenses-access', field: 'expensesAccess', label: 'Expense claims',
    hint: 'Review and settle the claims already on file.',
  },
  {
    path: 'khata-access', field: 'khataAccess', label: 'Employee advances',
    hint: 'Hand out and settle cash for the people they deal with.',
  },
  {
    path: 'khata-export-access', field: 'khataExportAccess', label: 'Download advances data',
    hint: 'Separate on purpose: this puts every advance and expense on a file that can leave the building.',
  },
  {
    path: 'assets-access', field: 'assetsAccess', label: 'Assets register',
    hint: 'Look after company hardware without becoming an admin.',
  },
  {
    path: 'wfh-access', field: 'wfhAllowed', label: 'Work from home',
    hint: 'Their punches are exempt from the office-range check.',
    show: (u) => u.role !== 'CEO' && u.role !== 'MD',
  },
  {
    path: 'remote-punch-access', field: 'remotePunchAllowed', label: 'Punch from anywhere',
    hint: 'For site, field and travelling roles — punches are never flagged for being away from the office.',
    show: (u) => u.role !== 'CEO' && u.role !== 'MD',
  },
  {
    path: 'exec-edit-access', field: 'execEditAccess', label: 'Executive edit mode',
    hint: 'Lets this CEO/MD change things, not only read them. Never grants Backend-only powers.',
    show: (u) => u.role === 'CEO' || u.role === 'MD',
  },
];

export default function PermissionsScreen() {
  const me = useAuth((s) => s.user);
  const isSuperAdmin = me?.role === 'SuperAdmin';

  const [users, setUsers] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const [u, c, co] = await Promise.all([
      api.get('/admin/users').catch(() => ({ data: {} })),
      api.get('/admin/permissions/catalog').catch(() => ({ data: {} })),
      api.get('/companies').catch(() => ({ data: {} })),
    ]);
    setUsers(u.data?.users || []);
    setCatalog(c.data?.permissions || []);
    setCompanies(co.data?.companies || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { if (isSuperAdmin) load(); else setLoading(false); }, [load, isSuperAdmin]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // Keep the open sheet pointing at the freshly-loaded copy of that user.
  const syncSel = (list, current) => {
    if (!current) return null;
    return list.find((x) => String(idOf(x)) === String(idOf(current))) || current;
  };

  const refresh = async () => {
    const { data } = await api.get('/admin/users').catch(() => ({ data: {} }));
    const list = data?.users || [];
    setUsers(list);
    setSel((cur) => syncSel(list, cur));
  };

  const toggleGrant = async (user, grant, next) => {
    setBusy(grant.path);
    try {
      await api.patch(`/admin/users/${idOf(user)}/${grant.path}`, { enabled: next });
      await refresh();
    } catch (err) {
      toast('Could not update', errMsg(err));
    } finally {
      setBusy('');
    }
  };

  // An HR Manager with NO permissions array holds everything — a migration
  // default from before the catalogue existed. Saving an explicit list is what
  // narrows them, so the sheet shows that state rather than pretending it is empty.
  const hrHoldsAll = (u) => u?.role === 'HRManager' && !Array.isArray(u.permissions);

  const toggleCapability = async (user, key) => {
    const current = Array.isArray(user.permissions)
      ? user.permissions
      : catalog.map((p) => p.key); // start from "everything" when it is implicit
    const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
    setBusy(key);
    try {
      await api.patch(`/admin/users/${idOf(user)}/permissions`, { permissions: next });
      await refresh();
    } catch (err) {
      toast('Could not update', errMsg(err));
    } finally {
      setBusy('');
    }
  };

  const toggleCompany = async (user, companyId) => {
    const current = (user.companies || []).map(String);
    const next = current.includes(String(companyId))
      ? current.filter((c) => c !== String(companyId))
      : [...current, String(companyId)];
    setBusy(String(companyId));
    try {
      await api.patch(`/admin/users/${idOf(user)}/companies`, { companyIds: next });
      await refresh();
    } catch (err) {
      toast('Could not update', errMsg(err));
    } finally {
      setBusy('');
    }
  };

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return users;
    return users.filter((u) => `${fullName(u)} ${u.email || ''} ${u.role || ''}`.toLowerCase().includes(needle));
  }, [users, q]);

  if (!isSuperAdmin) {
    return (
      <Screen>
        <EmptyState
          icon="lock-closed-outline"
          title="Backend only"
          subtitle="Granting access is reserved for the Backend account."
        />
      </Screen>
    );
  }
  if (loading) return <Screen><SkeletonScreen /></Screen>;

  const isExec = sel?.role === 'CEO' || sel?.role === 'MD';

  return (
    <Screen edges={[]}>
      <View style={styles.search}>
        <Input value={q} onChangeText={setQ} placeholder="Search name, email or role" autoCapitalize="none" />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }}
        refreshControl={refresher(refreshing, onRefresh)}
        keyboardShouldPersistTaps="handled"
      >
        {filtered.length === 0 ? (
          <EmptyState icon="people-outline" title="No accounts" subtitle="Nothing matches that search." />
        ) : filtered.map((u) => (
          <TouchableOpacity key={idOf(u)} onPress={() => setSel(u)} activeOpacity={0.85}>
            <Card style={styles.row}>
              <Avatar name={fullName(u)} size={40} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={font.h3} numberOfLines={1}>{fullName(u) || u.email}</Text>
                <Text style={font.label} numberOfLines={1}>{u.email}</Text>
              </View>
              <Pill label={u.role} tone={u.isActive === false ? 'neutral' : 'primary'} />
            </Card>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {sel ? (
        <ModalSheet visible onClose={() => setSel(null)} title={fullName(sel) || sel.email}>
          <Text style={[font.label, { marginBottom: spacing(3) }]}>{sel.email} · {sel.role}</Text>

          <Text style={styles.head}>Module access</Text>
          {GRANTS.filter((g) => !g.show || g.show(sel)).map((g) => (
            <View key={g.path} style={styles.grantRow}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={font.body}>{g.label}</Text>
                <Text style={font.small}>{g.hint}</Text>
              </View>
              <Switch
                value={!!sel[g.field]}
                disabled={busy === g.path}
                onValueChange={(next) => toggleGrant(sel, g, next)}
                trackColor={{ true: colors.primary }}
              />
            </View>
          ))}

          {/* Which companies an executive covers. With none ticked they are
              unrestricted — worth saying, because an empty list looks like "none". */}
          {isExec && companies.length ? (
            <>
              <Text style={styles.head}>Companies</Text>
              <Text style={[font.small, { marginBottom: spacing(2) }]}>
                {(sel.companies || []).length
                  ? 'They see and manage only the companies ticked here.'
                  : 'Nothing ticked — they currently cover every company.'}
              </Text>
              {companies.filter((c) => c.isActive !== false).map((c) => {
                const on = (sel.companies || []).map(String).includes(String(c._id));
                return (
                  <TouchableOpacity
                    key={c._id}
                    style={styles.checkRow}
                    disabled={busy === String(c._id)}
                    onPress={() => toggleCompany(sel, c._id)}
                    activeOpacity={0.7}
                  >
                    <Ionicons name={on ? 'checkbox' : 'square-outline'} size={22}
                      color={on ? colors.primary : colors.borderStrong} />
                    <Text style={[font.body, { marginLeft: 10 }]}>{c.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </>
          ) : null}

          {/* The HR capability list. */}
          {sel.role === 'HRManager' && catalog.length ? (
            <>
              <Text style={styles.head}>HR capabilities</Text>
              {hrHoldsAll(sel) ? (
                <Text style={[font.small, { color: colors.warning, marginBottom: spacing(2) }]}>
                  No list has ever been set, so they hold every capability. Un-ticking one saves an explicit list.
                </Text>
              ) : null}
              {catalog.map((p) => {
                const on = hrHoldsAll(sel) || (sel.permissions || []).includes(p.key);
                return (
                  <TouchableOpacity
                    key={p.key}
                    style={styles.checkRow}
                    disabled={busy === p.key}
                    onPress={() => toggleCapability(sel, p.key)}
                    activeOpacity={0.7}
                  >
                    <Ionicons name={on ? 'checkbox' : 'square-outline'} size={22}
                      color={on ? colors.primary : colors.borderStrong} />
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={font.body}>{p.label}</Text>
                      {p.group ? <Text style={font.small}>{p.group}</Text> : null}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </>
          ) : null}

          <Text style={[font.small, { marginTop: spacing(4) }]}>
            Organisation settings — the chat switch, document footer, logo and signatures — are on the web console.
          </Text>
        </ModalSheet>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: { paddingHorizontal: spacing(4), paddingVertical: spacing(3), borderBottomWidth: 1, borderBottomColor: colors.border },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(2.5) },
  head: { ...font.label, fontWeight: '700', marginTop: spacing(4), marginBottom: spacing(2) },
  grantRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  checkRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9 },
});
