//
//  FaceTypeClientCameraViewManager.swift
//  Registers `FaceTypeClientCameraView` with React Native (old architecture).
//
//  `RCTViewManager.moduleName` strips the trailing "Manager", so this class
//  registers exactly the `FaceTypeClientCameraView` component name the
//  contract (docs/client-native-interface.md §2) and `requireNativeComponent`
//  use. The Objective-C half, `FaceTypeClientCameraViewManager.m`, exports
//  the props and events.
//

import React
import UIKit

@objc(FaceTypeClientCameraViewManager)
final class FaceTypeClientCameraViewManager: RCTViewManager {
  override func view() -> UIView! {
    FaceTypeClientCameraView()
  }

  override static func requiresMainQueueSetup() -> Bool { true }
}
