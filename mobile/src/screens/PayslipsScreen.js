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

  return (
    <Screen edges={[]}>
      <ScrollView
        contentContainerStyle={payslips.length ? { padding: spacing(4), paddingBottom: 32 } : { flexGrow: 1 }}
        refreshControl={refresher(refreshing, onRefresh)}
      >
        {payslips.length === 0 ? (
          <EmptyState icon="cash-outline" title="No payslips yet" subtitle="Approved payslips will appear here each month." />
        ) : (
          payslips.map((p) => {
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
                    <Row label="Gross salary" value={rupees(p.grossSalary)} />
                    <Row label="Total deductions" value={`- ${rupees(p.totalDeductions)}`} tint={colors.danger} />
                    <View style={styles.sep} />
                    <Row label="Net pay" value={rupees(p.netPay)} bold />
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
          })
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

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center' },
  calIcon: { width: 52, height: 52, borderRadius: 14, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  calMonth: { fontWeight: '800', color: colors.primary, fontSize: 14 },
  calYear: { fontSize: 11, color: colors.primary },
  net: { fontSize: 22, fontWeight: '800', color: colors.text },
  breakdown: { marginTop: spacing(3), borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing(3) },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  sep: { height: 1, backgroundColor: colors.border, marginVertical: 4 },
});
