import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity, Modal, ScrollView } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, Pill, Loader, EmptyState, refresher, Ionicons, SkeletonScreen } from '../components/ui';
import { fmtDate } from '../utils/format';

export default function KnowledgeBaseScreen() {
  const [articles, setArticles] = useState([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [active, setActive] = useState(null);

  const load = useCallback(async () => {
    const { data } = await api.get('/kb').catch(() => ({ data: {} }));
    setArticles(data.articles || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const filtered = articles.filter((a) => {
    const q = query.toLowerCase();
    return !q || a.title?.toLowerCase().includes(q) || a.body?.toLowerCase().includes(q) || (a.tags || []).some((t) => t.toLowerCase().includes(q));
  });

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  return (
    <Screen edges={[]}>
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={18} color={colors.textFaint} />
        <TextInput style={styles.search} placeholder="Search articles" placeholderTextColor={colors.textFaint} value={query} onChangeText={setQuery} />
      </View>
      <FlatList
        data={filtered}
        keyExtractor={(a) => a._id}
        contentContainerStyle={filtered.length ? { padding: spacing(4) } : { flex: 1 }}
        refreshControl={refresher(refreshing, onRefresh)}
        renderItem={({ item }) => (
          <Card style={{ marginBottom: spacing(3) }} onPress={() => setActive(item)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={[font.h3, { flex: 1, marginRight: 8 }]}>{item.title}</Text>
              <Pill label={item.category} tone="primary" />
            </View>
            <Text style={[font.label, { marginTop: 6 }]} numberOfLines={2}>{item.body}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
              <Text style={font.small}>Updated {fmtDate(item.updatedAt)}</Text>
              <Text style={[font.small, { color: colors.primary, fontWeight: '700' }]}>Read →</Text>
            </View>
          </Card>
        )}
        ListEmptyComponent={<EmptyState icon="book-outline" title="No articles" subtitle="Company policies and how-tos will appear here." />}
      />

      <Modal visible={!!active} animationType="slide" onRequestClose={() => setActive(null)}>
        <Screen>
          <View style={styles.modalHead}>
            <Pill label={active?.category || 'Article'} tone="primary" />
            <TouchableOpacity onPress={() => setActive(null)}><Ionicons name="close" size={26} color={colors.text} /></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: spacing(4), paddingTop: 0 }}>
            <Text style={[font.h1, { marginBottom: 8 }]}>{active?.title}</Text>
            <Text style={font.small}>Updated {active ? fmtDate(active.updatedAt) : ''}</Text>
            <Text style={[font.body, { marginTop: 16, lineHeight: 24, color: colors.textMuted }]}>{active?.body}</Text>
            {active?.tags?.length ? (
              <View style={styles.tags}>
                {active.tags.map((t) => <View key={t} style={styles.tag}><Text style={styles.tagText}>#{t}</Text></View>)}
              </View>
            ) : null}
          </ScrollView>
        </Screen>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  searchWrap: { flexDirection: 'row', alignItems: 'center', margin: spacing(4), marginBottom: 0, backgroundColor: colors.surface, borderRadius: radius.md, paddingHorizontal: 14, height: 46, borderWidth: 1, borderColor: colors.border },
  search: { flex: 1, marginLeft: 8, fontSize: 15, color: colors.text },
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing(4) },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 20 },
  tag: { backgroundColor: colors.surfaceAlt, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill },
  tagText: { color: colors.textMuted, fontWeight: '600', fontSize: 12 },
});
