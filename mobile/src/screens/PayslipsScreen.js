/**
 * PayslipsScreen — the employee's monthly payslips with an expandable
 * gross/deductions/net breakdown and a PDF download/share action. Home stack
 * route "Payslips" (Menu > Money). Any employee role.
 * Backend: GET /payroll/me (list), GET /payroll/me/:id/pdf (payslip PDF download).
 *
 * The latest net pay summary sits at the top of this screen (and nowhere else in
 * the app) — it used to be a home-screen card, which risked exposing pay to
 * anyone glancing at the phone.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import api, { API_BASE } from '../api/client';
import { useAuth } from '../store/auth';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, AppButton, Pill, Loader, refresher, EmptyState, Ionicons, SkeletonScreen } from '../components/ui';
import { rupees } from '../utils/format';

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function PayslipsScreen() {
  const token = useAuth((s) => s.token);
  const [payslips, setPayslips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [downloading, setDownloading] = useState(null);

  // Download the payslip PDF (auth header carried by FileSystem) then hand it to
  // the OS share sheet so the user can save/print/email it.
  const downloadPdf = async (p) => {
    setDownloading(p._id);
    try {
      const fileUri = `${FileSystem.cacheDirectory}payslip-${p.payPeriodYear}-${String(p.payPeriodMonth).padStart(2, '0')}.pdf`;
      const res = await FileSystem.downloadAsync(`${API_BASE}/payroll/me/${p._id}/pdf`, fileUri, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status !== 200) throw new Error('Payslip not available');
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(res.uri, { mimeType: 'application/pdf', dialogTitle: 'Payslip', UTI: 'com.adobe.pdf' });
      } else {
        Alert.alert('Downloaded', 'Payslip saved to the app cache.');
      }
    } catch (err) {
      Alert.alert('Download failed', err.message || 'Could not download the payslip.');
    } finally {
      setDownloading(null);
    }
  };

  const load = useCallback(async () => {
    const { data } = await api.get('/payroll/me').catch(() => ({ data: {} }));
    setPayslips(data.payslips || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  // API returns newest first, but pick the max period explicitly so the summary
  // can't be thrown off by ordering changes.
  const latest = payslips.reduce((best, p) => {
    if (!best) return p;
    const key = (s) => s.payPeriodYear * 12 + s.payPeriodMonth;
    return key(p) > key(best) ? p : best;
  }, null);

  return (
    <Screen edges={[]}>
      <ScrollView
        contentContainerStyle={payslips.length ? { padding: spacing(4), paddingBottom: 32 } : { flexGrow: 1 }}
        refreshControl={refresher(refreshing, onRefresh)}
      >
        {payslips.length === 0 ? (
          <EmptyState icon="cash-outline" title="No payslips yet" subtitle="Approved payslips will appear here each month." />
        ) : (
          <>
          {/* Latest net pay — moved here from the home screen. */}
          {latest && (
            <Card style={[styles.summary, { marginBottom: spacing(3) }]}>
              <View style={styles.summaryIcon}>
                <Ionicons name="wallet" size={22} color={colors.primary} />
              </View>
              <View style={{ flex: 1, marginLeft: 14 }}>
                <Text style={styles.summaryValue}>{rupees(latest.netPay)}</Text>
                <Text style={font.label}>
                  Latest net pay · {MONTHS[latest.payPeriodMonth] || ''} {latest.payPeriodYear}
                </Text>
              </View>
            </Card>
          )}
          {payslips.map((p) => {
            const open = expanded === p._id;
            return (
              <Card key={p._id} style={{ marginBottom: spacing(3) }} onPress={() => setExpanded(open ? null : p._id)}>
                <View style={styles.head}>
                  <View style={styles.calIcon}>
                    <Text style={styles.calMonth}>{MONTHS[p.payPeriodMonth] || ''}</Text>
                    <Text style={styles.calYear}>{p.payPeriodYear}</Text>
                  </View>
                  <View style={{ flex: 1, marginLeft: 14 }}>
                    <Text style={font.label}>Net pay</Text>
                    <Text style={styles.net}>{rupees(p.netPay)}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Pill label={p.status} tone={p.status === 'Paid' ? 'success' : 'info'} />
                    <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textFaint} style={{ marginTop: 8 }} />
                  </View>
                </View>

                {open && (
                  <View style={styles.breakdown}>
                    <Details slip={p} />
                    <Section title="Earnings" lines={p.lines?.earnings} ytdLabel={p.ytd?.label} />
                    <Section title="Deductions" lines={p.lines?.deductions} tint={colors.danger} ytdLabel={p.ytd?.label} />
                    <Row label="Gross salary" value={rupees(p.grossSalary)} />
                    <Row label="Total deductions" value={`- ${rupees(p.totalDeductions)}`} tint={colors.danger} />
                    <View style={styles.sep} />
                    <Row label="Net pay" value={rupees(p.netPay)} bold />
                    {p.ytd && (
                      <Text style={styles.ytdSummary}>
                        {`${p.ytd.label} to date: ${rupees(p.ytd.netPay)} net over ${p.ytd.months} month${p.ytd.months === 1 ? '' : 's'}`}
                      </Text>
                    )}
                    <Employer slip={p} />
                    <AppButton
                      title="Download / Share PDF"
                      icon="download"
                      variant="outline"
                      style={{ marginTop: spacing(3), height: 44 }}
                      loading={downloading === p._id}
                      onPress={() => downloadPdf(p)}
                    />
                  </View>
                )}
              </Card>
            );
          })}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function Row({ label, value, tint, bold }) {
  return (
    <View style={styles.row}>
      <Text style={[font.body, bold && { fontWeight: '800' }]}>{label}</Text>
      <Text style={[font.body, { color: tint || colors.text }, bold && { fontWeight: '800' }]}>{value}</Text>
    </View>
  );
}

