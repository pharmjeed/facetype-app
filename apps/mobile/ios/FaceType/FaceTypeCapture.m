//
//  FaceTypeCapture.m
//  Objective-C bridge registration for the Swift capture module.
//
//  Swift alone is not enough: React Native discovers native modules through the
//  Objective-C runtime, so a @objc Swift class with no RCT_EXTERN_MODULE is
//  invisible to JavaScript. The Swift file existed with no counterpart, which
//  is why the module could never have been called (audit P0-03).
//
//  Every selector below must match the @objc(...) signature in
//  FaceTypeCapture.swift exactly, argument labels included.
//

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE (FaceTypeCapture, NSObject)

RCT_EXTERN_METHOD(isAvailable : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(start : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(captureGeometry : (NSString *)poseLabel
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stop : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

//  Field-study raw frames. Reached only by the calibration lane, and only for a
//  participant who opted in to photographs being kept
//  (apps/mobile/docs/field-study.md).

RCT_EXTERN_METHOD(captureRawFrame : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(readRawFrame : (NSString *)token
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(discardRawFrame : (NSString *)token
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(discardAllRawFrames : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

+ (BOOL)requiresMainQueueSetup
{
  return YES;
}

@end
