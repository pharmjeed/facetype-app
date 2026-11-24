/**
 * Small right-to-left form pieces shared by the client screens. Text scales
 * with the system font size (no `allowFontScaling={false}` anywhere), every
 * control has an accessibility role and label, and tap targets are ≥ 44 pt.
 */

import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type KeyboardTypeOptions } from 'react-native';

import { MIN_TAP_TARGET, colors, radius, spacing } from '@facetype/design-system';

import { countryName, searchCountries } from '../countries.ts';
import { s } from '../strings.ts';

export const ui = StyleSheet.create({
  label: { fontSize: 15, fontWeight: '600', color: colors.text, textAlign: 'right', writingDirection: 'rtl' },
  hint: { fontSize: 13, color: colors.muted, textAlign: 'right', writingDirection: 'rtl' },
  error: { fontSize: 13, color: colors.danger, textAlign: 'right', writingDirection: 'rtl' },
  text: { fontSize: 16, color: colors.text, lineHeight: 24, textAlign: 'right', writingDirection: 'rtl' },
  title: { fontSize: 24, fontWeight: '700', color: colors.text, textAlign: 'right', writingDirection: 'rtl' },
  h2: { fontSize: 19, fontWeight: '600', color: colors.text, textAlign: 'right', writingDirection: 'rtl' },
  input: {
    minHeight: MIN_TAP_TARGET,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing[3],
    fontSize: 16,
    color: colors.text,
    textAlign: 'right',
    writingDirection: 'rtl',
  },
  inputError: { borderColor: colors.danger },
  field: { gap: spacing[1] },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  choice: {
    minHeight: MIN_TAP_TARGET,
    paddingHorizontal: spacing[4],
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    justifyContent: 'center',
  },
  choiceOn: { borderColor: colors.primary, backgroundColor: '#E8F0F7' },
  choiceText: { fontSize: 15, color: colors.text },
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing[3], minHeight: MIN_TAP_TARGET },
  box: {
    width: 26,
    height: 26,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  boxOn: { backgroundColor: colors.primary },
  tick: { color: colors.surface, fontSize: 16, fontWeight: '700' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing[4],
    gap: spacing[3],
  },
  link: { fontSize: 15, color: colors.primary, fontWeight: '600', textAlign: 'right', paddingVertical: spacing[2] },
});

export function Field({
  label,
  value,
  onChange,
  error,
  hint,
  keyboardType,
  autoCapitalize = 'none',
  placeholder,
  ltr = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  hint?: string | null;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: 'none' | 'characters' | 'words';
  placeholder?: string;
  ltr?: boolean;
}): ReactNode {
  return (
    <View style={ui.field}>
      <Text style={ui.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={error ?? hint ?? undefined}
        value={value}
        onChangeText={onChange}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        placeholder={placeholder}
        style={[ui.input, ltr && { textAlign: 'left', writingDirection: 'ltr' }, error ? ui.inputError : null]}
      />
      {hint ? <Text style={ui.hint}>{hint}</Text> : null}
      {error ? (
        <Text style={ui.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function Choices<T extends string>({
  label,
  options,
  value,
  onChange,
  error,
}: {
  label: string;
  options: Array<{ value: T; label: string }>;
  value: T | null;
  onChange: (value: T) => void;
  error?: string | null;
}): ReactNode {
  return (
    <View style={ui.field} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <Text style={ui.label}>{label}</Text>
      <View style={ui.row}>
        {options.map((option) => {
          const on = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ selected: on, checked: on }}
              accessibilityLabel={option.label}
              onPress={() => onChange(option.value)}
              style={[ui.choice, on && ui.choiceOn]}
            >
              <Text style={ui.choiceText}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {error ? <Text style={ui.error}>{error}</Text> : null}
    </View>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      onPress={() => onChange(!checked)}
      style={ui.checkRow}
    >
      <View style={[ui.box, checked && ui.boxOn]}>{checked ? <Text style={ui.tick}>✓</Text> : null}</View>
      <Text style={[ui.text, { flex: 1 }]}>{label}</Text>
    </Pressable>
  );
}

export function LinkButton({ label, onPress }: { label: string; onPress: () => void }): ReactNode {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={8}>
      <Text style={ui.link}>{label}</Text>
    </Pressable>
  );
}

/** Country by Arabic name or ISO code; the stored value is the ISO alpha-2 code. */
export function CountryField({
  label,
  value,
  onChange,
  error,
}: {
  label: string;
  value: string;
  onChange: (code: string) => void;
  error?: string | null;
}): ReactNode {
  const [query, setQuery] = useState('');
  const matches = searchCountries(query);
  return (
    <View style={ui.field}>
      <Text style={ui.label}>{label}</Text>
      {value ? <Text style={ui.text}>{s('setup.country_selected', { name: countryName(value) })}</Text> : null}
      <TextInput
        accessibilityLabel={`${label} — ${s('setup.country_search')}`}
        value={query}
        onChangeText={setQuery}
        placeholder={s('setup.country_search')}
        autoCorrect={false}
        style={[ui.input, error ? ui.inputError : null]}
      />
      {matches.length > 0 ? (
        <View style={ui.row}>
          {matches.map((country) => (
            <Pressable
              key={country.code}
              accessibilityRole="button"
              accessibilityLabel={country.name}
              onPress={() => {
                onChange(country.code);
                setQuery('');
              }}
              style={[ui.choice, country.code === value && ui.choiceOn]}
            >
              <Text style={ui.choiceText}>{country.name}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {error ? <Text style={ui.error}>{error}</Text> : null}
    </View>
  );
}
