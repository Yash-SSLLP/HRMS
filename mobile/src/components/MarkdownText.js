import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, spacing } from '../theme';

// Minimal, dependency-free Markdown renderer for the in-app guides. Handles the
// subset the guides use: #/##/###/#### headings, **bold**, *italic*, "- " bullets,
// "1." numbered lists, "---" rules, and plain paragraphs (emoji render as text).
// Theme-aware, so it reads correctly in light and dark mode.

function inlineSpans(text) {
  const out = [];
  let rest = text;
  let k = 0;
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*)/;
  while (rest) {
    const m = rest.match(re);
    if (!m) { out.push(<Text key={k++}>{rest}</Text>); break; }
    if (m.index > 0) out.push(<Text key={k++}>{rest.slice(0, m.index)}</Text>);
    if (m[2] != null) out.push(<Text key={k++} style={{ fontWeight: '800' }}>{m[2]}</Text>);
    else out.push(<Text key={k++} style={{ fontStyle: 'italic' }}>{m[3]}</Text>);
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

export default function MarkdownText({ md }) {
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
        out.push(
          <Text key={k++} style={[styles.para, styles[`h${lvl}`]]}>{inlineSpans(h[2])}</Text>
        );
        if (lvl === 2) out.push(<View key={k++} style={styles.hr} />);
        return;
      }
      if (/^(-{3,}|\*{3,})$/.test(line.trim())) { out.push(<View key={k++} style={styles.hr} />); return; }
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
  }, [md]);

  return <View>{blocks}</View>;
}

const styles = StyleSheet.create({
  para: { color: colors.text },
  body: { fontSize: 14.5, lineHeight: 21, color: colors.textMuted, marginBottom: spacing(2) },
  h1: { fontSize: 22, fontWeight: '800', marginTop: spacing(1), marginBottom: spacing(2) },
  h2: { fontSize: 18, fontWeight: '800', marginTop: spacing(4), marginBottom: spacing(1) },
  h3: { fontSize: 15.5, fontWeight: '700', marginTop: spacing(3), marginBottom: spacing(1) },
  h4: { fontSize: 13.5, fontWeight: '700', color: colors.textMuted, marginTop: spacing(2), marginBottom: 2 },
  hr: { height: 1, backgroundColor: colors.border, marginVertical: spacing(3) },
  liRow: { flexDirection: 'row', marginBottom: spacing(1.5), paddingRight: spacing(2) },
  bulletDot: { color: colors.primary, fontSize: 15, lineHeight: 21, width: 18, textAlign: 'center' },
  numMark: { color: colors.primary, fontSize: 14.5, lineHeight: 21, minWidth: 22, fontWeight: '700' },
  li: { flex: 1, fontSize: 14.5, lineHeight: 21, color: colors.textMuted, marginBottom: 0 },
});
