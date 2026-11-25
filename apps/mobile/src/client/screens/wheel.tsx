/**
 * A scroll-wheel picker and the bottom sheet that holds it, in plain React Native (no native module), so the
 * same control runs on iOS and Android. Five rows are visible; the middle one is the selection. Screen readers
 * get an "adjustable" control that moves one row per swipe.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { MIN_TAP_TARGET, colors, radius, spacing } from '@facetype/design-system';

import { s } from '../strings.ts';

const ROW = MIN_TAP_TARGET;
const VISIBLE = 5;
const PAD = ROW * Math.floor(VISIBLE / 2);

const w = StyleSheet.create({
  wheel: { flex: 1, height: ROW * VISIBLE },
  band: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: PAD,
    height: ROW,
    borderRadius: radius.sm,
    backgroundColor: '#E8F0F7',
    borderWidth: 1,
    borderColor: colors.primary,
  },
  row: { height: ROW, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing[1] },
  item: { fontSize: 17, color: colors.muted },
  itemOn: { color: colors.text, fontWeight: '700' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
    padding: spacing[4],
    paddingBottom: spacing[8],
    gap: spacing[3],
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: MIN_TAP_TARGET },
  title: { fontSize: 17, fontWeight: '700', color: colors.text, writingDirection: 'rtl' },
  action: { fontSize: 16, fontWeight: '600', color: colors.primary, paddingHorizontal: spacing[2] },
  actionOff: { color: colors.muted },
  labels: { flexDirection: 'row', gap: spacing[2] },
  label: { flex: 1, textAlign: 'center', fontSize: 13, color: colors.muted },
});

function clamp(i: number, n: number): number {
  return Math.max(0, Math.min(n - 1, i));
}

export function Wheel({
  items,
  index,
  onChange,
  label,
}: {
  items: readonly string[];
  index: number;
  onChange: (index: number) => void;
  label: string;
}): ReactNode {
  const list = useRef<FlatList<string>>(null);
  const [current, setCurrent] = useState(clamp(index, items.length));

  // The parent moved the selection (e.g. 31 -> 30 when the month changes): follow it.
  useEffect(() => {
    const next = clamp(index, items.length);
    if (next !== current) {
      setCurrent(next);
      list.current?.scrollToOffset({ offset: next * ROW, animated: true });
    }
  }, [index, items.length]);

  const select = (i: number, scroll: boolean) => {
    const next = clamp(i, items.length);
    if (scroll) list.current?.scrollToOffset({ offset: next * ROW, animated: true });
    if (next !== current) {
      setCurrent(next);
      onChange(next);
    }
  };
  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>) =>
    select(Math.round(event.nativeEvent.contentOffset.y / ROW), false);

  return (
    <View
      style={w.wheel}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ text: items[current] ?? '' }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) =>
        select(current + (event.nativeEvent.actionName === 'increment' ? 1 : -1), true)
      }
    >
      <View pointerEvents="none" style={w.band} />
      <FlatList
        ref={list}
        data={items as string[]}
        keyExtractor={(_, i) => String(i)}
        getItemLayout={(_, i) => ({ length: ROW, offset: ROW * i, index: i })}
        initialScrollIndex={items.length > 0 ? current : undefined}
        initialNumToRender={VISIBLE * 3}
        contentContainerStyle={{ paddingVertical: PAD }}
        showsVerticalScrollIndicator={false}
        snapToInterval={ROW}
        decelerationRate="fast"
        nestedScrollEnabled
        onMomentumScrollEnd={settle}
        onScrollEndDrag={settle}
        renderItem={({ item, index: i }) => (
          <Pressable style={w.row} onPress={() => select(i, true)} importantForAccessibility="no">
            <Text style={[w.item, i === current && w.itemOn]} numberOfLines={1}>
              {item}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

/** Bottom sheet: «إلغاء» keeps the saved value, «تم» commits the wheels. */
export function PickerSheet({
  visible,
  title,
  canConfirm = true,
  onCancel,
  onDone,
  columnLabels,
  children,
}: {
  visible: boolean;
  title: string;
  canConfirm?: boolean;
  onCancel: () => void;
  onDone: () => void;
  columnLabels?: string[];
  children: ReactNode;
}): ReactNode {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={w.backdrop}>
        <Pressable style={{ flex: 1 }} onPress={onCancel} accessibilityLabel={s('common.cancel')} />
        <View style={w.sheet}>
          <View style={w.header}>
            <Pressable accessibilityRole="button" onPress={onCancel} hitSlop={8}>
              <Text style={w.action}>{s('common.cancel')}</Text>
            </Pressable>
            <Text style={w.title} accessibilityRole="header">
              {title}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !canConfirm }}
              disabled={!canConfirm}
              onPress={onDone}
              hitSlop={8}
            >
              <Text style={[w.action, !canConfirm && w.actionOff]}>{s('picker.done')}</Text>
            </Pressable>
          </View>
          {columnLabels ? (
            <View style={w.labels}>
              {columnLabels.map((text) => (
                <Text key={text} style={w.label}>
                  {text}
                </Text>
              ))}
            </View>
          ) : null}
          {children}
        </View>
      </View>
    </Modal>
  );
}
