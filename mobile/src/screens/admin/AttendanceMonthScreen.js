import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';

import api, { errMsg } from '../../api/client';
import { colors, radius, spacing, font } from '../../theme';
import {
  Screen, Card, Pill, AppButton, Input, Field, Loader, EmptyState, refresher,
  ModalSheet, ChipSelect, Ionicons,
} from '../../components/ui';

const MONTHS_FULL = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const REG_TYPES = ['Missing Punch', 'Wrong Time', 'Forgot Check-in', 'Forgot Check-out', 'On Duty', 'Other'];
const STATUS = ['Present', 'Absent', 'HalfDay', 'WeeklyOff', 'Holiday', 'OnLeave'];

const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '—');
const toHM = (d) => {
  if (!d) return '';
  const t = new Date(d);
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
};
const hrsLabel = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')} hrs`;
const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

// Whole-month attendance for one employee (HR/admin): the summary bar with
// on-time / late / leave day counts and a per-day punch history — with late,
// distance and no-punch-out flags — plus Edit and Regularize actions.
export default function AttendanceMonthScreen() {
  const now = new Date();
  const [employees, setEmployees] = useState([]);
  const [employee, setEmployee] = useState('');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [editRec, setEditRec] = useState(null);
  const [regOpen, setRegOpen] = useState(false);
  const [form, setForm] = useState({});

  useEffect(() => {
    api.get('/employees').then(({ data }) => {
      const profiles = (data.profiles || []).filter((p) => p.user);
      setEmployees(profiles);
      if (profiles.length) setEmployee((e) => e || profiles[0]._id);
    }).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!employee) return;
    try {
      const { data } = await api.get(`/attendance/month-summary?employee=${employee}&year=${year}&month=${month}`);
      setData(data);
    } catch (err) {
      Alert.alert('Failed to load', errMsg(err));
    } finally {
      setLoading(false);
    }
  }, [employee, year, month]);
  useEffect(() => { load(); }, [load]);
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const shift = (dir) => {
    let m = month + dir, y = year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    setMonth(m); setYear(y);
  };

  const openEdit = (r) => {
    setEditRec(r);
    setForm({ status: r.status, checkIn: toHM(r.checkIn), checkOut: toHM(r.checkOut), remarks: r.remarks || '' });
  };
  const saveEdit = async () => {
    setBusy(true);
    try {
      const day = new Date(editRec.date);
      const at = (hm) => {
        const m = String(hm || '').match(/^(\d{1,2}):(\d{2})$/);
        return m ? new Date(day.getTime() + (Number(m[1]) * 60 + Number(m[2])) * 60000).toISOString() : null;
      };
      await api.put(`/attendance/${editRec._id}`, {
        status: form.status, checkIn: at(form.checkIn), checkOut: at(form.checkOut), remarks: form.remarks,
      });
      setEditRec(null); await load();
    } catch (err) { Alert.alert('Update failed', errMsg(err)); }
    finally { setBusy(false); }
  };

  const openReg = (r) => {
    setForm({
      type: r?.noPunchOut ? 'Forgot Check-out' : r ? 'Wrong Time' : 'Missing Punch',
      date: r ? new Date(r.date).toISOString().slice(0, 10) : '',
      checkIn: toHM(r?.checkIn), checkOut: toHM(r?.checkOut), reason: '',
    });
    setRegOpen(true);
  };
  const saveReg = async () => {
    if (!form.date || !form.reason) { Alert.alert('Missing info', 'Date and reason are required.'); return; }
    setBusy(true);
    try {
      await api.post('/regularizations/admin', {
        employee: data.employee.user._id,
        date: form.date,
        type: form.type,
        requestedCheckIn: form.checkIn || undefined,
        requestedCheckOut: form.checkOut || undefined,
        reason: form.reason,
      });
      setRegOpen(false); await load();
    } catch (err) { Alert.alert('Regularization failed', errMsg(err)); }
    finally { setBusy(false); }
  };

  if (loading) return <Screen><Loader text="Loading attendance" /></Screen>;

  const s = data?.summary;
  const barTotal = s ? Math.max(s.workingDays, s.onTime + s.late + s.leave, 1) : 1;
  const threshold = data?.settings?.geofenceThresholdM;
  const selected = employees.find((p) => p._id === employee);

  return (
    <Screen edges={[]}>
      {/* Employee picker + month switcher */}
      <TouchableOpacity style={styles.pickerBtn} onPress={() => setPickerOpen(true)} activeOpacity={0.7}>
        <Ionicons name="person-outline" size={16} color={colors.primary} />
        <Text style={styles.pickerText} numberOfLines={1}>
          {selected ? `${fullName(selected.user)} (${selected.employeeCode || '—'})` : 'Select employee'}
        </Text>
        <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
      </TouchableOpacity>
      <View style={styles.monthBar}>
        <TouchableOpacity onPress={() => shift(-1)} style={styles.nav}><Ionicons name="chevron-back" size={20} color={colors.primary} /></TouchableOpacity>
        <Text style={styles.monthTitle}>{MONTHS_FULL[month]} {year}</Text>
        <TouchableOpacity onPress={() => shift(1)} style={styles.nav}><Ionicons name="chevron-forward" size={20} color={colors.primary} /></TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 40 }} refreshControl={refresher(refreshing, onRefresh)}>
        {s && (
          <Card>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <Text style={font.h3}>{MONTHS_FULL[month]} {year}</Text>
              <Text style={font.small}>{s.workingDays} Working Days</Text>
            </View>
            <View style={styles.bar}>
              <View style={{ flex: s.onTime / barTotal, backgroundColor: colors.success }} />
              <View style={{ flex: s.late / barTotal, backgroundColor: colors.danger }} />
              <View style={{ flex: s.leave / barTotal, backgroundColor: '#f59e0b' }} />
              <View style={{ flex: Math.max(1 - (s.onTime + s.late + s.leave) / barTotal, 0), backgroundColor: colors.border }} />
            </View>
            <View style={styles.legend}>
              <Legend color={colors.success} label={`On time : ${s.onTime} Days`} />
              <Legend color={colors.danger} label={`Late : ${s.late} Days`} />
              <Legend color="#f59e0b" label={`Leave : ${s.leave} Days`} />
            </View>
            <View style={[styles.legend, { marginTop: 4 }]}>
              {s.noPunchOut > 0 ? <Text style={[font.small, { color: colors.danger }]}>No punch-out: {s.noPunchOut}</Text> : null}
              {s.distantPunches > 0 ? <Text style={[font.small, { color: '#ea580c' }]}>Distant: {s.distantPunches}</Text> : null}
              <Text style={font.small}>Total: {s.totalHours} hrs</Text>
            </View>
          </Card>
        )}

        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing(4), marginBottom: spacing(2) }}>
          <Text style={font.h3}>History</Text>
          <TouchableOpacity onPress={() => openReg(null)}><Text style={styles.link}>+ Regularize a day</Text></TouchableOpacity>
        </View>

        {!data?.records?.length ? (
          <EmptyState icon="calendar-outline" title="No records" subtitle="No attendance records for this month." />
        ) : data.records.map((r) => {
          const d = new Date(r.date);
          const worst = Math.max(r.checkInDistanceM ?? -1, r.checkOutDistanceM ?? -1);
          const distant = threshold && worst > threshold;
          return (
            <Card key={r._id} style={{ marginBottom: spacing(2), paddingVertical: spacing(3) }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={styles.dateCol}>
                  <Text style={styles.dateNum}>{d.getDate()}</Text>
                  <Text style={styles.dateMon}>{d.toLocaleString('en-IN', { month: 'short' })}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
                    <Text style={[font.body, r.lateMinutes > 0 && { color: colors.danger, fontWeight: '700' }]}>
                      → {fmtTime(r.checkIn)}{r.lateMinutes > 0 ? ` (+${r.lateMinutes}m)` : ''}
                    </Text>
                    {r.noPunchOut ? (
                      <Text style={[font.small, { color: colors.danger, fontWeight: '700' }]}>No punch-out</Text>
                    ) : (
                      <Text style={font.body}>← {fmtTime(r.checkOut)}</Text>
                    )}
                  </View>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 4 }}>
                    {r.hoursWorked > 0 ? (
                      <Text style={[styles.hrs, { color: r.hoursWorked >= 8 ? colors.success : colors.danger }]}>⏱ {hrsLabel(r.hoursWorked)}</Text>
                    ) : null}
                    {r.status !== 'Present' ? <Pill label={r.status} tone={r.status === 'OnLeave' ? 'warning' : 'neutral'} /> : null}
                    {(r.checkInWfh || r.checkOutWfh) ? <Pill label="WFH" tone="info" /> : null}
                    {distant ? <Pill label={worst >= 1000 ? `${(worst / 1000).toFixed(1)} km away` : `${worst} m away`} tone="warning" /> : null}
                  </View>
                </View>
                <View style={{ gap: 6 }}>
                  <TouchableOpacity onPress={() => openEdit(r)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="create-outline" size={20} color={colors.primary} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => openReg(r)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="build-outline" size={20} color={colors.textMuted} />
                  </TouchableOpacity>
                </View>
              </View>
            </Card>
          );
        })}
      </ScrollView>

      {/* Employee picker */}
      <ModalSheet visible={pickerOpen} onClose={() => setPickerOpen(false)} title="Select employee">
        {employees.map((p) => (
          <TouchableOpacity key={p._id} style={styles.empRow} onPress={() => { setEmployee(p._id); setPickerOpen(false); }}>
            <Text style={[font.body, p._id === employee && { color: colors.primary, fontWeight: '700' }]}>
              {fullName(p.user)} ({p.employeeCode || '—'})
            </Text>
            {p._id === employee ? <Ionicons name="checkmark" size={18} color={colors.primary} /> : null}
          </TouchableOpacity>
        ))}
      </ModalSheet>

      {/* Edit day */}
      <ModalSheet visible={!!editRec} onClose={() => setEditRec(null)}
        title={editRec ? `Edit · ${new Date(editRec.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}` : ''}
        footer={<AppButton title="Save" loading={busy} onPress={saveEdit} />}>
        <Field label="Status"><ChipSelect options={STATUS} value={form.status} onChange={(v) => setForm((p) => ({ ...p, status: v }))} /></Field>
        <View style={{ flexDirection: 'row', gap: spacing(3) }}>
          <View style={{ flex: 1 }}><Field label="Check-in (HH:mm)"><Input value={form.checkIn} onChangeText={(v) => setForm((p) => ({ ...p, checkIn: v }))} placeholder="10:00" keyboardType="numbers-and-punctuation" /></Field></View>
          <View style={{ flex: 1 }}><Field label="Check-out (HH:mm)"><Input value={form.checkOut} onChangeText={(v) => setForm((p) => ({ ...p, checkOut: v }))} placeholder="19:00" keyboardType="numbers-and-punctuation" /></Field></View>
        </View>
        <Field label="Remarks"><Input value={form.remarks} onChangeText={(v) => setForm((p) => ({ ...p, remarks: v }))} placeholder="Why is this being changed?" /></Field>
      </ModalSheet>

      {/* Regularize */}
      <ModalSheet visible={regOpen} onClose={() => setRegOpen(false)} title="Regularize attendance"
        footer={<AppButton title="Apply" loading={busy} onPress={saveReg} />}>
        <Text style={[font.small, { marginBottom: spacing(3) }]}>
          Applied to the day's record immediately and recorded as HR-approved.
        </Text>
        <Field label="Date (YYYY-MM-DD)"><Input value={form.date} onChangeText={(v) => setForm((p) => ({ ...p, date: v }))} placeholder="2026-07-01" autoCapitalize="none" /></Field>
        <Field label="Type"><ChipSelect options={REG_TYPES} value={form.type} onChange={(v) => setForm((p) => ({ ...p, type: v }))} /></Field>
        <View style={{ flexDirection: 'row', gap: spacing(3) }}>
          <View style={{ flex: 1 }}><Field label="Check-in (HH:mm)"><Input value={form.checkIn} onChangeText={(v) => setForm((p) => ({ ...p, checkIn: v }))} placeholder="10:00" /></Field></View>
          <View style={{ flex: 1 }}><Field label="Check-out (HH:mm)"><Input value={form.checkOut} onChangeText={(v) => setForm((p) => ({ ...p, checkOut: v }))} placeholder="19:00" /></Field></View>
        </View>
        <Field label="Reason"><Input value={form.reason} onChangeText={(v) => setForm((p) => ({ ...p, reason: v }))} placeholder="e.g. forgot to punch out" multiline /></Field>
      </ModalSheet>
    </Screen>
  );
}

function Legend({ color, label }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: color }} />
      <Text style={font.small}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pickerBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: spacing(4), marginTop: spacing(3),
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, paddingHorizontal: 12, height: 44,
  },
  pickerText: { ...font.body, flex: 1, fontWeight: '600' },
  monthBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing(5), paddingVertical: spacing(2) },
  nav: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  monthTitle: { fontSize: 16, fontWeight: '800', color: colors.text },
  bar: { flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', marginTop: spacing(3), backgroundColor: colors.border },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: spacing(2.5) },
  dateCol: { width: 40, alignItems: 'center', marginRight: 8 },
  dateNum: { fontSize: 16, fontWeight: '800', color: colors.primary },
  dateMon: { fontSize: 10, color: colors.textMuted },
  hrs: { fontSize: 12.5, fontWeight: '800' },
  link: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  empRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing(3), borderBottomWidth: 1, borderBottomColor: colors.border },
});
