/**
 * Toast — non-blocking feedback, the mobile twin of the web's react-toastify.
 *
 * Replaces `Alert.alert('Saved', '…')` for plain feedback. A native alert is a
 * modal: it stops the app, dims the screen and demands a tap on OK just to
 * acknowledge that something succeeded. For "Saved" that is a lot of ceremony.
 * Real confirmations — anything with buttons and a decision — stay as
 * Alert.alert, because those SHOULD block.
 *
 * Imperative like the web's toast, so call sites need no context or hooks:
 *
 *   import { toast } from '../components/Toast';
 *   toast.success('Saved', 'Your changes are live.');
 *   toast.error('Could not save', errMsg(err));
 *   toast('Password updated');            // tone inferred from the title
 *
 * <ToastHost /> is mounted once in App.js above the navigator.
 */
import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, TouchableOpacity, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';

import { colors, radius, spacing, font, shadow } from '../theme';
import { Ionicons } from './ui';

const AUTO_DISMISS_MS = 3600;

// Tone inference, used only when a call site does not choose one — which is
// every mechanically-converted Alert.alert.
//
// Three-way on purpose. A plain pass/fail split paints anything that is not an
// error green, so a validation prompt like "Pick dates" arrives with a success
// tick, which is worse than no colour at all. Anything unrecognised falls to
// neutral info instead of claiming success.
const ERROR_WORDS = /(fail|error|could not|couldn't|cannot|unable|denied|invalid|not allowed|wrong|missing|required|too (large|big|many)|no .*(found|selected))/i;
const SUCCESS_WORDS = /(saved|submitted|updated|sent|approved|rejected|done|added|created|deleted|removed|released|uploaded|applied|copied|marked|cancelled|granted|complete)/i;

function inferTone(title, message) {
  const hay = `${title || ''} ${message || ''}`;
  if (ERROR_WORDS.test(hay)) return 'error';
  if (SUCCESS_WORDS.test(title || '')) return 'success';
  return 'info';
}

let seq = 0;

const useToastStore = create((set) => ({
  items: [],
  push: (item) => set((s) => ({
    // Newest first, and never more than three on screen — beyond that they
    // cover the content the user is trying to look at.
    items: [{ ...item, id: (seq += 1) }, ...s.items].slice(0, 3),
  })),
  dismiss: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}));

const show = (type, title, message) => {
  useToastStore.getState().push({ type: type || inferTone(title, message), title, message });
};

/** Show a toast; tone inferred from the title when not given explicitly. */
export function toast(title, message) { show(null, title, message); }
toast.success = (title, message) => show('success', title, message);
toast.error = (title, message) => show('error', title, message);
toast.info = (title, message) => show('info', title, message);
toast.warning = (title, message) => show('warning', title, message);

const TONE = {
  success: { rail: colors.success, icon: 'checkmark-circle' },
  error: { rail: colors.danger, icon: 'alert-circle' },
  warning: { rail: colors.warning, icon: 'warning' },
  info: { rail: colors.info, icon: 'information-circle' },
};

function ToastCard({ item, onDismiss }) {
  const anim = useRef(new Animated.Value(0)).current;
  const tone = TONE[item.type] || TONE.info;

  useEffect(() => {
    Animated.spring(anim, { toValue: 1, useNativeDriver: true, friction: 9, tension: 70 }).start();
    const t = setTimeout(() => {
      Animated.timing(anim, { toValue: 0, duration: 180, useNativeDriver: true })
        .start(() => onDismiss(item.id));
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <Animated.View
      style={[
        styles.card,
        {
          opacity: anim,
          transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-14, 0] }) }],
        },
      ]}
    >
      {/* The coloured status rail, matching the web toast. */}
      <View style={[styles.rail, { backgroundColor: tone.rail }]} />
      <Ionicons name={tone.icon} size={19} color={tone.rail} style={{ marginRight: 10 }} />
      <View style={{ flex: 1 }}>
        {item.title ? <Text style={styles.title} numberOfLines={2}>{item.title}</Text> : null}
        {item.message ? (
          <Text style={[font.small, { marginTop: item.title ? 2 : 0 }]} numberOfLines={3}>
            {item.message}
          </Text>
        ) : null}
      </View>
      <TouchableOpacity
        onPress={() => onDismiss(item.id)}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Ionicons name="close" size={17} color={colors.textFaint} />
      </TouchableOpacity>
    </Animated.View>
  );
}

/** Mounted once, above the navigator. Renders nothing when the queue is empty. */
export function ToastHost() {
  const items = useToastStore((s) => s.items);
  const dismiss = useToastStore((s) => s.dismiss);
  const insets = useSafeAreaInsets();
  if (!items.length) return null;
  return (
    // pointerEvents="box-none" so only the cards themselves take touches — the
    // screen underneath stays usable while a toast is up. That is the whole
    // point of not using Alert.
    <View style={[styles.host, { top: insets.top + spacing(2) }]} pointerEvents="box-none">
      {items.map((t) => <ToastCard key={t.id} item={t} onDismiss={dismiss} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', left: spacing(3), right: spacing(3), zIndex: 9999, elevation: 9999 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing(3),
    paddingRight: spacing(3),
    paddingLeft: spacing(4),
    marginBottom: spacing(2),
    ...(Platform.OS === 'android'
      ? { elevation: 6 }
      : { shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 16, shadowOffset: { width: 0, height: 8 } }),
    ...(shadow?.floating || {}),
  },
  rail: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 },
  title: { ...font.body, fontWeight: '700' },
});

export default ToastHost;
