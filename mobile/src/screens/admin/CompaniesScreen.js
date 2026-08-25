/**
 * CompaniesScreen — the companies (legal entities) the HRMS runs for, and who
 * belongs to each. The mobile counterpart of the web Companies page.
 *
 * WHO SEES WHAT, mirroring the web and the server:
 *   HR Manager        → reads the list and each roster; no buttons at all.
 *                       The headcount per entity is useful to them, changing
 *                       the entity is not their call.
 *   Backend / CEO / MD → add, rename, deactivate, delete, and move people
 *                       between companies.
 * A CEO/MD narrowed to certain companies (User.companies) manages only those;
 * the rest are shown for reference with their controls hidden, which is the
 * same answer `assertCompanyScope` gives on the server.
 *
 * The headcount is the way INTO the roster rather than a dead number: tapping
 * it opens the two-column view of who is in this company and who is not, with
 * each outsider showing the company they are in now — so adding somebody reads
 * as the move it actually is.
 *
 * Backend: GET/POST /companies, PUT/DELETE /companies/:id,
 * GET /companies/:id/employees, PATCH /companies/:id/employees {add, remove}.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { toast } from '../../components/Toast';
import api, { errMsg } from '../../api/client';
import { useAuth } from '../../store/auth';
import { isAdmin, isExec } from '../../utils/roles';
import { colors, radius, spacing, font } from '../../theme';
import {
  Screen, Card, AppButton, Field, Input, Pill, EmptyState, ModalSheet,
  refresher, Ionicons, SkeletonScreen,
} from '../../components/ui';

// Roles that may change a company. Mirrors MAY_MANAGE in the company router.
const MANAGER_ROLES = ['SuperAdmin', 'CEO', 'MD'];

const blank = () => ({ _id: null, name: '', code: '', isActive: true });

export default function CompaniesScreen() {
  const me = useAuth((s) => s.user);
  // Read access matches the web nav: admins and executives.
  const mayView = isAdmin(me) || isExec(me);
  const mayManage = MANAGER_ROLES.includes(me?.role);

  // A narrowed executive manages only their own companies — the same rule
  // assertCompanyScope applies server-side, mirrored so a control that would
  // only ever 403 is never drawn.
  const myCompanies = (me?.companies || []).map(String);
  const limited = me?.role !== 'SuperAdmin' && myCompanies.length > 0;
  const canEditCompany = (c) => mayManage && (!limited || myCompanies.includes(String(c._id)));
  const canCreate = mayManage && !limited;

  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [form, setForm] = useState(null);   // the add/edit sheet
  const [saving, setSaving] = useState(false);

  const [roster, setRoster] = useState(null); // { company, members, others }
  const [rosterBusy, setRosterBusy] = useState(false);
  const [rosterQ, setRosterQ] = useState('');

  const load = useCallback(async () => {
    const { data } = await api.get('/companies').catch(() => ({ data: {} }));
    setCompanies(data.companies || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => {
    if (mayView) load(); else setLoading(false);
  }, [load, mayView]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // ----- add / edit -----
  const save = async () => {
    const name = (form.name || '').trim();
    if (!name) { toast('Name required', 'A company needs a name.'); return; }
    setSaving(true);
    try {
      const payload = { name, code: (form.code || '').trim(), isActive: form.isActive };
      if (form._id) await api.put(`/companies/${form._id}`, payload);
      else await api.post('/companies', payload);
      setForm(null);
      await load();
    } catch (err) {
      toast('Could not save', errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = (c) => {
    Alert.alert('Delete company', `Delete "${c.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try { await api.delete(`/companies/${c._id}`); await load(); }
          // The server refuses while anybody is still assigned, and says how
          // many — that message is more useful than a generic failure.
          catch (err) { toast('Could not delete', errMsg(err)); }
        },
      },
    ]);
  };

  // ----- who belongs here -----
  const openRoster = async (c) => {
    setRosterQ('');
    setRoster({ company: c, members: null, others: null }); // opens with a spinner
    try {
      const { data } = await api.get(`/companies/${c._id}/employees`);
      setRoster(data);
    } catch (err) {
      toast('Could not load employees', errMsg(err));
      setRoster(null);
    }
  };

  const moveEmployee = async (profileId, into) => {
    if (!roster) return;
    setRosterBusy(true);
    try {
      await api.patch(`/companies/${roster.company._id}/employees`,
        into ? { add: [profileId] } : { remove: [profileId] });
      const { data } = await api.get(`/companies/${roster.company._id}/employees`);
      setRoster(data);
      await load(); // the headcount on the cards behind the sheet
    } catch (err) {
      toast('Could not update', errMsg(err));
    } finally {
      setRosterBusy(false);
    }
  };

  const rosterFilter = (list) => {
    const t = rosterQ.trim().toLowerCase();
    if (!t) return list || [];
    return (list || []).filter((m) => `${m.name} ${m.employeeCode} ${m.email} ${m.designation} ${m.department}`
      .toLowerCase().includes(t));
  };

  const rosterEditable = roster ? canEditCompany(roster.company) : false;
  const limitedNote = useMemo(() => (
    myCompanies.length === 1 ? 'that one' : 'those'
  ), [myCompanies.length]);

  if (!mayView) {
    return (
      <Screen>
        <EmptyState
          icon="lock-closed-outline"
          title="Not your area"
          subtitle="The companies list is for HR, the Backend account and the executives."
        />
      </Screen>
    );
  }
  if (loading) return <Screen><SkeletonScreen /></Screen>;

  return (
    <Screen edges={[]}>
      <ScrollView
        contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }}
        refreshControl={refresher(refreshing, onRefresh)}
      >
        {/* Say why the buttons are missing rather than leaving a screen that
            looks broken. Two different reasons, two different sentences. */}
        {!mayManage ? (
          <Text style={styles.note}>
            You can see the companies and their headcounts here. Adding, editing and removing a company is
            done by the Backend account or a CEO/MD.
          </Text>
        ) : limited ? (
          <Text style={styles.note}>
            Your account is assigned to {myCompanies.length === 1 ? 'one company' : `${myCompanies.length} companies`},
            so you can edit {limitedNote} only. The others are shown for reference.
          </Text>
        ) : null}

        {canCreate ? (
          <AppButton
            title="Add company"
            icon="add"
            onPress={() => setForm(blank())}
            style={{ marginBottom: spacing(3) }}
          />
        ) : null}

        {companies.length === 0 ? (
          <EmptyState
            icon="business-outline"
            title="No companies yet"
            subtitle="Add one, then set it on each employee's record."
          />
        ) : companies.map((c) => (
          <Card key={c._id} style={{ marginBottom: spacing(2.5) }}>
            <View style={styles.rowTop}>
              <View style={{ flex: 1, paddingRight: spacing(2) }}>
                <Text style={font.h3} numberOfLines={1}>{c.name}</Text>
                {c.code ? <Text style={styles.code}>{c.code}</Text> : null}
              </View>
              <Pill label={c.isActive === false ? 'Inactive' : 'Active'} tone={c.isActive === false ? 'neutral' : 'success'} />
            </View>

            <TouchableOpacity onPress={() => openRoster(c)} style={styles.countRow} activeOpacity={0.7}>
              <Ionicons name="people-outline" size={16} color={colors.textMuted} />
              <Text style={styles.countText}>
                {c.assignedCount} employee{c.assignedCount === 1 ? '' : 's'}
              </Text>
              <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
            </TouchableOpacity>

            <View style={styles.actions}>
              <TouchableOpacity onPress={() => openRoster(c)}>
                <Text style={styles.link}>{canEditCompany(c) ? 'Employees' : 'View employees'}</Text>
              </TouchableOpacity>
              {canEditCompany(c) ? (
                <>
                  <TouchableOpacity onPress={() => setForm({ _id: c._id, name: c.name, code: c.code || '', isActive: c.isActive !== false })}>
                    <Text style={styles.link}>Edit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => remove(c)} style={{ marginLeft: 'auto' }}>
                    <Text style={styles.danger}>Delete</Text>
                  </TouchableOpacity>
                </>
              ) : null}
            </View>
          </Card>
        ))}
      </ScrollView>

      {/* ---------------- Add / edit ---------------- */}
      {form ? (
        <ModalSheet
          visible
          onClose={() => setForm(null)}
          title={form._id ? 'Edit company' : 'Add company'}
          footer={<AppButton title={form._id ? 'Save' : 'Add company'} onPress={save} loading={saving} />}
        >
          <Field label="Name" required>
            <Input
              value={form.name}
              onChangeText={(v) => setForm((f) => ({ ...f, name: v }))}
              placeholder="e.g. Sequence Surfaces LLP"
            />
          </Field>
          <Field label="Short code">
            <Input
              value={form.code}
              onChangeText={(v) => setForm((f) => ({ ...f, code: v }))}
              placeholder="e.g. SSL"
              autoCapitalize="characters"
            />
          </Field>
          <TouchableOpacity
            style={styles.checkRow}
            onPress={() => setForm((f) => ({ ...f, isActive: !f.isActive }))}
            activeOpacity={0.7}
          >
            <Ionicons
              name={form.isActive ? 'checkbox' : 'square-outline'}
              size={22}
              color={form.isActive ? colors.primary : colors.borderStrong}
            />
            <Text style={[font.body, { marginLeft: 10 }]}>Active</Text>
          </TouchableOpacity>
        </ModalSheet>
      ) : null}

      {/* ---------------- Who belongs here ---------------- */}
      {roster ? (
        <ModalSheet
          visible
          onClose={() => setRoster(null)}
          title={roster.company.name}
        >
          {roster.members === null ? (
            <Text style={font.small}>Loading…</Text>
          ) : (
            <>
              <Text style={[font.small, { marginBottom: spacing(3), lineHeight: 18 }]}>
                {rosterEditable
                  ? 'An employee belongs to one company. Adding somebody here moves them out of whichever company they are in now.'
                  : 'Read-only — assigning employees to a company is done by the Backend account or a CEO/MD.'}
              </Text>

              <Input
                value={rosterQ}
                onChangeText={setRosterQ}
                placeholder="Search name, code, designation…"
              />

              <Text style={styles.groupLabel}>IN THIS COMPANY ({roster.members.length})</Text>
              {rosterFilter(roster.members).length === 0 ? (
                <Text style={styles.empty}>
                  {roster.members.length === 0 ? 'Nobody is assigned to this company yet.' : 'Nobody here matches that search.'}
                </Text>
              ) : rosterFilter(roster.members).map((m) => (
                <View key={m._id} style={styles.person}>
                  <View style={{ flex: 1, paddingRight: spacing(2) }}>
                    <Text style={font.body} numberOfLines={1}>
                      {m.name}{m.isActive === false ? '  (inactive)' : ''}
                    </Text>
                    <Text style={font.small} numberOfLines={1}>
                      {[m.employeeCode, m.designation, m.department].filter(Boolean).join(' · ') || m.email}
                    </Text>
                  </View>
                  {rosterEditable ? (
                    <TouchableOpacity disabled={rosterBusy} onPress={() => moveEmployee(m._id, false)}>
                      <Text style={[styles.danger, rosterBusy && { opacity: 0.4 }]}>Remove</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ))}

              <Text style={styles.groupLabel}>EVERYONE ELSE ({roster.others.length})</Text>
              {rosterFilter(roster.others).length === 0 ? (
                <Text style={styles.empty}>
                  {roster.others.length === 0 ? 'Everybody is already in this company.' : 'Nobody else matches that search.'}
                </Text>
              ) : rosterFilter(roster.others).map((m) => (
                <View key={m._id} style={styles.person}>
                  <View style={{ flex: 1, paddingRight: spacing(2) }}>
                    <Text style={font.body} numberOfLines={1}>
                      {m.name}{m.isActive === false ? '  (inactive)' : ''}
                    </Text>
                    <Text style={font.small} numberOfLines={1}>
                      {[m.employeeCode, m.designation, m.department].filter(Boolean).join(' · ') || m.email}
                    </Text>
                    {/* Where they are NOW, so adding reads as a move. */}
                    <Text style={styles.current} numberOfLines={1}>
                      {m.companyName ? `Currently in ${m.companyName}` : 'No company'}
                    </Text>
                  </View>
                  {rosterEditable ? (
                    <TouchableOpacity disabled={rosterBusy} onPress={() => moveEmployee(m._id, true)}>
                      <Text style={[styles.link, rosterBusy && { opacity: 0.4 }]}>Add</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ))}
            </>
          )}
        </ModalSheet>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  note: {
    ...font.small,
    color: colors.textMuted,
    lineHeight: 18,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing(3),
    marginBottom: spacing(3),
  },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start' },
  code: { ...font.small, color: colors.textFaint, marginTop: 1 },
  countRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing(2.5) },
  countText: { ...font.body, color: colors.textMuted, flex: 1 },
  actions: {
    flexDirection: 'row', alignItems: 'center', gap: spacing(4),
    marginTop: spacing(3), paddingTop: spacing(2.5),
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  link: { ...font.small, color: colors.primaryDark, fontWeight: '700' },
  danger: { ...font.small, color: colors.danger, fontWeight: '700' },
  checkRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing(2) },
  groupLabel: {
    ...font.small, fontWeight: '800', letterSpacing: 0.5,
    marginTop: spacing(4), marginBottom: spacing(2),
  },
  person: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: spacing(2.5),
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  current: { fontSize: 11, color: colors.textFaint, marginTop: 2 },
  empty: { ...font.small, color: colors.textMuted },
});
