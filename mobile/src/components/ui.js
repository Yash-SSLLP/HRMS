import React from 'react';
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
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { colors, radius, shadow, font, spacing } from '../theme';
import { toYMD, toHM, to12h, fmtDate } from '../utils/format';

// Uses a plain View + safe-area insets (via the hook the tab bar already uses)
// rather than the native SafeAreaView component, which can render its children
// blank in some release builds.
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

export function Card({ children, style, onPress }) {
  const Comp = onPress ? TouchableOpacity : View;
  return (
    <Comp activeOpacity={0.85} onPress={onPress} style={[styles.card, style]}>
      {children}
    </Comp>
  );
}

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

export function Field({ label, error, children }) {
  return (
    <View style={{ marginBottom: spacing(4) }}>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      {children}
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
    </View>
  );
}

export function Input(props) {
  return (
    <TextInput
      placeholderTextColor={colors.textFaint}
      style={[styles.input, props.multiline && { height: 96, textAlignVertical: 'top' }, props.style]}
      {...props}
    />
  );
}

// Native date picker. Stores/returns a 'YYYY-MM-DD' string so it drops into the
// existing API payloads unchanged; displays the friendly date.
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

// Native time picker. Stores/returns a 24h 'HH:MM' string; displays 12-hour.
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

export function Avatar({ name, uri, size = 44, color = colors.primary }) {
  const initials = (name || '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('');
  if (uri) {
    return <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.border }} />;
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

export function Badge({ count, style }) {
  if (!count) return null;
  return (
    <View style={[styles.badge, style]}>
      <Text style={styles.badgeText}>{count > 99 ? '99+' : count}</Text>
    </View>
  );
}

export function Pill({ label, tone = 'neutral' }) {
  const t = pillTones[tone] || pillTones.neutral;
  return (
    <View style={[styles.pill, { backgroundColor: t.bg }]}>
      <Text style={[styles.pillText, { color: t.fg }]}>{label}</Text>
    </View>
  );
}

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

export function ProgressBar({ value = 0, tint = colors.primary, height = 8 }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <View style={{ height, borderRadius: height / 2, backgroundColor: colors.border, overflow: 'hidden' }}>
      <View style={{ width: `${pct}%`, height, borderRadius: height / 2, backgroundColor: tint }} />
    </View>
  );
}

export function Loader({ text }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.primary} size="large" />
      {text ? <Text style={[font.label, { marginTop: 12 }]}>{text}</Text> : null}
    </View>
  );
}

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

// IMPORTANT: this is a FACTORY FUNCTION, not a component — call it
// (`refresher(refreshing, onRefresh)`), don't render <Refresher/>. A ScrollView/
// FlatList `refreshControl` prop must be a literal RefreshControl element;
// passing a wrapper *component* blanks the whole list on some Android OEMs
// (realme/ColorOS). Returning the RefreshControl directly avoids that.
export function refresher(refreshing, onRefresh) {
  return <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} />;
}

const buttonVariants = {
  primary: { bg: colors.primary, fg: '#fff', border: colors.primary },
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
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export { Ionicons };
