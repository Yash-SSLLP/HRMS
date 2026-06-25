import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, Pill, Loader, EmptyState, refresher, Ionicons } from '../components/ui';
import { fmtDate } from '../utils/format';

const ICON = { Laptop: 'laptop', Desktop: 'desktop', Phone: 'phone-portrait', Monitor: 'tv', Accessory: 'headset', Furniture: 'bed', Vehicle: 'car', Other: 'cube' };

export default function AssetsScreen() {
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get('/assets/me').catch(() => ({ data: {} }));
    setAssets(data.assets || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  if (loading) return <Screen><Loader text="Loading assets" /></Screen>;

  return (
    <Screen edges={[]}>
      <FlatList
        data={assets}
        keyExtractor={(a) => a._id}
        contentContainerStyle={assets.length ? { padding: spacing(4) } : { flex: 1 }}
        refreshControl={refresher(refreshing, onRefresh)}
        renderItem={({ item }) => (
          <Card style={styles.row}>
            <View style={styles.icon}>
              <Ionicons name={ICON[item.category] || 'cube'} size={22} color={colors.primary} />
            </View>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={font.h3}>{item.name}</Text>
              <Text style={font.label}>{item.category}{item.serialNumber ? ` · SN ${item.serialNumber}` : ''}</Text>
              {item.assignedAt ? <Text style={font.small}>Assigned {fmtDate(item.assignedAt)}</Text> : null}
            </View>
            <Pill label={item.status} tone={item.status === 'Assigned' ? 'success' : 'neutral'} />
          </Card>
        )}
        ListEmptyComponent={<EmptyState icon="cube-outline" title="No assets assigned" subtitle="Company assets issued to you will appear here." />}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(2.5) },
  icon: { width: 44, height: 44, borderRadius: 12, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
});
