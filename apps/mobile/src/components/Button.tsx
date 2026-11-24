/**
 * Button — FT-07 §5 states.
 *
 * `accessibilityRole` and a 44pt minimum height are not optional extras: the
 * capture flow is used one-handed while holding a phone at arm's length.
 */

import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text } from 'react-native';

import { styles, theme } from '../theme.ts';

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  loading?: boolean;
  accessibilityHint?: string;
}): ReactNode {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      onPress={onPress}
      disabled={isDisabled}
      style={[
        styles.button,
        variant === 'secondary' && styles.buttonSecondary,
        isDisabled && styles.buttonDisabled,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? theme.colors.surface : theme.colors.text} />
      ) : (
        <Text style={variant === 'primary' ? styles.buttonLabel : styles.buttonLabelSecondary}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}
