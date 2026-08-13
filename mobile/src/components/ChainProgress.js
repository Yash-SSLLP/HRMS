/**
 * ChainProgress — an approval ladder drawn as a row of chips: who has approved,
 * whose turn it is now, who is still waiting. Mirrors the web's ChainProgress
 * (frontend/src/components/LeaveApprovalsInbox.jsx).
 *
 * Shared by the approver inbox (MyApprovalsScreen) and the employee's own leave
 * list (LeaveScreen). It used to live privately inside MyApprovalsScreen, which
 * meant the employee filing the leave could not see where their request had got
 * to — fine when the ladder was always their reporting line, misleading now that
 * a SuperAdmin can configure a 1-to-4 step ladder per employee that is NOT the
 * org chart (see EmployeeProfile.leaveApprovers).
 *
 * Chain-length agnostic on purpose: it renders whatever rungs the server sends.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, spacing, font } from '../theme';
import { Pill } from './ui';

// Tone per rung state, matching the web ladder's colours.
const STEP_TONE = {
  Waiting: 'neutral',
  Pending: 'warning',
  Approved: 'success',
  Rejected: 'danger',
  Skipped: 'neutral',
};

/**
 * @param {object[]} chain - approvalChain rungs ({approverName, status, order}).
 * @param {string} [emptyLabel] - shown when there is no ladder at all.
 * @param {boolean} [showPosition] - adds "Step N of M · with <name>" above the
 *   chips. Useful for the applicant, who wants the answer without decoding chip
 *   colours; noise for an approver, who only cares about their own rung.
 */
export default function ChainProgress({ chain = [], emptyLabel = 'No hierarchy — HR decides', showPosition = false }) {
  if (!chain.length) {
    return <Text style={[font.small, { fontStyle: 'italic', marginTop: 6 }]}>{emptyLabel}</Text>;
  }

  // The rung awaiting a decision, if the request is still travelling.
  const pendingIdx = chain.findIndex((s) => s.status === 'Pending');

  return (
    <View>
      {showPosition && pendingIdx >= 0 ? (
        <Text style={[font.small, { marginTop: 8, color: colors.textMuted }]}>
          Step {pendingIdx + 1} of {chain.length}
          {chain[pendingIdx].approverName ? ` · with ${chain[pendingIdx].approverName}` : ''}
        </Text>
      ) : null}
      <View style={styles.chain}>
        {chain.map((s, i) => (
          <View key={s._id || i} style={styles.chainStep}>
            {i > 0 ? <Text style={styles.chainArrow}>→</Text> : null}
            <Pill label={s.approverName || 'Approver'} tone={STEP_TONE[s.status] || 'neutral'} />
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chain: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginTop: 10 },
  chainStep: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  chainArrow: { color: colors.textFaint, fontSize: 12 },
});
