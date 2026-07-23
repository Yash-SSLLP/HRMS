// components/ui.js — the shared UI kit used across every screen.
// Themed primitives (Screen, Card, AppButton, Input, Field), native date/time
// pickers, Avatar (auth-header image with initials fallback), status Pill/Badge,
// stat/chart bits, loaders/skeletons, EmptyState, ModalSheet, ChipSelect, Stars,
// and the refresher() factory. Several patterns work around Android OEM render
// bugs (see the per-export notes). Also re-exports Ionicons for convenience.
import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Image,
  RefreshControl,
  Platform,
  Modal as RNModal,
  ScrollView,
  KeyboardAvoidingView,
  Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { colors, radius, shadow, font, spacing } from '../theme';
import { toYMD, toHM, to12h, fmtDate } from '../utils/format';
import { useAuth } from '../store/auth';

/**
 * Root screen container applying safe-area padding for the given `edges`.
 * Uses a plain View + insets hook rather than native SafeAreaView, which can
 * render its children blank in some release builds.
 * @prop {string[]} [edges] Which edges to inset (default ['top']).
 */
export function Screen({ children, style, edges = ['top'] }) {
  const insets = useSafeAreaInsets();
  const pad = {
    paddingTop: edges.includes('top') ? insets.top : 0,
    paddingBottom: edges.includes('bottom') ? insets.bottom : 0,
    paddingLeft: edges.includes('left') ? insets.left : 0,
    paddingRight: edges.includes('right') ? insets.right : 0,
  };
  return <View style={[styles.screen, pad, style]}>{children}</View>;
}

/** Surface card; becomes touchable when `onPress` is provided. */
export function Card({ children, style, onPress }) {
  const Comp = onPress ? TouchableOpacity : View;
  return (
    <Comp activeOpacity={0.85} onPress={onPress} style={[styles.card, style]}>
      {children}
    </Comp>
  );
}

/**
 * Primary action button with loading spinner and optional leading icon.
 * @prop {string} [variant] One of buttonVariants (primary/dark/success/danger/outline/ghost).
 * @prop {boolean} [loading] Shows a spinner and disables the button.
 * @prop {string} [icon] Ionicons name shown before the title.
 */
