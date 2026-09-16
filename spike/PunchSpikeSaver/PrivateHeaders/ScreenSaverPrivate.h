// ABOUTME: Declares the undocumented ScreenSaver.framework classes a com.apple.screensaver extension subclasses.
// ABOUTME: Derived from AppexSaverMinimal by Guillaume Louel (MIT, see THIRD_PARTY_NOTICES.md).

#import <AppKit/AppKit.h>
#import <ScreenSaver/ScreenSaver.h>

NS_ASSUME_NONNULL_BEGIN

@interface ScreenSaverExtension : NSObject
- (instancetype)init;
@end

@interface ScreenSaverViewController : NSViewController
@end

NS_ASSUME_NONNULL_END
