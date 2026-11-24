//
//  FaceTypePreviewViewManager.swift
//  Registers `FaceTypePreviewView` as the `FaceTypePreviewView` RN native
//  component, so `ScanScreen` can mount the real ARKit camera preview
//  instead of the placeholder box it rendered before this file existed
//  (audit F1/F2). Mirrors the Android
//  `ai.facetype.capture.FaceTypePreviewViewManager`.
//
//  `RCTViewManager`'s own `+moduleName` strips a trailing "Manager" from the
//  class name, so this registers under exactly "FaceTypePreviewView" — the
//  same name `requireNativeComponent('FaceTypePreviewView')` asks for in
//  `NativeFaceTypePreview.tsx` — with no explicit override needed. See
//  `FaceTypePreviewViewManager.m` for the Objective-C runtime registration
//  React Native discovers this class through.
//
//  This manager only creates the view. It does not forward RN commands to
//  it: `FaceTypeCapture` talks to the currently mounted view indirectly
//  through `FaceTypePreviewRegistry`.
//

import React
import UIKit

@objc(FaceTypePreviewViewManager)
final class FaceTypePreviewViewManager: RCTViewManager {
  override func view() -> UIView! {
    FaceTypePreviewView()
  }

  override static func requiresMainQueueSetup() -> Bool { true }
}
