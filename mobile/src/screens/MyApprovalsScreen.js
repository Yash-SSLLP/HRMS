/**
 * MyApprovalsScreen — the reporting-chain approver inbox, mirroring the web's
 * /employee/approvals page. Three queues, all scoped server-side to the signed-in
 * user, so this renders for EVERY role: any employee can be someone's reporting
 * manager in the org chart, not just people holding the "Manager" role.
 *
 *   Leave        GET/PATCH /approvals/leave        — approve/reject my rung
 *   Resignations GET/PATCH /approvals/exits        — approve/reject my rung
 *   No-dues      GET/PATCH /approvals/clearances   — tick my assigned sections
 *
 * Emergency leave never enters the pending queue (it is granted on filing), so it
 * is pulled from the chain history and can be charged at double pay after the
 * fact — same control the web inbox offers.
 */
import React, { useCallback, useState } from 'react';
import { toast } from '../components/Toast';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { useAuth } from '../store/auth';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, Avatar, Pill, EmptyState, refresher, SectionHeader, Ionicons, SkeletonScreen } from '../components/ui';
import ChainProgress from '../components/ChainProgress';
import { fmtDate, fmtClock } from '../utils/format';

const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim() || 'Employee';
const empName = (r) => fullName(r.employee?.user);
// Regularization.employee refs User directly, not EmployeeProfile, so it is
// populated one level shallower than leave/exit requests.
const regName = (r) => fullName(r.employee);

/* ChainProgress now lives in components/ChainProgress.js so the employee's own
   leave list can show the same ladder — see that file for why. */

/** Approve / Reject pair used by both the leave and resignation queues. */
/** "In  9:15 AM → 10:00 AM" — hidden when this side isn't being changed. */
function ChangeLine({ label, from, to }) {
  if (!to) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 2 }}>
      <Text style={[font.small, { width: 28, color: colors.textMuted }]}>{label}</Text>
      <Text style={font.small}>{fmtClock(from) || '—'}</Text>
      <Text style={[font.small, { marginHorizontal: 6, color: colors.textMuted }]}>→</Text>
      <Text style={[font.small, { fontWeight: '700' }]}>{fmtClock(to) || '—'}</Text>
    </View>
  );
}

function DecideRow({ busy, onApprove, onReject }) {
  return (
    <View style={styles.actions}>
      <TouchableOpacity style={[styles.actBtn, styles.reject]} disabled={busy} onPress={onReject}>
        <Ionicons name="close" size={18} color={colors.danger} />
        <Text style={[styles.actText, { color: colors.danger }]}>Reject</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[styles.actBtn, styles.approve]} disabled={busy} onPress={onApprove}>
        <Ionicons name="checkmark" size={18} color="#fff" />
        <Text style={[styles.actText, { color: '#fff' }]}>Approve</Text>
      </TouchableOpacity>
    </View>
  );
}

