/**
 * Small right-to-left form pieces shared by the client screens. Text scales
 * with the system font size (no `allowFontScaling={false}` anywhere), every
 * control has an accessibility role and label, and tap targets are ≥ 44 pt.
 */

import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type KeyboardTypeOptions } from 'react-native';

import { MIN_TAP_TARGET, colors, radius, spacing } from '@facetype/design-system';

import { countryName, filterCountries } from '../countries.ts';
import {
  ARABIC_MONTHS,
  clampDay,
  daysInMonth,
  formatBirthDate,
  toIso,
  wheelStart,
  yearsDescending,
  type Ymd,
} from '../datePicker.ts';
import { s } from '../strings.ts';
import { PickerSheet, Wheel } from './wheel.tsx';

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

/** The tappable box that shows the saved choice (or a prompt) and opens a picker sheet. */
function PickerBox({
  label,
  text,
  placeholder,
  error,
  onPress,
}: {
  label: string;
  text: string;
  placeholder: string;
  error?: string | null;
  onPress: () => void;
}): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityValue={{ text: text || placeholder }}
      accessibilityHint={error ?? undefined}
      onPress={onPress}
      style={[ui.input, { justifyContent: 'center' }, error ? ui.inputError : null]}
    >
      <Text style={[ui.text, !text && { color: colors.muted }]}>{text || placeholder}</Text>
    </Pressable>
  );
}

/**
 * Country by scroll wheel over the whole ISO list, with a search box above the wheel to narrow it. The stored
 * value is the ISO alpha-2 code. Nothing is preselected: the programme is worldwide.
 */
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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState(value);
  const list = filterCountries(query);
  const index = Math.max(0, list.findIndex((country) => country.code === draft));

  const show = () => {
    setQuery('');
    setDraft(value);
    setOpen(true);
  };
  const done = () => {
    const chosen = list[index];
    if (chosen) onChange(chosen.code);
    setOpen(false);
  };

  return (
    <View style={ui.field}>
      <Text style={ui.label}>{label}</Text>
      <PickerBox label={label} text={countryName(value)} placeholder={s('picker.choose_country')} error={error} onPress={show} />
      {error ? <Text style={ui.error}>{error}</Text> : null}
      <PickerSheet visible={open} title={label} canConfirm={list.length > 0} onCancel={() => setOpen(false)} onDone={done}>
        <TextInput
          accessibilityLabel={`${label} — ${s('setup.country_search')}`}
          value={query}
          onChangeText={setQuery}
          placeholder={s('setup.country_search')}
          autoCorrect={false}
          style={ui.input}
        />
        {list.length > 0 ? (
          <Wheel
            key={query}
            label={label}
            items={list.map((country) => country.name)}
            index={index}
            onChange={(i) => setDraft(list[i]?.code ?? '')}
          />
        ) : (
          <Text style={ui.hint}>{s('picker.no_country')}</Text>
        )}
      </PickerSheet>
    </View>
  );
}

/** Birth date by three wheels (day, month, year), right to left. The stored value is ISO `YYYY-MM-DD`. */
export function DateField({
  label,
  value,
  onChange,
  error,
  today = new Date(),
}: {
  label: string;
  value: string;
  onChange: (iso: string) => void;
  error?: string | null;
  today?: Date;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Ymd>(() => wheelStart(value, today));
  const years = yearsDescending(today);
  const days = Array.from({ length: daysInMonth(draft.y, draft.m) }, (_, i) => String(i + 1));

  const show = () => {
    setDraft(wheelStart(value, today));
    setOpen(true);
  };
  const done = () => {
    onChange(toIso(clampDay(draft)));
    setOpen(false);
  };

  return (
    <View style={ui.field}>
      <Text style={ui.label}>{label}</Text>
      <PickerBox label={label} text={formatBirthDate(value)} placeholder={s('picker.choose_date')} error={error} onPress={show} />
      {error ? <Text style={ui.error}>{error}</Text> : null}
      <PickerSheet
        visible={open}
        title={label}
        onCancel={() => setOpen(false)}
        onDone={done}
        columnLabels={[s('picker.day'), s('picker.month'), s('picker.year')]}
      >
        <View style={{ flexDirection: 'row', gap: spacing[2] }}>
          <View style={{ flex: 1 }}>
            <Wheel label={s('picker.day')} items={days} index={draft.d - 1} onChange={(i) => setDraft((d) => ({ ...d, d: i + 1 }))} />
          </View>
          <View style={{ flex: 1 }}>
            <Wheel
              label={s('picker.month')}
              items={ARABIC_MONTHS}
              index={draft.m - 1}
              onChange={(i) => setDraft((d) => clampDay({ ...d, m: i + 1 }))}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Wheel
              label={s('picker.year')}
              items={years.map(String)}
              index={Math.max(0, years.indexOf(draft.y))}
              onChange={(i) => setDraft((d) => clampDay({ ...d, y: years[i] ?? d.y }))}
            />
          </View>
        </View>
      </PickerSheet>
    </View>
  );
}
