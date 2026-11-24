/**
 * Typed React Native binding for `FaceTypeClientCamera` (module) and
 * `FaceTypeClientCameraView` (view), exactly as
 * docs/client-native-interface.md §2–§3.
 *
 * When the native module is absent — Metro dev bundles on a machine without
 * the native build, or before the native side lands — dev bundles fall back to
 * `SimulatorClientCamera` and a placeholder view that plays synthetic
 * measures. A release bundle (`__DEV__ === false`) never does: it reports
 * `camera_unavailable` instead, so a store build cannot collect synthetic
 * frames.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import {
  NativeModules,
  requireNativeComponent,
  StyleSheet,
  Text,
  UIManager,
  View,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { SimulatorClientCamera, syntheticMeasure } from './simulator.ts';
import {
  toCameraError,
  type BurstProgress,
  type CameraError,
  type ClientCameraModule,
  type FrameMeasure,
} from './types.ts';
import { s } from '../strings.ts';

export const NATIVE_VIEW_NAME = 'FaceTypeClientCameraView';
export const NATIVE_MODULE_NAME = 'FaceTypeClientCamera';

const isDev = typeof __DEV__ === 'boolean' && __DEV__;

function nativeModule(): ClientCameraModule | null {
  const module = (NativeModules as Record<string, ClientCameraModule | undefined>)[NATIVE_MODULE_NAME];
  return module ?? null;
}

function nativeViewAvailable(): boolean {
  try {
    const config: unknown = UIManager.getViewManagerConfig?.(NATIVE_VIEW_NAME);
    return config !== null && config !== undefined;
  } catch {
    return false;
  }
}

export type CameraBackend =
  | { kind: 'native'; module: ClientCameraModule }
  | { kind: 'simulator'; module: SimulatorClientCamera }
  | { kind: 'unavailable' };

let cachedBackend: CameraBackend | null = null;

export function cameraBackend(): CameraBackend {
  if (cachedBackend) return cachedBackend;
  const module = nativeModule();
  if (module && nativeViewAvailable()) cachedBackend = { kind: 'native', module };
  else if (isDev) cachedBackend = { kind: 'simulator', module: new SimulatorClientCamera() };
  else cachedBackend = { kind: 'unavailable' };
  return cachedBackend;
}

interface NativeViewProps {
  active: boolean;
  gateConfig: string;
  style?: StyleProp<ViewStyle>;
  onFrameMeasure?: (event: NativeSyntheticEvent<FrameMeasure>) => void;
  onBurstProgress?: (event: NativeSyntheticEvent<BurstProgress>) => void;
  onError?: (event: NativeSyntheticEvent<CameraError>) => void;
}

let NativeView: ReturnType<typeof requireNativeComponent<NativeViewProps>> | null = null;
function nativeView() {
  if (!NativeView) NativeView = requireNativeComponent<NativeViewProps>(NATIVE_VIEW_NAME);
  return NativeView;
}

export interface ClientCameraViewProps {
  active: boolean;
  gateConfig: string;
  style?: StyleProp<ViewStyle>;
  onFrameMeasure(measure: FrameMeasure): void;
  onBurstProgress(progress: BurstProgress): void;
  onError(error: CameraError): void;
}

export function ClientCameraView(props: ClientCameraViewProps): ReactNode {
  const backend = cameraBackend();
  if (backend.kind === 'native') {
    const View_ = nativeView();
    return (
      <View_
        active={props.active}
        gateConfig={props.gateConfig}
        style={props.style}
        onFrameMeasure={(event) => props.onFrameMeasure(event.nativeEvent)}
        onBurstProgress={(event) => props.onBurstProgress(event.nativeEvent)}
        onError={(event) => props.onError(toCameraError(event.nativeEvent))}
      />
    );
  }
  if (backend.kind === 'simulator') return <SimulatorView {...props} />;
  return <UnavailableView {...props} />;
}

function UnavailableView({ onError, style }: ClientCameraViewProps): ReactNode {
  useEffect(() => {
    onError({ code: 'camera_unavailable', message: 'native client camera is not in this build' });
  }, [onError]);
  return <View style={[styles.placeholder, style]} />;
}

/** Plays `syntheticMeasure` at ~10 Hz while active. Synthetic data only. */
function SimulatorView({ active, style, onFrameMeasure }: ClientCameraViewProps): ReactNode {
  const startedAt = useRef<number | null>(null);
  const frame = useRef(0);
  const callback = useRef(onFrameMeasure);
  callback.current = onFrameMeasure;

  useEffect(() => {
    if (!active) {
      startedAt.current = null;
      return undefined;
    }
    startedAt.current = Date.now();
    const timer = setInterval(() => {
      const t = Date.now() - (startedAt.current ?? Date.now());
      frame.current += 1;
      callback.current({ ...syntheticMeasure(t, frame.current), tsMs: Date.now() });
    }, 100);
    return () => clearInterval(timer);
  }, [active]);

  return (
    <View style={[styles.placeholder, style]}>
      <Text style={styles.simText}>{s('camera.simulator')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: { flex: 1, backgroundColor: '#1b2333', alignItems: 'center', justifyContent: 'flex-end' },
  simText: { color: '#ffffff', fontSize: 13, padding: 8, textAlign: 'center' },
});
