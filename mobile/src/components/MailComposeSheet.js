import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import { colors, radius, spacing, font } from '../theme';
import { ModalSheet, Field, Input, AppButton, Ionicons } from './ui';

/**
 * Editable email composer — the mobile twin of the web MailComposeModal.
 * Shows exactly what will be sent (recipients, subject, body, attachments)
 * and lets HR/admin edit the subject + body before it goes out. Nothing is
 * emailed until the send button is pressed.
 *
 * Props: visible, onClose, mail:
 *   to           string | [string] — read-only recipient display
 *   subject      prefilled, editable
 *   body         prefilled, editable
 *   title        sheet heading (default 'Send email')
 *   note         optional explanation under the heading
 *   attachments  [string] optional — file names attached on send
 *   link         optional public link shown as a hint
 *   sendLabel    button label (default 'Send email')
 *   onSend       async ({ subject, body }) — performs the delivery
 */
export default function MailComposeSheet({ visible, onClose, mail }) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  // Re-seed the editable fields each time the sheet is (re)opened.
  useEffect(() => {
    if (visible && mail) {
      setSubject(mail.subject || '');
      setBody(mail.body || '');
    }
  }, [visible, mail]);

  if (!mail) return null;
  const to = Array.isArray(mail.to) ? mail.to.join(', ') : (mail.to || '');

  const send = async () => {
    setSending(true);
    try {
      await mail.onSend({ subject, body });
      onClose();
    } catch (err) {
      Alert.alert('Could not send', err?.response?.data?.message || err?.message || 'Something went wrong');
    } finally {
      setSending(false);
    }
  };

  return (
    <ModalSheet
      visible={visible}
      onClose={onClose}
      title={mail.title || 'Send email'}
      footer={<AppButton title={mail.sendLabel || 'Send email'} icon="send" loading={sending} onPress={send} />}
    >
      {mail.note ? <Text style={[font.small, { marginBottom: spacing(3) }]}>{mail.note}</Text> : null}
      <Field label="To"><Text style={styles.toText}>{to}</Text></Field>
      <Field label="Subject"><Input value={subject} onChangeText={setSubject} /></Field>
      <Field label="Message"><Input value={body} onChangeText={setBody} multiline style={{ height: 220 }} /></Field>
      {(mail.attachments || []).length ? (
        <View style={styles.hintRow}>
          <Ionicons name="attach" size={16} color={colors.textMuted} />
          <Text style={[font.small, { flex: 1, marginLeft: 6 }]} numberOfLines={2}>
            Attached: {mail.attachments.join(', ')}
          </Text>
        </View>
      ) : null}
      {mail.link ? (
        <View style={styles.hintRow}>
          <Ionicons name="link-outline" size={16} color={colors.textMuted} />
          <Text style={[font.small, { flex: 1, marginLeft: 6 }]} numberOfLines={2}>{mail.link}</Text>
        </View>
      ) : null}
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  toText: {
    ...font.body,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  hintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: spacing(2),
  },
});
