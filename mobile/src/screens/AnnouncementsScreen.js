import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, Pill, Loader, EmptyState, refresher, Ionicons } from '../components/ui';
import { timeAgo } from '../utils/format';

const CAT_TONE = { General: 'neutral', Policy: 'info', Event: 'primary', Holiday: 'warning', Benefits: 'success', Urgent: 'danger' };

export default function AnnouncementsScreen() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get('/announcements').catch(() => ({ data: {} }));
    setItems(data.announcements || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  if (loading) return <Screen><Loader text="Loading announcements" /></Screen>;

  return (
    <Screen edges={[]}>
      <FlatList
        data={items}
        keyExtractor={(a) => a._id}
        contentContainerStyle={items.length ? { padding: spacing(4) } : { flex: 1 }}
        refreshControl={refresher(refreshing, onRefresh)}
        renderItem={({ item }) => (
          <Card style={{ marginBottom: spacing(3) }}>
            <View style={styles.head}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                {item.pinned ? <Ionicons name="pin" size={15} color={colors.danger} style={{ marginRight: 6 }} /> : null}
                <Text style={[font.h3, { flex: 1 }]}>{item.title}</Text>
              </View>
              <Pill label={item.category} tone={CAT_TONE[item.category] || 'neutral'} />
            </View>
            <Text style={[font.body, { marginTop: 8, color: colors.textMuted, lineHeight: 21 }]}>{item.body}</Text>
            <Text style={[font.small, { marginTop: 10 }]}>
              {item.createdBy ? `${item.createdBy.firstName} ${item.createdBy.lastName} · ` : ''}{timeAgo(item.createdAt)}
            </Text>
          </Card>
        )}
        ListEmptyComponent={<EmptyState icon="megaphone-outline" title="No announcements" subtitle="Company announcements will appear here." />}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
});
