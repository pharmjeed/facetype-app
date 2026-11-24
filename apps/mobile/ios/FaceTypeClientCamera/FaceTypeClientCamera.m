//
//  FaceTypeClientCamera.m
//  Objective-C bridge registration for the Swift `FaceTypeClientCamera`
//  module (docs/client-native-interface.md §3).
//
//  React Native's old architecture discovers modules through the
//  Objective-C runtime, so the @objc Swift class needs this RCT_EXTERN_MODULE.
//  Every selector below must match the @objc(...) signature in
//  FaceTypeClientCamera.swift exactly, argument labels included;
//  tests/contract/test_ios_client_camera.py checks that they do.
//

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE (FaceTypeClientCamera, NSObject)

RCT_EXTERN_METHOD(getCapabilities : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(startBurst : (NSDictionary *)opts
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(cancelBurst : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(uploadFrame : (NSString *)frameId
                  target : (NSDictionary *)target
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(deleteFrames : (NSArray *)ids
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(listSpool : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getFrameMeta : (NSString *)frameId
                  resolver : (RCTPromiseResolveBlock)resolve
                  rejecter : (RCTPromiseRejectBlock)reject)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

@end
