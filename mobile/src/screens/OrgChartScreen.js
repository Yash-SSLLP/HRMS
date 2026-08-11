/**
 * OrgChartScreen — the reporting hierarchy, read-only. The web draws this as a
 * wide horizontal tree; a phone cannot show that, so the same forest is drawn as
 * a VERTICAL tree: each report hangs off its manager on a drawn rail, with an
 * elbow into the card and the rail continuing past it only while more siblings
 * follow (the ├ / └ of a file browser). Depth is therefore readable from the
 * connectors themselves rather than from indentation alone. Tap a person to fold
 * their reports away, or search to jump straight to someone.
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

// Width of one rail column — this is also the per-level indent, since every
// level adds exactly one column. Kept narrow because a deep chain still has to
// leave the card readable on a 360dp screen.
const RAIL = 20;

// Rails stop accumulating past this depth. Beyond it every level reuses the same
// gutter width, so a pathologically deep chain squeezes the card but never
// pushes it off-screen. The elbow still comes from the immediate parent, so the
// row directly above a node is always the correct one.
const MAX_RAILS = 6;

// Vertical centre of a card, where the elbow meets it. The card is a fixed
// height (a 40px avatar plus 10px padding top and bottom plus 1px borders), and
// both text lines are clamped to one line, so this stays constant and every
// elbow across the tree lines up.
const CARD_MID = 31;

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

/**
 * The connector gutter to the left of a nested card.
 *
 * `ancestors` carries one flag per level above this node: true where that
 * ancestor still has siblings below it, so its rail must run past this row to
 * reach them. False leaves the column blank, which is what makes a finished
 * branch visibly close instead of trailing a line down the whole screen.
 *
 * The last column is this node's own elbow: rail down to the card's centre,
 * a tick across into it, and the rail continued below only when another sibling
 * follows (└ when last, ├ otherwise).
 */
function Rails({ ancestors, isLast }) {
  return (
    <View style={styles.gutter}>
      {ancestors.map((continues, i) => (
        <View key={i} style={styles.railCol}>
          {continues ? <View style={styles.railFull} /> : null}
        </View>
      ))}
      <View style={styles.railCol}>
        <View style={styles.railTop} />
        {!isLast ? <View style={styles.railBottom} /> : null}
        <View style={styles.elbow} />
      </View>
    </View>
  );
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

  /**
   * One person plus their reports, recursively.
   *
   * `ancestors` is the rail-continuation flag per level above this node (see
   * Rails); `isLast` says whether this node closes its sibling group.
   */
  const renderNode = (node, ancestors, isLast, isRoot = false) => {
    const kids = node.reports || [];
    const isCollapsed = collapsed.has(node.id);
    const hasKids = kids.length > 0;
    // Children inherit our ancestors plus one flag for THIS node's level: its
    // rail must run past them only while we still have a sibling to reach. A
    // root contributes no rail of its own — its children start the tree.
    const childAncestors = isRoot ? [] : [...ancestors, !isLast].slice(-MAX_RAILS);
    return (
      <View key={node.id}>
        <View style={styles.branch}>
          {/* Root rows have no parent to hang from, so they carry no gutter. */}
          {isRoot ? null : <Rails ancestors={ancestors} isLast={isLast} />}
          <TouchableOpacity
            style={styles.card}
            activeOpacity={hasKids ? 0.6 : 1}
            onPress={hasKids ? () => toggle(node.id) : undefined}
          >
            <Person node={node} />
            {hasKids ? (
              <View style={styles.countChip}>
                <Text style={styles.countText}>{kids.length}</Text>
                <Ionicons name={isCollapsed ? 'chevron-down' : 'chevron-up'} size={14} color={colors.textMuted} />
              </View>
            ) : null}
          </TouchableOpacity>
        </View>
        {!isCollapsed && kids.map((c, i) => renderNode(c, childAncestors, i === kids.length - 1))}
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
            {roots.map((r, i) => renderNode(r, [], i === roots.length - 1, true))}
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
  // Gutter + card. `alignItems: 'stretch'` is what lets the rail columns take
  // the full height of the row INCLUDING the card's bottom margin — without it
  // the rails stop at the card's edge and the tree reads as dashes rather than
  // continuous lines.
  branch: { flexDirection: 'row', alignItems: 'stretch' },
  gutter: { flexDirection: 'row' },
  railCol: { width: RAIL },
  // A rail passing straight through this row to a lower sibling of an ancestor.
  railFull: {
    position: 'absolute', left: RAIL / 2, top: 0, bottom: 0,
    width: 1, backgroundColor: colors.borderStrong,
  },
  // This node's own connector: down from the parent to the card's centre...
  railTop: {
    position: 'absolute', left: RAIL / 2, top: 0, height: CARD_MID,
    width: 1, backgroundColor: colors.borderStrong,
  },
  // ...continuing below only when another sibling follows (├ rather than └)...
  railBottom: {
    position: 'absolute', left: RAIL / 2, top: CARD_MID, bottom: 0,
    width: 1, backgroundColor: colors.borderStrong,
  },
  // ...and the tick across into the card.
  elbow: {
    position: 'absolute', left: RAIL / 2, top: CARD_MID,
    width: RAIL / 2, height: 1, backgroundColor: colors.borderStrong,
  },
  card: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing(2.5), marginBottom: spacing(2),
  },
  // Search results are a flat list with no hierarchy to draw, so they keep the
  // plain card shape.
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing(2.5), marginBottom: spacing(2),
  },
  countChip: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    paddingHorizontal: 8, height: 26, borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
  },
  countText: { fontSize: 12, fontWeight: '800', color: colors.textMuted },
  path: { ...font.small, maxWidth: '40%', textAlign: 'right' },
});