export default function MyApprovalsScreen() {
  const me = useAuth((s) => s.user);
  const myId = me?._id;

  const [leave, setLeave] = useState([]);
  const [emergency, setEmergency] = useState([]);
  const [exits, setExits] = useState([]);
  const [clearances, setClearances] = useState([]);
  // Attendance corrections routed by the SuperAdmin-configured ladder.
  const [regularizations, setRegularizations] = useState([]);
  // Days someone punched in on while on approved leave. Not a ladder — the whole
  // hierarchy already granted the leave, so only its top rung rules on this.
  const [workOnLeave, setWorkOnLeave] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    const [lv, hist, ex, cl, rg, wol] = await Promise.all([
      api.get('/approvals/leave?scope=pending').catch(() => ({ data: {} })),
      api.get('/approvals/leave?scope=history').catch(() => ({ data: {} })),
      api.get('/approvals/exits?scope=pending').catch(() => ({ data: {} })),
      api.get('/approvals/clearances?scope=pending').catch(() => ({ data: {} })),
      api.get('/approvals/regularizations?scope=pending').catch(() => ({ data: {} })),
      api.get('/approvals/work-on-leave?scope=pending').catch(() => ({ data: {} })),
    ]);
    setLeave(lv.data?.requests || []);
    setEmergency(
      (hist.data?.requests || [])
        .filter((r) => r.leaveType === 'Emergency Leave' && r.status === 'Approved')
        .sort((a, b) => new Date(b.startDate) - new Date(a.startDate))
        .slice(0, 10)
    );
    setExits(ex.data?.requests || []);
    setClearances(cl.data?.requests || []);
    setRegularizations(rg.data?.requests || []);
    setWorkOnLeave(wol.data?.claims || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // ── Leave ────────────────────────────────────────────────────────────────
  const decideLeave = async (item, action) => {
    setBusyId(item._id);
    try {
      await api.patch(`/approvals/leave/${item._id}/${action}`, {});
      setLeave((prev) => prev.filter((x) => x._id !== item._id));
    } catch (err) {
      toast('Action failed', errMsg(err));
    } finally {
      setBusyId(null);
    }
  };

  const confirmLeaveReject = (item) => {
    Alert.alert('Reject leave?', `${empName(item)} · ${item.leaveType}`, [
      { text: 'Cancel' },
      { text: 'Reject', style: 'destructive', onPress: () => decideLeave(item, 'reject') },
    ]);
  };

  // ── Regularizations ──────────────────────────────────────────────────────
  // Approving the LAST rung is what actually rewrites the attendance record, so
  // a mid-ladder approval is safe: it only passes the request along.
  const decideRegularization = async (item, action) => {
    setBusyId(item._id);
    try {
      await api.patch(`/approvals/regularizations/${item._id}/${action}`, {});
      setRegularizations((prev) => prev.filter((x) => x._id !== item._id));
    } catch (err) {
      toast('Action failed', errMsg(err));
    } finally {
      setBusyId(null);
    }
  };

  const confirmRegularizationReject = (item) => {
    Alert.alert('Reject regularization?', `${regName(item)} · ${item.type} · ${fmtDate(item.date)}`, [
      { text: 'Cancel' },
      { text: 'Reject', style: 'destructive', onPress: () => decideRegularization(item, 'reject') },
    ]);
  };

  // Emergency leave needed nobody's approval, so this is the after-the-fact
  // control: the day costs 2× salary in that month's payroll. Reversible.
  const toggleDoubleCut = (item) => {
    const apply = !item.doubleCut;
    const who = empName(item);
    Alert.alert(
      apply ? 'Charge at double pay?' : 'Remove double cut?',
      apply
        ? `${who} will lose 2 days' salary for ${item.totalDays} day(s) in this month's payroll.`
        : `${who} will be charged normally for this leave again.`,
      [
        { text: 'Cancel' },
        {
          text: apply ? 'Apply double cut' : 'Remove',
          style: apply ? 'destructive' : 'default',
          onPress: async () => {
            setBusyId(item._id);
            try {
              await api.patch(`/leave/emergency/${item._id}/double-cut`, { apply });
              await load();
            } catch (err) {
              Alert.alert('Action failed', errMsg(err));
            } finally {
              setBusyId(null);
            }
          },
        },
      ]
    );
  };

  // ── Worked on a leave day ────────────────────────────────────────────────
  // Approving hands the leave day back and turns the day into a worked one;
  // rejecting keeps the punches on the record but the day stays leave. Both are
  // one-shot — there is no next rung to pass it to.
  const decideWorkOnLeave = async (item, action) => {
    setBusyId(item._id);
    try {
      await api.patch(`/approvals/work-on-leave/${item._id}/${action}`, {});
      setWorkOnLeave((prev) => prev.filter((x) => x._id !== item._id));
    } catch (err) {
      toast('Action failed', errMsg(err));
    } finally {
      setBusyId(null);
    }
  };

  const confirmWorkOnLeave = (item, action) => {
    const approving = action === 'approve';
    const who = empName(item);
    Alert.alert(
      approving ? 'Count this day as worked?' : 'Reject the punch-in?',
      approving
        ? `${who}'s leave day on ${fmtDate(item.date)} will be returned to them and the day will count as worked.`
        : `${fmtDate(item.date)} will stay recorded as leave for ${who}. Their punches are kept on the record.`,
      [
        { text: 'Cancel' },
        {
          text: approving ? 'Approve' : 'Reject',
          style: approving ? 'default' : 'destructive',
          onPress: () => decideWorkOnLeave(item, action),
        },
      ]
    );
  };

  // ── Resignations ─────────────────────────────────────────────────────────
  const decideExit = async (item, action) => {
    setBusyId(item._id);
    try {
      await api.patch(`/approvals/exits/${item._id}/${action}`, {});
      setExits((prev) => prev.filter((x) => x._id !== item._id));
    } catch (err) {
      toast('Action failed', errMsg(err));
    } finally {
      setBusyId(null);
    }
  };

  const confirmExit = (item, action) => {
    const approving = action === 'approve';
    Alert.alert(
      approving ? 'Approve resignation?' : 'Reject resignation?',
      approving
        ? `${empName(item)} will move to their notice period once the whole chain has approved.`
        : `${empName(item)}'s resignation will be cancelled.`,
      [
        { text: 'Cancel' },
        {
          text: approving ? 'Approve' : 'Reject',
          style: approving ? 'default' : 'destructive',
          onPress: () => decideExit(item, action),
        },
      ]
    );
  };

  // ── No-dues clearance ────────────────────────────────────────────────────
  // Only the sections HR assigned to me on a given exit.
  const mySections = (r) =>
    (r.clearanceSections || []).filter((s) => String(s.assignedTo?._id || s.assignedTo || '') === String(myId || ''));

  const toggleClearanceItem = async (exit, section, idx, done) => {
    const items = section.items.map((it, i) => ({ done: i === idx ? done : !!it.done, note: it.note }));
    setBusyId(`${exit._id}:${section.key}:${idx}`);
    try {
      const { data } = await api.patch(`/approvals/clearances/${exit._id}/${section.key}`, { items });
      setClearances((prev) => prev.map((r) => (r._id === exit._id
        ? { ...r, clearanceSections: data.request.clearanceSections }
        : r)));
    } catch (err) {
      toast('Could not update', errMsg(err));
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  const nothing = !leave.length && !emergency.length && !exits.length && !clearances.length
    && !regularizations.length && !workOnLeave.length;

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        {nothing ? (
          <EmptyState
            icon="checkmark-done-outline"
            title="Nothing waiting on you"
            subtitle="Leave, regularizations, resignations and no-dues clearances that need your approval will appear here."
          />
        ) : null}

        {/* Leave awaiting my rung */}
        {leave.length > 0 && (
          <>
            <SectionHeader title={`Leave (${leave.length})`} />
            {leave.map((it) => (
              <Card key={it._id} style={{ marginBottom: spacing(3) }}>
                <View style={styles.head}>
                  <Avatar name={empName(it)} size={40} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={font.h3}>{empName(it)}</Text>
                    <Text style={font.label}>{it.leaveType} · {it.totalDays}d · {fmtDate(it.startDate)} → {fmtDate(it.endDate)}</Text>
                  </View>
                </View>
                {it.reason ? <Text style={[font.small, { marginTop: 8 }]}>{it.reason}</Text> : null}
                <ChainProgress chain={it.approvalChain} />
                <DecideRow
                  busy={busyId === it._id}
                  onApprove={() => decideLeave(it, 'approve')}
                  onReject={() => confirmLeaveReject(it)}
                />
              </Card>
            ))}
          </>
        )}

        {/* Punched in on a day they were on approved leave. I am the top of their
            leave hierarchy, so this is mine alone to decide — no next rung. */}
        {workOnLeave.length > 0 && (
          <>
            <SectionHeader title={`Worked on a leave day (${workOnLeave.length})`} />
            {workOnLeave.map((it) => (
              <Card key={it._id} style={{ marginBottom: spacing(3) }}>
                <View style={styles.head}>
                  <Avatar name={empName(it)} size={40} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={font.h3}>{empName(it)}</Text>
                    <Text style={font.label}>
                      {it.workOnLeave?.leaveType || 'Leave'} · {fmtDate(it.date)}
                    </Text>
                  </View>
                  <Pill label="On leave" tone="warning" />
                </View>
                <View style={{ marginTop: 8 }}>
                  <Text style={font.small}>
                    In {fmtClock(it.checkIn) || '—'} · Out {fmtClock(it.checkOut) || '—'}
                    {it.hoursWorked > 0 ? ` · ${it.hoursWorked} h` : ''}
                  </Text>
                  <Text style={[font.small, { marginTop: 6, color: colors.textMuted }]}>
                    Approving returns the leave day and records the day as worked. Rejecting keeps the
                    punches on the record but the day stays as leave.
                  </Text>
                </View>
                <DecideRow
                  busy={busyId === it._id}
                  onApprove={() => confirmWorkOnLeave(it, 'approve')}
                  onReject={() => confirmWorkOnLeave(it, 'reject')}
                />
              </Card>
            ))}
          </>
        )}

        {/* Attendance regularizations awaiting my rung. Only employees whose
            SuperAdmin-configured ladder names me reach this queue. */}
        {regularizations.length > 0 && (
          <>
            <SectionHeader title={`Regularizations (${regularizations.length})`} />
            {regularizations.map((it) => (
              <Card key={it._id} style={{ marginBottom: spacing(3) }}>
                <View style={styles.head}>
                  <Avatar name={regName(it)} size={40} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={font.h3}>{regName(it)}</Text>
                    <Text style={font.label}>{it.type} · {fmtDate(it.date)}</Text>
                  </View>
                </View>
                {/* What the punch is now vs what it would become. Only the side
                    actually being corrected is shown. */}
                <View style={{ marginTop: 8 }}>
                  <ChangeLine label="In" from={it.previousCheckIn || it.current?.checkIn} to={it.requestedCheckIn} />
                  <ChangeLine label="Out" from={it.previousCheckOut || it.current?.checkOut} to={it.requestedCheckOut} />
                </View>
                {it.reason ? <Text style={[font.small, { marginTop: 8 }]}>{it.reason}</Text> : null}
                <ChainProgress chain={it.approvalChain} />
                <DecideRow
                  busy={busyId === it._id}
                  onApprove={() => decideRegularization(it, 'approve')}
                  onReject={() => confirmRegularizationReject(it)}
                />
              </Card>
            ))}
          </>
        )}

        {/* Resignations awaiting my rung */}
        {exits.length > 0 && (
          <>
            <SectionHeader title={`Resignations (${exits.length})`} />
            {exits.map((it) => (
              <Card key={it._id} style={{ marginBottom: spacing(3) }}>
                <View style={styles.head}>
                  <Avatar name={empName(it)} size={40} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={font.h3}>{empName(it)}</Text>
                    <Text style={font.label}>
                      {it.type || 'Resignation'} · LWD {fmtDate(it.lastWorkingDay)} · {it.noticePeriodDays ?? '-'}d notice
                    </Text>
                  </View>
                </View>
                {it.reason ? <Text style={[font.small, { marginTop: 8 }]}>{it.reason}</Text> : null}
                <ChainProgress chain={it.approvalChain} />
                <DecideRow
                  busy={busyId === it._id}
                  onApprove={() => confirmExit(it, 'approve')}
                  onReject={() => confirmExit(it, 'reject')}
                />
              </Card>
            ))}
          </>
        )}

        {/* No-dues sections HR assigned to me */}
        {clearances.length > 0 && (
          <>
            <SectionHeader title={`No-dues clearance (${clearances.length})`} />
            {clearances.map((r) => (
              <Card key={r._id} style={{ marginBottom: spacing(3) }}>
                <View style={styles.head}>
                  <Avatar name={empName(r)} size={40} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={font.h3}>{empName(r)}</Text>
                    <Text style={font.label}>
                      {r.employee?.designation || r.employee?.employeeCode || ''} · last working day {fmtDate(r.lastWorkingDay)}
                    </Text>
                  </View>
                </View>
                {mySections(r).map((s) => (
                  <View key={s.key} style={styles.section}>
                    <View style={styles.sectionHead}>
                      <Text style={[font.body, { fontWeight: '700', flex: 1 }]}>{s.title}</Text>
                      <Pill label={s.completed ? 'Cleared' : 'Pending'} tone={s.completed ? 'success' : 'neutral'} />
                    </View>
                    <Text style={[font.small, { marginBottom: 6 }]}>Tick each item once it has been handed back.</Text>
                    {s.items.map((it, idx) => {
                      const key = `${r._id}:${s.key}:${idx}`;
                      return (
                        <TouchableOpacity
                          key={idx}
                          style={styles.checkRow}
                          activeOpacity={0.7}
                          disabled={busyId === key}
                          onPress={() => toggleClearanceItem(r, s, idx, !it.done)}
                        >
                          <Ionicons
                            name={it.done ? 'checkbox' : 'square-outline'}
                            size={20}
                            color={it.done ? colors.success : colors.borderStrong}
                          />
                          <Text style={[font.body, { flex: 1, marginLeft: 10 }]}>{it.label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                ))}
              </Card>
            ))}
          </>
        )}

        {/* Emergency leave — already granted, shown so it can be reviewed. */}
        {emergency.length > 0 && (
          <>
            <SectionHeader title={`Emergency leave (${emergency.length})`} />
            {emergency.map((it) => (
              <Card key={it._id} style={{ marginBottom: spacing(3) }}>
                <View style={styles.head}>
                  <Avatar name={empName(it)} size={40} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={font.h3}>{empName(it)}</Text>
                    <Text style={font.label}>{it.totalDays}d · {fmtDate(it.startDate)} → {fmtDate(it.endDate)}</Text>
                    {it.emergencyFlagged ? (
                      <Text style={[font.small, { color: colors.danger, marginTop: 2 }]}>
                        ⚑ {it.emergencyIndexInMonth} emergency leaves that month
                      </Text>
                    ) : null}
                    {it.doubleCut ? (
                      <Text style={[font.small, { color: colors.danger, fontWeight: '700', marginTop: 2 }]}>
                        Charged at double pay
                      </Text>
                    ) : null}
                  </View>
                </View>
                {it.reason ? <Text style={[font.small, { marginTop: 8 }]}>{it.reason}</Text> : null}
                <View style={styles.actions}>
                  <TouchableOpacity
                    style={[styles.actBtn, it.doubleCut ? styles.neutralBtn : styles.reject]}
                    disabled={busyId === it._id}
                    onPress={() => toggleDoubleCut(it)}
                  >
                    <Ionicons name={it.doubleCut ? 'arrow-undo' : 'trending-down'} size={18} color={colors.danger} />
                    <Text style={[styles.actText, { color: colors.danger }]}>
                      {it.doubleCut ? 'Undo double cut' : 'Double cut'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </Card>
            ))}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  actBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 44, borderRadius: radius.md },
  approve: { backgroundColor: colors.success },
  reject: { backgroundColor: colors.dangerSoft },
  neutralBtn: { backgroundColor: colors.dangerSoft, opacity: 0.7 },
  actText: { fontWeight: '700', fontSize: 14, marginLeft: 6 },
  section: { marginTop: spacing(3), backgroundColor: colors.bg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing(3) },
  sectionHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  checkRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
});