export function AppButton({ title, onPress, loading, disabled, variant = 'primary', icon, style }) {
  const v = buttonVariants[variant] || buttonVariants.primary;
  const isDisabled = disabled || loading;
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      disabled={isDisabled}
      style={[styles.btn, { backgroundColor: v.bg, borderColor: v.border }, isDisabled && { opacity: 0.55 }, style]}
    >
      {loading ? (
        <ActivityIndicator color={v.fg} />
      ) : (
        <View style={styles.btnInner}>
          {icon ? <Ionicons name={icon} size={18} color={v.fg} style={{ marginRight: 8 }} /> : null}
          <Text style={[styles.btnText, { color: v.fg }]}>{title}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

/** Labeled form field wrapper with an optional validation error line. */
export function Field({ label, error, children }) {
  return (
    <View style={{ marginBottom: spacing(4) }}>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      {children}
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
    </View>
  );
}

/** Themed TextInput; grows taller when `multiline`. Forwards all TextInput props. */
export function Input(props) {
  return (
    <TextInput
      placeholderTextColor={colors.textFaint}
      style={[styles.input, props.multiline && { height: 96, textAlignVertical: 'top' }, props.style]}
      {...props}
    />
  );
}

/**
 * Native date picker. Stores/returns a 'YYYY-MM-DD' string so it drops into the
 * existing API payloads unchanged; displays the friendly date.
 */
export function DateField({ value, onChange, placeholder = 'Select date', minimumDate, maximumDate }) {
  const [show, setShow] = useState(false);
  const dateObj = value ? new Date(`${value}T00:00:00`) : new Date();
  return (
    <View>
      <TouchableOpacity activeOpacity={0.7} style={styles.picker} onPress={() => setShow(true)}>
        <Text style={[styles.pickerText, !value && { color: colors.textFaint }]}>{value ? fmtDate(value) : placeholder}</Text>
        <Ionicons name="calendar-outline" size={18} color={colors.textMuted} />
      </TouchableOpacity>
      {show && (
        <DateTimePicker
          value={dateObj}
          mode="date"
          display={Platform.OS === 'ios' ? 'inline' : 'default'}
          minimumDate={minimumDate}
          maximumDate={maximumDate}
          onChange={(e, d) => {
            setShow(Platform.OS === 'ios');
            if (e.type === 'set' && d) onChange(toYMD(d));
            if (Platform.OS === 'ios' && e.type === 'dismissed') setShow(false);
          }}
        />
      )}
    </View>
  );
}

/** Native time picker. Stores/returns a 24h 'HH:MM' string; displays 12-hour. */
export function TimeField({ value, onChange, placeholder = 'Select time' }) {
  const [show, setShow] = useState(false);
  const base = new Date();
  if (value && /^\d{1,2}:\d{2}$/.test(value)) {
    const [h, m] = value.split(':').map(Number);
    base.setHours(h, m, 0, 0);
  }
  return (
    <View>
      <TouchableOpacity activeOpacity={0.7} style={styles.picker} onPress={() => setShow(true)}>
        <Text style={[styles.pickerText, !value && { color: colors.textFaint }]}>{value ? to12h(value) : placeholder}</Text>
        <Ionicons name="time-outline" size={18} color={colors.textMuted} />
      </TouchableOpacity>
      {show && (
        <DateTimePicker
          value={base}
          mode="time"
          is24Hour={false}
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          onChange={(e, d) => {
            setShow(Platform.OS === 'ios');
            if (e.type === 'set' && d) onChange(toHM(d));
            if (Platform.OS === 'ios' && e.type === 'dismissed') setShow(false);
          }}
        />
      )}
    </View>
  );
}

/**
 * Circular avatar. Renders the photo at `uri` (attaching the auth bearer token
 * as a request header), falling back to the person's initials.
 * @prop {string} name Used to derive initials.
 * @prop {string} [uri] Auth-protected avatar URL.
 */
export function Avatar({ name, uri, size = 44, color = colors.primary }) {
  // The avatar endpoint is auth-protected, so a bare <Image uri> 401s and shows
  // nothing. Attach the bearer token as a request header, and fall back to
  // initials if the image still fails to load (no photo / stale path).
  const token = useAuth((s) => s.token);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [uri]);
  const initials = (name || '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('');
  if (uri && !failed) {
    return (
      <Image
        source={{ uri, headers: token ? { Authorization: `Bearer ${token}` } : undefined }}
        onError={() => setFailed(true)}
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.border }}
      />
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color + '22',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color, fontWeight: '700', fontSize: size * 0.38 }}>{initials || '?'}</Text>
    </View>
  );
}

/** Small count badge; renders nothing when count is falsy, caps display at 99+. */
export function Badge({ count, style }) {
  if (!count) return null;
  return (
    <View style={[styles.badge, style]}>
      <Text style={styles.badgeText}>{count > 99 ? '99+' : count}</Text>
    </View>
  );
}

/** Status pill; `tone` selects colour (neutral/success/warning/danger/info/primary). */
export function Pill({ label, tone = 'neutral' }) {
  const t = pillTones[tone] || pillTones.neutral;
  return (
    <View style={[styles.pill, { backgroundColor: t.bg }]}>
      <Text style={[styles.pillText, { color: t.fg }]}>{label}</Text>
    </View>
  );
}

