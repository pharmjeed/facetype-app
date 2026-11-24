/**
 * React Native styles derived from the shared design tokens (FT-07).
 *
 * The mobile app and the research console read the same tokens, so a colour or
 * spacing decision is made once and applied twice.
 */

import { StyleSheet } from 'react-native';

import { MIN_TAP_TARGET, colors, radius, spacing } from '@facetype/design-system';

export const theme = { colors, spacing, radius, MIN_TAP_TARGET };

export const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: spacing[6],
    gap: spacing[4],
  },
  centered: { flex: 1, justifyContent: 'center', gap: spacing[4] },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing[4],
    gap: spacing[3],
  },
  display: { fontSize: 30, fontWeight: '700', color: colors.text },
  h1: { fontSize: 24, fontWeight: '700', color: colors.text },
  h2: { fontSize: 20, fontWeight: '600', color: colors.text },
  body: { fontSize: 16, color: colors.text, lineHeight: 24 },
  muted: { fontSize: 14, color: colors.muted, lineHeight: 21 },
  caption: { fontSize: 13, color: colors.muted },

  button: {
    minHeight: MIN_TAP_TARGET,
    borderRadius: radius.sm,
    paddingHorizontal: spacing[6],
    paddingVertical: spacing[3],
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  buttonSecondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  buttonDisabled: { backgroundColor: colors.border },
  buttonLabel: { color: colors.surface, fontSize: 16, fontWeight: '600' },
  buttonLabelSecondary: { color: colors.text, fontSize: 16, fontWeight: '600' },

  row: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  stepper: { flexDirection: 'row', gap: spacing[2], justifyContent: 'center' },
  stepDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.border },
  stepDotDone: { backgroundColor: colors.primary },
  stepDotActive: { backgroundColor: colors.accent },

  faceFrame: {
    aspectRatio: 3 / 4,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  faceFrameActive: { borderColor: colors.accent },
  faceFrameWarn: { borderColor: colors.warning },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  chip: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipPass: { borderColor: colors.success },
  chipWarn: { borderColor: colors.warning },
  chipText: { fontSize: 13, color: colors.text },

  bar: { height: 8, borderRadius: 4, backgroundColor: colors.border, overflow: 'hidden' },
  barFill: { height: 8, backgroundColor: colors.primary },
});
