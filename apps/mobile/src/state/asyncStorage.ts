import AsyncStorage from '@react-native-async-storage/async-storage';

import type { ScanState } from './scanFlow.ts';
import {
  persistScanState as persistWithStorage,
  recoverScanState as recoverWithStorage,
} from './persistence.ts';

/** React Native adapter; the serialisation and validation remain unit-testable. */
export function persistScanState(state: ScanState): Promise<void> {
  return persistWithStorage(state, AsyncStorage);
}

export function recoverScanState(): Promise<ScanState | null> {
  return recoverWithStorage(AsyncStorage);
}
