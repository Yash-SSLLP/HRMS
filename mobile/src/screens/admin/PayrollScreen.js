import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import api, { API_BASE, errMsg } from '../../api/client';
import { useAuth } from '../../store/auth';
import { canApprove } from '../../utils/roles';
import { colors, radius, spacing, font } from '../../theme';
import { Screen, Card, Avatar, Pill, Loader, EmptyState, refresher, Ionicons } from '../../components/ui';
import MailComposeSheet from '../../components/MailComposeSheet';
import { rupees } from '../../utils/format';

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const STATUSES = ['All', 'Draft', 'Approved', 'Paid', 'OnHold'];
const STATUS_TONE = { Draft: 'neutral', Approved: 'info', Paid: 'success', OnHold: 'warning' };
const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

export default function PayrollScreen() {
  const token = useAuth((s) => s.token);
  const writable = canApprove(useAuth((s) => s.user?.role));

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [status, setStatus] = useState('All');
  const [payslips, setPayslips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [mailSheet, setMailSheet] = useState(null); // editable email preview payload

  const load = useCallback(async (y, m, s) => {
    setLoading(true);
    const q = `year=${y}&month=${m}${s && s !== 'All' ? `&status=${s}` : ''}`;
    const { data } = await api.get(`/payroll?${q}`).catch(() => ({ data: {} }));
    setPayslips(data.payslips || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(year, month, status); }, [load, year, month, status]));
  const onRefresh = async () => { setRefreshing(true); await load(year, month, status); setRefreshing(false); };

  const shift = (dir) => {
    let m = month + dir, y = year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    setMonth(m); setYear(y);
  };

  const act = async (p, kind) => {
    setBusyId(p._id);
    try {
      await api.patch(`/payroll/${p._id}/${kind === 'approve' ? 'approve' : 'pay'}`, {});
      await load(year, month, status);
    } catch (err) {
      Alert.alert('Action failed', errMsg(err));
    } finally {
      setBusyId(null);
    }
  };

  const confirmPay = (p) => {
    Alert.alert('Mark as paid?', `${fullName(p.employee?.user)} · ${rupees(p.netPay)}`, [
      { text: 'Cancel' },
      { text: 'Mark paid', onPress: () => act(p, 'pay') },
    ]);
  };

  const downloadPdf = async (p) => {
    setBusyId(p._id);
    try {
      const fileUri = `${FileSystem.cacheDirectory}payslip-${p.payPeriodYear}-${String(p.payPeriodMonth).padStart(2, '0')}.pdf`;
      const res = await FileSystem.downloadAsync(`${API_BASE}/payroll/${p._id}/pdf`, fileUri, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status !== 200) throw new Error('Payslip PDF not available');
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(res.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' });
    } catch (err) {
      Alert.alert('Download failed', err.message);
    } finally {
      setBusyId(null);
    }
  };

  // Download the whole month's payroll as an Excel-compatible CSV and hand it
  // to the OS share sheet (save / send anywhere).
  const exportExcel = async () => {
    setBusyId('export');
    try {
      const fileUri = `${FileSystem.cacheDirectory}payroll-${year}-${String(month).padStart(2, '0')}.csv`;
      const q = `year=${year}&month=${month}${status !== 'All' ? `&status=${status}` : ''}`;
      const res = await FileSystem.downloadAsync(`${API_BASE}/payroll/export?${q}`, fileUri, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status !== 200) throw new Error('Export not available');
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(res.uri, { mimeType: 'text/csv' });
    } catch (err) {
      Alert.alert('Export failed', err.message);
    } finally {
      setBusyId(null);
    }
  };

  // Email a payslip from the company mailbox with the payslip PDF attached:
  // fetch the server-rendered editable preview, then send it server-side.
  const emailPayslip = async (p) => {
    const email = p.employee?.user?.email;
    if (!email) { Alert.alert('No email', 'No email on file for this employee.'); return; }
    setBusyId(p._id);
    try {
      const { data } = await api.post(`/payroll/${p._id}/email`, { preview: true });
      setMailSheet({
        title: 'Send payslip',
        note: "Review and edit the message · it's emailed from the company mailbox with the payslip PDF attached.",
        to: data.to,
        subject: data.subject,
        body: data.body,
        attachments: data.attachments || [],
        link: data.link,
        sendLabel: 'Send payslip',
        onSend: async ({ subject, body }) => {
          await api.post(`/payroll/${p._id}/email`, { subject, body });
          await load(year, month, status);
        },
      });
    } catch (err) {
      Alert.alert('Could not prepare the payslip email', errMsg(err));
    } finally {
      setBusyId(null);
    }
  };

  const totalNet = payslips.reduce((a, p) => a + (p.netPay || 0), 0);

  return (
    <Screen edges={[]}>
      {/* Month switcher */}
      <View style={styles.monthBar}>
        <TouchableOpacity onPress={() => shift(-1)} style={styles.nav}><Ionicons name="chevron-back" size={22} color={colors.primary} /></TouchableOpacity>
        <View style={{ alignItems: 'center' }}>
          <Text style={styles.monthTitle}>{MONTHS_FULL[month]} {year}</Text>
          <Text style={font.small}>{payslips.length} payslips · {rupees(totalNet)} net</Text>
        </View>
        <TouchableOpacity onPress={() => shift(1)} style={styles.nav}><Ionicons name="chevron-forward" size={22} color={colors.primary} /></TouchableOpacity>
      </View>

      {/* Status filter */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filters} contentContainerStyle={{ paddingHorizontal: spacing(4), gap: 8 }}>
        {STATUSES.map((s) => (
          <TouchableOpacity key={s} onPress={() => setStatus(s)} style={[styles.chip, status === s && styles.chipActive]}>
            <Text style={[styles.chipText, status === s && { color: '#fff' }]}>{s}</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity onPress={exportExcel} disabled={busyId === 'export'} style={[styles.chip, { flexDirection: 'row', alignItems: 'center', gap: 5 }]}>
          <Ionicons name="download-outline" size={14} color={colors.primary} />
          <Text style={[styles.chipText, { color: colors.primary }]}>{busyId === 'export' ? 'Exporting…' : 'Excel'}</Text>
        </TouchableOpacity>
      </ScrollView>

      {loading ? (
        <Loader />
      ) : (
        <ScrollView contentContainerStyle={payslips.length ? { padding: spacing(4) } : { flex: 1 }} refreshControl={refresher(refreshing, onRefresh)}>
          {payslips.length === 0 ? (
            <EmptyState icon="cash-outline" title="No payslips" subtitle={`No ${status !== 'All' ? status.toLowerCase() + ' ' : ''}payslips for ${MONTHS[month]} ${year}.`} />
          ) : (
            payslips.map((p) => (
              <Card key={p._id} style={{ marginBottom: spacing(3) }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Avatar name={fullName(p.employee?.user)} size={42} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={font.h3}>{fullName(p.employee?.user)}</Text>
                    <Text style={font.label}>{p.employee?.employeeCode}{p.employee?.designation ? ` · ${p.employee.designation}` : ''}</Text>
                  </View>
                  <Pill label={p.status} tone={STATUS_TONE[p.status] || 'neutral'} />
                </View>
                <View style={styles.amounts}>
                  <View><Text style={font.small}>Gross</Text><Text style={styles.amt}>{rupees(p.grossSalary)}</Text></View>
                  <View><Text style={font.small}>Deductions</Text><Text style={[styles.amt, { color: colors.danger }]}>{rupees(p.totalDeductions)}</Text></View>
                  <View><Text style={font.small}>Net</Text><Text style={[styles.amt, { color: colors.success }]}>{rupees(p.netPay)}</Text></View>
                </View>
                <View style={styles.actions}>
                  <TouchableOpacity style={[styles.actBtn, styles.ghost]} disabled={busyId === p._id} onPress={() => downloadPdf(p)}>
                    <Ionicons name="download" size={16} color={colors.primary} />
                    <Text style={[styles.actText, { color: colors.primary }]}>PDF</Text>
                  </TouchableOpacity>
                  {writable && ['Approved', 'Paid'].includes(p.status) && p.employee?.user?.email && (
                    <TouchableOpacity style={[styles.actBtn, styles.ghost]} disabled={busyId === p._id} onPress={() => emailPayslip(p)}>
                      <Ionicons name="mail-outline" size={16} color={colors.primary} />
                      <Text style={[styles.actText, { color: colors.primary }]}>{p.emailedAt ? 'Resend' : 'Email'}</Text>
                    </TouchableOpacity>
                  )}
                  {writable && (p.status === 'Draft' || p.status === 'OnHold') && (
                    <TouchableOpacity style={[styles.actBtn, styles.approve]} disabled={busyId === p._id} onPress={() => act(p, 'approve')}>
                      <Ionicons name="checkmark" size={16} color="#fff" />
                      <Text style={[styles.actText, { color: '#fff' }]}>Approve</Text>
                    </TouchableOpacity>
                  )}
                  {writable && p.status === 'Approved' && (
                    <TouchableOpacity style={[styles.actBtn, styles.pay]} disabled={busyId === p._id} onPress={() => confirmPay(p)}>
                      <Ionicons name="cash" size={16} color="#fff" />
                      <Text style={[styles.actText, { color: '#fff' }]}>Mark paid</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </Card>
            ))
          )}
        </ScrollView>
      )}

      <MailComposeSheet visible={!!mailSheet} onClose={() => setMailSheet(null)} mail={mailSheet} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  monthBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing(5), paddingVertical: spacing(3) },
  nav: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  monthTitle: { fontSize: 18, fontWeight: '800', color: colors.text },
  filters: { maxHeight: 50, marginBottom: spacing(1) },
  chip: { paddingHorizontal: 14, height: 36, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontWeight: '700', fontSize: 13, color: colors.textMuted },
  amounts: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing(3), paddingTop: spacing(3), borderTopWidth: 1, borderTopColor: colors.border },
  amt: { fontSize: 15, fontWeight: '800', color: colors.text, marginTop: 2 },
  actions: { flexDirection: 'row', gap: 8, marginTop: spacing(3) },
  actBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 42, borderRadius: radius.md },
  ghost: { backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  approve: { backgroundColor: colors.info },
  pay: { backgroundColor: colors.success },
  actText: { fontWeight: '700', fontSize: 13, marginLeft: 5 },
});
