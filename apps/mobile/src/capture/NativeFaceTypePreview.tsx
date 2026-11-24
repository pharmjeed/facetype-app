/**
 * RN wrapper around the native `FaceTypePreviewView` — the real native
 * camera preview, present on both platforms:
 *
 * - Android: `ai.facetype.capture.FaceTypePreviewViewManager`, a
 *   GLSurfaceView that owns the ARCore Session and its render thread
 *   (design review D1/D2, message 2026-08-25T21-54-44Z_53356c299477).
 * - iOS: `FaceTypePreviewViewManager`, an ARSCNView that displays whatever
 *   ARSession `FaceTypeCapture` is currently running (`FaceTypeCapture`
 *   stays the sole session owner on iOS; only what the user can see moved).
 *
 * This component owns no state and calls no native module methods itself:
 * mounting it is what creates the native surface, and its
 * `onPreviewReady`/`onPreviewError` events are what tell `App.tsx` it is
 * safe to call `FaceTypeCapture.start()` (relayed through each platform's own
 * `FaceTypePreviewRegistry` on the native side).
 */

import { requireNativeComponent, type ViewProps } from 'react-native';

export interface NativeFaceTypePreviewProps extends ViewProps {
  onPreviewReady?: () => void;
  onPreviewError?: (event: { nativeEvent: { message: string } }) => void;
}

export const NativeFaceTypePreview =
  requireNativeComponent<NativeFaceTypePreviewProps>('FaceTypePreviewView');