/** Section title row with an optional right-aligned action link. */
export function SectionHeader({ title, action, onAction }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={font.h3}>{title}</Text>
      {action ? (
        <TouchableOpacity onPress={onAction}>
          <Text style={styles.sectionAction}>{action}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

/** Dashboard stat tile: icon + value + label; touchable when `onPress` is set. */
export function StatTile({ icon, label, value, tint = colors.primary, onPress }) {
  const Comp = onPress ? TouchableOpacity : View;
  return (
    <Comp activeOpacity={0.85} onPress={onPress} style={[styles.stat]}>
      <View style={[styles.statIcon, { backgroundColor: tint + '1a' }]}>
        <Ionicons name={icon} size={20} color={tint} />
      </View>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </Comp>
  );
}

/**
 * Lightweight horizontally-scrollable vertical bar chart (no chart lib).
 * @prop {{label: string, value: number}[]} data Bars to plot.
 */
export function MiniBarChart({ data = [], height = 130, tint = colors.primary }) {
  if (!data.length) return <Text style={font.label}>No data yet.</Text>;
  const max = Math.max(1, ...data.map((d) => d.value || 0));
  const plotH = height - 30;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingVertical: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height }}>
        {data.map((d, i) => {
          const h = Math.max(3, Math.round(((d.value || 0) / max) * plotH));
          return (
            <View key={i} style={{ alignItems: 'center', width: 30 }}>
              <Text style={{ fontSize: 10, fontWeight: '700', color: colors.textMuted, marginBottom: 3 }}>{d.value}</Text>
              <View style={{ width: 16, height: h, borderRadius: 5, backgroundColor: tint }} />
              <Text style={{ fontSize: 9, color: colors.textFaint, marginTop: 4 }} numberOfLines={1}>{d.label}</Text>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

/** Horizontal progress bar; `value` is a 0–100 percentage (clamped). */
export function ProgressBar({ value = 0, tint = colors.primary, height = 8 }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <View style={{ height, borderRadius: height / 2, backgroundColor: colors.border, overflow: 'hidden' }}>
      <View style={{ width: `${pct}%`, height, borderRadius: height / 2, backgroundColor: tint }} />
    </View>
  );
}

/** Centered spinner with optional caption, for first-load states. */
export function Loader({ text }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.primary} size="large" />
      {text ? <Text style={[font.label, { marginTop: 12 }]}>{text}</Text> : null}
    </View>
  );
}

/** A single shimmering placeholder bar; pulses opacity on the native driver. */
export function SkeletonBlock({ width = '100%', height = 14, radius = 8, style }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 750, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0, duration: 750, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);
  const opacity = anim.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0.9] });
  return <Animated.View style={[{ width, height, borderRadius: radius, backgroundColor: colors.border, opacity }, style]} />;
}

/**
 * Full-screen skeleton: a title bar + `cards` card placeholders. Drop-in for the
 * <Loader> that most screens show while their first data load is in flight.
 */
export function SkeletonScreen({ cards = 4 }) {
  return (
    <View style={{ padding: spacing(4) }}>
      <SkeletonBlock width={150} height={22} style={{ marginBottom: spacing(4) }} />
      {Array.from({ length: cards }).map((_, i) => (
        <View key={i} style={styles.skelCard}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing(3) }}>
            <SkeletonBlock width={40} height={40} radius={20} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <SkeletonBlock width="55%" height={14} style={{ marginBottom: 8 }} />
              <SkeletonBlock width="35%" height={11} />
            </View>
          </View>
          <SkeletonBlock width="100%" height={11} style={{ marginBottom: 8 }} />
          <SkeletonBlock width="80%" height={11} />
        </View>
      ))}
    </View>
  );
}

/** Empty-list placeholder: icon + title + optional subtitle. */
export function EmptyState({ icon = 'file-tray', title, subtitle }) {
  return (
    <View style={styles.center}>
      <View style={styles.emptyIcon}>
        <Ionicons name={icon} size={30} color={colors.textFaint} />
      </View>
      <Text style={[font.h3, { marginTop: 12 }]}>{title}</Text>
      {subtitle ? <Text style={[font.label, { marginTop: 4, textAlign: 'center', paddingHorizontal: 24 }]}>{subtitle}</Text> : null}
    </View>
  );
}

/**
 * Build a themed RefreshControl element for a ScrollView/FlatList.
 * IMPORTANT: this is a FACTORY FUNCTION, not a component — call it
 * (`refresher(refreshing, onRefresh)`), don't render <Refresher/>. The
 * `refreshControl` prop must be a literal RefreshControl element; passing a
 * wrapper *component* blanks the whole list on some Android OEMs (realme/ColorOS).
 */
export function refresher(refreshing, onRefresh) {
  return <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} />;
}

/**
 * Bottom-sheet style modal with a scrollable body and an optional sticky footer
 * (for save/cancel buttons). Used by the recruitment forms and day sheets.
 */
