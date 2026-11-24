//
//  FaceTypePreviewViewManager.m
//  Objective-C bridge registration for the Swift view manager. Same reason
//  FaceTypeCapture.m exists: React Native discovers native modules and view
//  managers through the Objective-C runtime, so a @objc Swift class with no
//  RCT_EXTERN_MODULE is invisible to JavaScript.
//

#import <React/RCTViewManager.h>

@interface RCT_EXTERN_MODULE (FaceTypePreviewViewManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(onPreviewReady, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onPreviewError, RCTDirectEventBlock)

@end
