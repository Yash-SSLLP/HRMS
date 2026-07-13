import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { mediaUrl } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Avatar, Ionicons } from './ui';

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const AMBER = '#f59e0b';

// Build the (auth-protected) avatar URI for a winner, or null → Avatar shows initials.
const winnerUri = (w) =>
  w.photo ? `${mediaUrl(`/auth/users/${w.user}/avatar`)}?p=${encodeURIComponent(w.photo)}` : null;

// Celebratory dashboard banner for the month's Rewards & Recognition winners.
// Shows for 2 working days after HR announces (server-enforced) and is closeable
// per-user. Renders nothing when there's no live award for this viewer.
export default function RnrBanner() {
  const [award, setAward] = useState(null);
  const [closed, setClosed] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      api.get('/rnr/current')
        .then(({ data }) => { if (active) setAward(data.award || null); })
        .catch(() => {});
      return () => { active = false; };
    }, [])
  );

  const dismiss = () => {
    if (!award) return;
    setClosed(true);
    api.post(`/rnr/${award._id}/dismiss`).catch(() => {});
  };

  if (!award || closed) return null;

  const eom = award.winners.find((w) => w.category === 'EmployeeOfMonth');
  const keyAchievers = award.winners.filter((w) => w.category === 'KeyAchiever');

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Ionicons name="trophy" size={18} color={AMBER} />
        <Text style={styles.title}>Rewards & Recognition</Text>
        <View style={styles.periodPill}>
          <Text style={styles.periodText}>{MONTHS[award.month]} {award.year}</Text>
        </View>
        <TouchableOpacity onPress={dismiss} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="close" size={20} color={colors.textMuted} />
        </TouchableOpacity>
      </View>

      {eom && (
        <View style={styles.eomRow}>
          <Avatar name={eom.name} uri={winnerUri(eom)} size={56} color={AMBER} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={styles.eomKicker}>★ EMPLOYEE OF THE MONTH</Text>
            <Text style={styles.eomName}>{eom.name}</Text>
            <Text style={font.small}>
              {eom.designation || '-'}{eom.department ? ` · ${eom.department}` : ''}
            </Text>
            {eom.citation ? <Text style={[font.small, { marginTop: 2 }]} numberOfLines={2}>{eom.citation}</Text> : null}
          </View>
        </View>
      )}

      {keyAchievers.length > 0 && (
        <View style={styles.kaWrap}>
          <Text style={styles.kaLabel}>KEY ACHIEVERS</Text>
          {keyAchievers.map((w) => (
            <View key={String(w.user)} style={styles.kaRow}>
              <Avatar name={w.name} uri={winnerUri(w)} size={40} color={AMBER} />
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={font.body}>{w.name}</Text>
                <Text style={font.small}>
                  {w.department || '-'}{w.designation ? ` · ${w.designation}` : ''}
                </Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderLeftWidth: 4,
    borderLeftColor: AMBER,
    borderWidth: 1,
    borderColor: AMBER + '33',
    padding: spacing(4),
    marginBottom: spacing(4),
  },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(3) },
  title: { ...font.h3, marginLeft: 6, flexShrink: 1 },
  periodPill: { marginLeft: 8, marginRight: 'auto', backgroundColor: AMBER + '1a', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  periodText: { fontSize: 11, fontWeight: '700', color: '#b45309' },
  eomRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: AMBER + '12', borderRadius: radius.md, padding: spacing(3) },
  eomKicker: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5, color: '#b45309' },
  eomName: { fontSize: 16, fontWeight: '800', color: colors.text, marginTop: 1 },
  kaWrap: { marginTop: spacing(3) },
  kaLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5, color: colors.textFaint, marginBottom: spacing(2) },
  kaRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing(1.5) },
});
