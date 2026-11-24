/**
 * The `NativeModules` lookup for the raw-frame bridge.
 *
 * Split from `rawFrame.ts` for the same reason `nativeQuality.ts` is split from
 * `providers.ts`: importing `react-native` makes a module unloadable by the
 * plain Node test runner, so everything that can be checked without a device
 * lives on the other side of this line and is checked there.
 *
 * The methods live on the same `FaceTypeCapture` module as the geometry
 * capture, because they are the same camera session: `captureRawFrame` exports
 * the current frame from the AR session that `start()` opened, and there is no
 * second session, second camera or second permission involved.
 */

import { NativeModules } from 'react-native';

import { createRawFrameChannel, type NativeRawFrameModule, type RawFrameChannel } from './rawFrame.ts';

/**
 * The channel for the running build, or `null` when this binary has no
 * raw-frame export (an older native module, or a platform without one).
 *
 * `null` is not a failure — a field session on such a device still collects
 * geometry and says on the receipt that no photograph was stored.
 */
export function nativeRawFrameChannel(): RawFrameChannel | null {
  const module = (NativeModules as Record<string, Partial<NativeRawFrameModule> | undefined>)
    .FaceTypeCapture;
  return createRawFrameChannel(module);
}
