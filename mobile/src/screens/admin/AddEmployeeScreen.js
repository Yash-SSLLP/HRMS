import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';

import api, { errMsg } from '../../api/client';
import { useAuth } from '../../store/auth';
import { colors, radius, spacing, font } from '../../theme';
import { Screen, Card, AppButton, Input, Field, DateField, SectionHeader, Ionicons } from '../../components/ui';

export default function AddEmployeeScreen() {
  const nav = useNavigation();
  const myRole = useAuth((s) => s.user?.role);
  // HR Managers may only create Employee accounts; SuperAdmin can create more.
  const roleOptions = myRole === 'SuperAdmin' ? ['Employee', 'Manager', 'HRManager'] : ['Employee'];

  const [departments, setDepartments] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [f, setF] = useState({
    firstName: '', lastName: '', email: '', password: '', phone: '', role: 'Employee',
    employeeCode: '', dateOfJoining: '', designation: '', department: '', workLocation: '', dateOfBirth: '',
  });
  const set = (k, v) => setF((prev) => ({ ...prev, [k]: v }));

  useFocusEffect(
    useCallback(() => {
      api.get('/departments').then(({ data }) => setDepartments(data.departments || [])).catch(() => {});
    }, [])
  );

  const submit = async () => {
    if (!f.firstName || !f.lastName || !f.email || !f.password) {
      Alert.alert('Missing info', 'First name, last name, email and a temporary password are required.');
      return;
    }
    if (!f.employeeCode || !f.dateOfJoining) {
      Alert.alert('Missing info', 'Employee code and joining date are required.');
      return;
    }
    setSubmitting(true);
    let createdUser = null;
    try {
      // Step 1 — create the login account.
      const { data: u } = await api.post('/admin/users', {
        firstName: f.firstName.trim(),
        lastName: f.lastName.trim(),
        email: f.email.trim(),
        password: f.password,
        phone: f.phone || undefined,
        role: f.role,
      });
      createdUser = u.user;

      // Step 2 — create the employee profile linked to that account.
      await api.post('/employees', {
        user: createdUser._id,
        employeeCode: f.employeeCode.trim().toUpperCase(),
        dateOfJoining: f.dateOfJoining,
        designation: f.designation || undefined,
        department: f.department || undefined,
        workLocation: f.workLocation || undefined,
        dateOfBirth: f.dateOfBirth || undefined,
      });

      Alert.alert('Employee added', `${f.firstName} ${f.lastName} can now sign in with their email and the password you set.`, [
        { text: 'Done', onPress: () => nav.goBack() },
      ]);
    } catch (err) {
      // If the account was created but the profile failed, tell the admin so
      // they aren't left with a half-onboarded user silently.
      const msg = createdUser
        ? `The login account was created, but the employee profile failed: ${errMsg(err)}. You can finish it from the web portal.`
        : errMsg(err);
      Alert.alert('Could not add employee', msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen edges={[]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          <Card style={{ marginBottom: spacing(4) }}>
            <SectionHeader title="Login account" />
            <View style={{ flexDirection: 'row', gap: spacing(3) }}>
              <View style={{ flex: 1 }}><Field label="First name"><Input value={f.firstName} onChangeText={(v) => set('firstName', v)} placeholder="Asha" /></Field></View>
              <View style={{ flex: 1 }}><Field label="Last name"><Input value={f.lastName} onChangeText={(v) => set('lastName', v)} placeholder="Verma" /></Field></View>
            </View>
            <Field label="Email"><Input value={f.email} onChangeText={(v) => set('email', v)} placeholder="asha@company.com" autoCapitalize="none" keyboardType="email-address" /></Field>
            <Field label="Temporary password"><Input value={f.password} onChangeText={(v) => set('password', v)} placeholder="Set an initial password" autoCapitalize="none" /></Field>
            <Field label="Phone (optional)"><Input value={f.phone} onChangeText={(v) => set('phone', v)} placeholder="9876543210" keyboardType="phone-pad" /></Field>
            {roleOptions.length > 1 && (
              <Field label="Role">
                <View style={styles.chips}>
                  {roleOptions.map((r) => (
                    <TouchableOpacity key={r} onPress={() => set('role', r)} style={[styles.chip, f.role === r && styles.chipActive]}>
                      <Text style={[styles.chipText, f.role === r && { color: '#fff' }]}>{r}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </Field>
            )}
          </Card>

          <Card style={{ marginBottom: spacing(4) }}>
            <SectionHeader title="Employment" />
            <View style={{ flexDirection: 'row', gap: spacing(3) }}>
              <View style={{ flex: 1 }}><Field label="Employee code"><Input value={f.employeeCode} onChangeText={(v) => set('employeeCode', v)} placeholder="EMP042" autoCapitalize="characters" /></Field></View>
              <View style={{ flex: 1 }}><Field label="Joining date"><DateField value={f.dateOfJoining} onChange={(v) => set('dateOfJoining', v)} /></Field></View>
            </View>
            <Field label="Designation"><Input value={f.designation} onChangeText={(v) => set('designation', v)} placeholder="Software Engineer" /></Field>
            <Field label="Department">
              <Input value={f.department} onChangeText={(v) => set('department', v)} placeholder="Engineering" />
              {departments.length > 0 && (
                <View style={[styles.chips, { marginTop: 8 }]}>
                  {departments.slice(0, 8).map((d) => (
                    <TouchableOpacity key={d._id} onPress={() => set('department', d.name)} style={styles.deptChip}>
                      <Text style={styles.deptChipText}>{d.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </Field>
            <View style={{ flexDirection: 'row', gap: spacing(3) }}>
              <View style={{ flex: 1 }}><Field label="Work location"><Input value={f.workLocation} onChangeText={(v) => set('workLocation', v)} placeholder="Mumbai" /></Field></View>
              <View style={{ flex: 1 }}><Field label="Birthday (optional)"><DateField value={f.dateOfBirth} onChange={(v) => set('dateOfBirth', v)} maximumDate={new Date()} placeholder="Optional" /></Field></View>
            </View>
          </Card>

          <AppButton title="Add employee" icon="person-add" onPress={submit} loading={submitting} />
          <Text style={styles.hint}>Creates a login account and links an employee profile. The employee signs in with their email and the temporary password.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 16, height: 38, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontWeight: '700', fontSize: 13, color: colors.textMuted },
  deptChip: { paddingHorizontal: 12, height: 32, borderRadius: radius.pill, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  deptChipText: { color: colors.primary, fontWeight: '600', fontSize: 12 },
  hint: { ...font.small, textAlign: 'center', marginTop: spacing(3), paddingHorizontal: 16 },
});