// One side of the component breakdown, from the `lines` the server builds for
// the PDF (backend/services/payslipLines.js). Renders nothing when the response
// predates that field, leaving the gross/deductions/net totals below it.
//
// Year-to-date sits under each figure rather than in a second column — two
// money columns do not fit a phone width without truncating the labels.
function Section({ title, lines, tint, ytdLabel }) {
  const shown = (lines || []).filter((l) => l.amount > 0 || l.ytd > 0);
  if (!shown.length) return null;
  return (
    <View style={{ marginBottom: spacing(3) }}>
      <Text style={styles.sectionTitle}>{title.toUpperCase()}</Text>
      {shown.map((l) => (
        <View key={l.key} style={styles.row}>
          <Text style={[font.body, { flex: 1, paddingRight: 12 }]} numberOfLines={1}>
            {l.label}
            {l.hint ? <Text style={styles.hint}>{`  ${l.hint}`}</Text> : null}
          </Text>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={[font.body, { color: tint || colors.text }]}>{rupees(l.amount)}</Text>
            {l.ytd != null && (
              <Text style={styles.ytd}>{`${ytdLabel || 'YTD'} ${rupees(l.ytd)}`}</Text>
            )}
          </View>
        </View>
      ))}
    </View>
  );
}

// The identity, statutory, bank and day-count rows, exactly as the PDF prints
// them. The server builds the list (services/payslipFields.js), so this screen
// cannot drift from the document. Each PDF row holds two label/value pairs;
// on a phone they stack into single rows.
function Details({ slip }) {
  const d = slip.details;
  if (!d) return null;
  const pairs = [...d.identity, ...d.dayCounts]
    .flatMap((r) => [[r[0], r[1]], [r[2], r[3]]])
    .filter(([label]) => label);
  return (
    <View style={{ marginBottom: spacing(3) }}>
      {pairs.map(([label, value]) => (
        <View key={label} style={styles.detailRow}>
          <Text style={[font.body, { color: colors.textFaint, flex: 1, paddingRight: 12 }]} numberOfLines={1}>{label}</Text>
          <Text style={[font.body, { flex: 1, textAlign: 'right' }]} numberOfLines={1}>{value}</Text>
        </View>
      ))}
    </View>
  );
}

// Separated from the deductions above on purpose: none of this is taken from the
// employee, and listing it alongside their deductions would read as if it were.
function Employer({ slip }) {
  const lines = (slip.lines?.employer || []).filter((l) => l.amount > 0 || l.ytd > 0);
  if (!lines.length) return null;
  const total = lines.reduce((a, l) => a + l.amount, 0);
  return (
    <View style={styles.employer}>
      <Text style={styles.employerTitle}>PAID BY THE COMPANY — NOT DEDUCTED FROM YOU</Text>
      {lines.map((l) => (
        <View key={l.key} style={styles.row}>
          <Text style={[font.body, { flex: 1, paddingRight: 12 }]} numberOfLines={1}>{l.label}</Text>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={font.body}>{rupees(l.amount)}</Text>
            {l.ytd != null && (
              <Text style={styles.ytd}>{`${slip.ytd?.label || 'YTD'} ${rupees(l.ytd)}`}</Text>
            )}
          </View>
        </View>
      ))}
      <Row label="Total" value={rupees(total)} bold />
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center' },
  summary: { flexDirection: 'row', alignItems: 'center' },
  summaryIcon: { width: 52, height: 52, borderRadius: 14, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  summaryValue: { fontSize: 26, fontWeight: '800', color: colors.text },
  calIcon: { width: 52, height: 52, borderRadius: 14, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  calMonth: { fontWeight: '800', color: colors.primary, fontSize: 14 },
  calYear: { fontSize: 11, color: colors.primary },
  net: { fontSize: 22, fontWeight: '800', color: colors.text },
  breakdown: { marginTop: spacing(3), borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing(3) },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  sep: { height: 1, backgroundColor: colors.border, marginVertical: 4 },
  sectionTitle: { fontSize: 11, fontWeight: '800', letterSpacing: 1.1, color: colors.textFaint, marginBottom: 8 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4,
    borderBottomWidth: 1, borderBottomColor: colors.border },
  hint: { color: colors.textFaint, fontSize: 12 },
  ytd: { color: colors.textFaint, fontSize: 11, marginTop: 1 },
  ytdSummary: { color: colors.textFaint, fontSize: 12, marginTop: 6 },
  employer: { marginTop: spacing(3), paddingTop: spacing(3), borderTopWidth: 1, borderTopColor: colors.border },
  employerTitle: { fontSize: 10, fontWeight: '800', letterSpacing: 0.8, color: colors.primary, marginBottom: 10 },
});
