//
//  ReactShim.swift
//  FaceType — the camera files were moved from the React Native app (apps/mobile/ios/FaceTypeClientCamera)
//  with their logic unchanged. These four declarations keep the callback shapes they were written against;
//  nothing here depends on React Native. `CameraService` adapts them to async Swift.
//

import Foundation

typealias RCTPromiseResolveBlock = (Any?) -> Void
typealias RCTPromiseRejectBlock = (String?, String?, Error?) -> Void
typealias RCTDirectEventBlock = ([AnyHashable: Any]?) -> Void

protocol RCTInvalidating {
  func invalidate()
}
