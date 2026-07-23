// components/ErrorBoundary.js — top-level React error boundary.
// Catches render-time errors from anywhere in the tree below it and shows the
// error message + component stack (with a "Try again" reset) instead of a blank
// white screen, so production crashes are diagnosable on-device.
import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { colors, radius, spacing, font } from '../theme';

/**
 * Class component error boundary. Wrap around the navigation tree.
 * @prop {React.ReactNode} children Subtree to guard.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    // Also log so it shows in Metro / logcat.
    console.error('App crashed:', error?.message, info?.componentStack);
  }

  reset = () => this.setState({ error: null, info: null });

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <View style={styles.root}>
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.sub}>The screen hit an error. Details below:</Text>
        <ScrollView style={styles.box} contentContainerStyle={{ padding: 14 }}>
          <Text style={styles.err}>{String(this.state.error?.message || this.state.error)}</Text>
          {this.state.info?.componentStack ? (
            <Text style={styles.stack}>{this.state.info.componentStack}</Text>
          ) : null}
        </ScrollView>
        <TouchableOpacity style={styles.btn} onPress={this.reset}>
          <Text style={styles.btnText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: spacing(5), paddingTop: spacing(12) },
  title: { ...font.h1, color: colors.danger },
  sub: { ...font.label, marginTop: 6, marginBottom: 16 },
  box: { flex: 1, backgroundColor: '#1f2937', borderRadius: radius.md },
  err: { color: '#fca5a5', fontSize: 13, fontWeight: '700', fontFamily: 'monospace' },
  stack: { color: '#9ca3af', fontSize: 11, marginTop: 12, fontFamily: 'monospace' },
  btn: { backgroundColor: colors.primary, borderRadius: radius.md, height: 50, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