export function ModalSheet({ visible, onClose, title, children, footer }) {
  return (
    <RNModal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.modalBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={onClose} />
        <View style={styles.modalSheet}>
          <View style={styles.modalHandle} />
          <View style={styles.modalHeader}>
            <Text style={font.h2}>{title}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: spacing(2) }}>
            {children}
          </ScrollView>
          {footer ? <View style={styles.modalFooter}>{footer}</View> : null}
        </View>
      </KeyboardAvoidingView>
    </RNModal>
  );
}

/**
 * Inline single-select chip group.
 * @prop {Array} options Choices; `getLabel`/`getValue` map each to text/value.
 */
export function ChipSelect({ options, value, onChange, getLabel = (o) => o, getValue = (o) => o }) {
  return (
    <View style={styles.chipsWrap}>
      {options.map((o) => {
        const v = getValue(o);
        const active = v === value;
        return (
          <TouchableOpacity key={String(v)} onPress={() => onChange(v)} style={[styles.chip, active && styles.chipActive]}>
            <Text style={[styles.chipText, active && { color: '#fff' }]}>{getLabel(o)}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

/** 0–5 star rating; read-only unless `onChange` is provided (tap toggles). */
export function Stars({ value = 0, onChange, size = 22 }) {
  return (
    <View style={{ flexDirection: 'row' }}>
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= Math.round(value);
        const Star = (
          <Ionicons name={filled ? 'star' : 'star-outline'} size={size} color={filled ? '#f59e0b' : colors.borderStrong} style={{ marginRight: 4 }} />
        );
        return onChange ? (
          <TouchableOpacity key={n} onPress={() => onChange(n === value ? 0 : n)} hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}>
            {Star}
          </TouchableOpacity>
        ) : (
          <View key={n}>{Star}</View>
        );
      })}
    </View>
  );
}

const buttonVariants = {
  // Gold brand button reads best with near-black text (logo gold + black).
  primary: { bg: colors.primary, fg: '#1a1a1a', border: colors.primary },
  dark: { bg: colors.text, fg: '#fff', border: colors.text },
  success: { bg: colors.success, fg: '#fff', border: colors.success },
  danger: { bg: colors.danger, fg: '#fff', border: colors.danger },
  outline: { bg: 'transparent', fg: colors.primary, border: colors.primary },
  ghost: { bg: colors.surfaceAlt, fg: colors.text, border: colors.border },
};

const pillTones = {
  neutral: { bg: colors.surfaceAlt, fg: colors.textMuted },
  success: { bg: colors.successSoft, fg: colors.success },
  warning: { bg: colors.warningSoft, fg: colors.warning },
  danger: { bg: colors.dangerSoft, fg: colors.danger },
  info: { bg: colors.infoSoft, fg: colors.info },
  primary: { bg: colors.primarySoft, fg: colors.primary },
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing(4),
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  btn: {
    height: 50,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  btnInner: { flexDirection: 'row', alignItems: 'center' },
  btnText: { fontSize: 15, fontWeight: '700' },
  fieldLabel: { ...font.label, marginBottom: 6 },
  fieldError: { color: colors.danger, fontSize: 12, marginTop: 4 },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    height: 48,
    fontSize: 15,
    color: colors.text,
  },
  picker: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    height: 48,
  },
  pickerText: { fontSize: 15, color: colors.text },
  badge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: 9,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, alignSelf: 'flex-start' },
  pillText: { fontSize: 12, fontWeight: '700' },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing(3),
    marginTop: spacing(2),
  },
  sectionAction: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  stat: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing(3.5),
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  statIcon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  statValue: { fontSize: 20, fontWeight: '800', color: colors.text },
  statLabel: { fontSize: 12, color: colors.textMuted, marginTop: 2, fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  skelCard: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing(4), marginBottom: spacing(3) },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing(4),
    paddingTop: spacing(2),
    paddingBottom: spacing(4),
    maxHeight: '90%',
  },
  modalHandle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong, marginBottom: spacing(3) },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing(3) },
  modalFooter: { paddingTop: spacing(3), borderTopWidth: 1, borderTopColor: colors.border, marginTop: spacing(2) },
  chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, height: 36, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontWeight: '700', fontSize: 13, color: colors.textMuted },
});

export { Ionicons };
