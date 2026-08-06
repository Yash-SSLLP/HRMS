/**
 * OrgChartScreen — the reporting hierarchy, read-only. The web draws this as a
 * wide horizontal tree; on a phone that is unreadable, so the same forest is
 * rendered as an indented, collapsible list — tap a person to fold their reports
 * away, or search to jump straight to someone.
 *
 * Route: "OrgChart" (Menu > My work). Any role — the endpoint is protect-only and
 * already hides whoever the viewer isn't allowed to see.
 * Backend: GET /org/chart → { roots: [{ id, name, designation, department, role,
 * hasPhoto, reports[] }] }.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { mediaUrl } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Avatar, Input, EmptyState, refresher, Ionicons, SkeletonScreen } from '../components/ui';

// How far each level is pushed in. Kept small — a deep chain still has to fit a
// 360dp screen, so the connector line does most of the work of showing depth.
const INDENT = 16;
const MAX_INDENT_LEVEL = 6;

/** Flatten the forest to a searchable list of {node, path} for the search mode. */
function flatten(nodes, trail = [], out = []) {
  for (const n of nodes || []) {
    out.push({ node: n, path: trail.join(' › ') });
    flatten(n.reports, [...trail, n.name], out);
  }
  return out;
}

/** Every id in the forest — used to expand/collapse everything at once. */
function allIds(nodes, out = []) {
  for (const n of nodes || []) {
    out.push(n.id);
    allIds(n.reports, out);
  }
  return out;
}

function Person({ node, size = 40 }) {
  return (
    <>
      <Avatar
        name={node.name}
        uri={node.hasPhoto ? mediaUrl(`/auth/users/${node.id}/avatar`) : null}
        size={size}
      />
      <View style={{ flex: 1, marginLeft: 10 }}>
        <Text style={font.body} numberOfLines={1}>{node.name}</Text>
        <Text style={font.small} numberOfLines={1}>
          {node.designation || node.role}
          {node.department ? ` · ${node.department}` : ''}
        </Text>
      </View>
    </>
  );
}

export default function OrgChartScreen() {
  const [roots, setRoots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    const { data } = await api.get('/org/chart').catch(() => ({ data: {} }));
    setRoots(data.roots || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const toggle = (id) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const flat = useMemo(() => flatten(roots), [roots]);
  const term = q.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!term) return [];
    return flat.filter(({ node }) =>
      `${node.name} ${node.designation} ${node.department}`.toLowerCase().includes(term));
  }, [flat, term]);

  const total = flat.length;
  const allCollapsed = collapsed.size > 0;

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  /** One person plus their reports, recursively. */
  const renderNode = (node, level) => {
    const kids = node.reports || [];
    const isCollapsed = collapsed.has(node.id);
    const pad = Math.min(level, MAX_INDENT_LEVEL) * INDENT;
    return (
      <View key={node.id}>
        <TouchableOpacity
          style={[styles.row, { marginLeft: pad }]}
          activeOpacity={kids.length ? 0.6 : 1}
          onPress={kids.length ? () => toggle(node.id) : undefined}
        >
          {level > 0 ? <View style={styles.connector} /> : null}
          <Person node={node} />
          {kids.length ? (
            <View style={styles.countChip}>
              <Text style={styles.countText}>{kids.length}</Text>
              <Ionicons name={isCollapsed ? 'chevron-down' : 'chevron-up'} size={14} color={colors.textMuted} />
            </View>
          ) : null}
        </TouchableOpacity>
        {!isCollapsed && kids.map((c) => renderNode(c, level + 1))}
      </View>
    );
  };

  return (
    <Screen edges={[]}>
      <ScrollView
        contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }}
        refreshControl={refresher(refreshing, onRefresh)}
        keyboardShouldPersistTaps="handled"
      >
        <Input value={q} onChangeText={setQ} placeholder="Search name, role or department" />

        {term ? (
          // Search mode: a flat result list, each with the chain above them, so a
          // match is useful without hunting for it in the tree.
          matches.length === 0 ? (
            <EmptyState icon="search-outline" title="No match" subtitle={`Nobody matches “${q.trim()}”.`} />
          ) : (
            <View style={{ marginTop: spacing(3) }}>
              <Text style={[font.small, { marginBottom: spacing(2) }]}>
                {matches.length} of {total} {total === 1 ? 'person' : 'people'}
              </Text>
              {matches.map(({ node, path }) => (
                <View key={node.id} style={styles.row}>
                  <Person node={node} />
                  {path ? <Text style={styles.path} numberOfLines={1}>{path}</Text> : null}
                </View>
              ))}
            </View>
          )
        ) : roots.length === 0 ? (
          <EmptyState icon="git-branch-outline" title="No hierarchy yet" subtitle="Once reporting managers are set, the org chart appears here." />
        ) : (
          <>
            <View style={styles.toolbar}>
              <Text style={font.small}>{total} {total === 1 ? 'person' : 'people'}</Text>
              <TouchableOpacity
                onPress={() => setCollapsed(allCollapsed ? new Set() : new Set(allIds(roots)))}
                hitSlop={8}
              >
                <Text style={styles.toolLink}>{allCollapsed ? 'Expand all' : 'Collapse all'}</Text>
              </TouchableOpacity>
            </View>
            {roots.map((r) => renderNode(r, 0))}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: spacing(3), marginBottom: spacing(2),
  },
  toolLink: { color: colors.primaryDark, fontWeight: '700', fontSize: 12.5 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing(2.5), marginBottom: spacing(2),
  },
  // Short stub on the left of a nested row, standing in for the web chart's
  // connector line between a manager and a report.
  connector: {
    position: 'absolute', left: -10, top: '50%',
    width: 10, height: 1, backgroundColor: colors.borderStrong,
  },
  countChip: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    paddingHorizontal: 8, height: 26, borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
  },
  countText: { fontSize: 12, fontWeight: '800', color: colors.textMuted },
  path: { ...font.small, maxWidth: '40%', textAlign: 'right' },
});
