import React, { useMemo } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { colors, spacing, radius } from '../theme';

// Minimal, dependency-free Markdown renderer for the in-app guides. Handles the
// subset the guides use: #/##/###/#### headings, **bold**, *italic*, `code`,
// "- " bullets, "1." numbered lists, "---" rules, 💡/⚠️ callouts, and plain
// paragraphs. Theme-aware, so it reads correctly in light and dark mode.
//
// `onHeadingY(id, y)` (optional) reports each ## section's vertical offset (within
// this component) so a parent can implement "jump to section" scrolling. The id
// matches slug(text), the same scheme the web guide uses for anchors.

export const slug = (s) => s.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '') || 'section';

const MONO = Platform.OS === 'ios' ? 'Courier' : 'monospace';

function inlineSpans(text) {
  const out = [];
  let rest = text;
  let k = 0;
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/;
  while (rest) {
    const m = rest.match(re);
    if (!m) { out.push(<Text key={k++}>{rest}</Text>); break; }
    if (m.index > 0) out.push(<Text key={k++}>{rest.slice(0, m.index)}</Text>);
    if (m[2] != null) out.push(<Text key={k++} style={styles.bold}>{m[2]}</Text>);
    else if (m[3] != null) out.push(<Text key={k++} style={styles.italic}>{m[3]}</Text>);
    else out.push(<Text key={k++} style={styles.code}> {m[4]} </Text>);
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

// 💡 tip / ⚠️ warning paragraphs render as tinted callout cards.
function calloutOf(line) {
  if (/^💡/.test(line)) return { icon: '💡', bg: colors.infoSoft, bar: colors.info, body: line.replace(/^💡\s*/, '') };
  if (/^⚠️?/.test(line)) return { icon: '⚠️', bg: colors.warningSoft, bar: colors.warning, body: line.replace(/^⚠️?\s*/, '') };
  return null;
}

export default function MarkdownText({ md, onHeadingY }) {
  const blocks = useMemo(() => {
    const lines = (md || '').split('\n');
    const out = [];
    let k = 0;
    lines.forEach((raw) => {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) return; // spacing handled by block margins

      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        const lvl = h[1].length;
        const heading = (
          <Text key={k++} style={[styles.para, styles[`h${lvl}`]]}>{inlineSpans(h[2])}</Text>
        );
        if (lvl === 2) {
          const id = slug(h[2]);
          out.push(
            <View key={k++} onLayout={(e) => onHeadingY && onHeadingY(id, e.nativeEvent.layout.y)}>
              {heading}
              <View style={styles.hr} />
            </View>
          );
        } else {
          out.push(heading);
        }
        return;
      }

      if (/^(-{3,}|\*{3,})$/.test(line.trim())) { out.push(<View key={k++} style={styles.hr} />); return; }

      const callout = calloutOf(line.trim());
      if (callout) {
        out.push(
          <View key={k++} style={[styles.callout, { backgroundColor: callout.bg, borderLeftColor: callout.bar }]}>
            <Text style={styles.calloutIcon}>{callout.icon}</Text>
            <Text style={[styles.para, styles.calloutText]}>{inlineSpans(callout.body)}</Text>
          </View>
        );
        return;
      }

      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        out.push(
          <View key={k++} style={styles.liRow}>
            <Text style={styles.bulletDot}>•</Text>
            <Text style={[styles.para, styles.li]}>{inlineSpans(bullet[1])}</Text>
          </View>
        );
        return;
      }
      const num = line.match(/^\s*(\d+)\.\s+(.*)$/);
      if (num) {
        out.push(
          <View key={k++} style={styles.liRow}>
            <Text style={styles.numMark}>{num[1]}.</Text>
            <Text style={[styles.para, styles.li]}>{inlineSpans(num[2])}</Text>
          </View>
        );
        return;
      }
      out.push(<Text key={k++} style={[styles.para, styles.body]}>{inlineSpans(line)}</Text>);
    });
    return out;
  }, [md, onHeadingY]);

  return <View>{blocks}</View>;
}

const styles = StyleSheet.create({
  para: { color: colors.text },
  bold: { fontWeight: '800', color: colors.text },
  italic: { fontStyle: 'italic' },
  code: { fontFamily: MONO, fontSize: 13, color: colors.text, backgroundColor: colors.surfaceAlt },
  body: { fontSize: 14.5, lineHeight: 21.5, color: colors.textMuted, marginBottom: spacing(2) },
  h1: { fontSize: 23, fontWeight: '800', marginTop: spacing(1), marginBottom: spacing(2), letterSpacing: -0.3 },
  h2: { fontSize: 18, fontWeight: '800', marginTop: spacing(5), marginBottom: spacing(2) },
  h3: { fontSize: 15.5, fontWeight: '700', marginTop: spacing(4), marginBottom: spacing(1) },
  h4: { fontSize: 13.5, fontWeight: '700', color: colors.textMuted, marginTop: spacing(3), marginBottom: 2 },
  hr: { height: 1, backgroundColor: colors.border, marginTop: spacing(2), marginBottom: spacing(1) },
  liRow: { flexDirection: 'row', marginBottom: spacing(1.5), paddingRight: spacing(2) },
  bulletDot: { color: colors.primary, fontSize: 15, lineHeight: 21.5, width: 18, textAlign: 'center' },
  numMark: { color: colors.primary, fontSize: 14.5, lineHeight: 21.5, minWidth: 22, fontWeight: '700' },
  li: { flex: 1, fontSize: 14.5, lineHeight: 21.5, color: colors.textMuted, marginBottom: 0 },
  callout: { flexDirection: 'row', gap: spacing(2.5), alignItems: 'flex-start', borderLeftWidth: 3, borderRadius: radius.md, paddingVertical: spacing(2.5), paddingHorizontal: spacing(3), marginVertical: spacing(2) },
  calloutIcon: { fontSize: 15, lineHeight: 21 },
  calloutText: { flex: 1, fontSize: 13.5, lineHeight: 20, color: colors.text },
});
