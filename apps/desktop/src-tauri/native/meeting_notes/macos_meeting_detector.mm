#import <AppKit/AppKit.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreGraphics/CoreGraphics.h>

#include <algorithm>
#include <cstring>

namespace {
void CopyUtf8(NSString *value, char *destination, size_t length) {
  if (!destination || length == 0) return;
  destination[0] = '\0';
  if (!value) return;
  const char *source = value.UTF8String;
  if (!source) return;
  std::strncpy(destination, source, length - 1);
  destination[length - 1] = '\0';
}

bool DefaultMicrophoneIsRunning() {
  AudioDeviceID device = kAudioObjectUnknown;
  UInt32 deviceSize = sizeof(device);
  AudioObjectPropertyAddress defaultInput = {
      kAudioHardwarePropertyDefaultInputDevice,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain,
  };
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &defaultInput, 0,
                                 nullptr, &deviceSize, &device) != noErr ||
      device == kAudioObjectUnknown) {
    return false;
  }

  UInt32 running = 0;
  UInt32 runningSize = sizeof(running);
  AudioObjectPropertyAddress isRunning = {
      kAudioDevicePropertyDeviceIsRunningSomewhere,
      kAudioObjectPropertyScopeGlobal,
      kAudioObjectPropertyElementMain,
  };
  return AudioObjectGetPropertyData(device, &isRunning, 0, nullptr,
                                    &runningSize, &running) == noErr &&
         running != 0;
}

NSString *LargestFrontmostWindowTitle(pid_t processID, CGWindowID *windowID) {
  if (windowID) *windowID = kCGNullWindowID;
  CFArrayRef windows = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID);
  if (!windows) return nil;

  NSString *title = nil;
  double largestArea = 0.0;
  for (NSDictionary *window in (__bridge NSArray *)windows) {
    NSNumber *ownerPID = window[(id)kCGWindowOwnerPID];
    NSNumber *layer = window[(id)kCGWindowLayer];
    if (ownerPID.intValue != processID || layer.intValue != 0) continue;

    CGRect bounds = CGRectZero;
    NSDictionary *boundsDictionary = window[(id)kCGWindowBounds];
    if (!boundsDictionary || !CGRectMakeWithDictionaryRepresentation(
                                 (__bridge CFDictionaryRef)boundsDictionary,
                                 &bounds)) {
      continue;
    }
    const double area = bounds.size.width * bounds.size.height;
    NSString *candidate = window[(id)kCGWindowName];
    if (area > largestArea && candidate.length > 0) {
      largestArea = area;
      title = candidate;
      if (windowID) {
        *windowID =
            [window[(id)kCGWindowNumber] unsignedIntValue];
      }
    }
  }
  CFRelease(windows);
  return title;
}
}  // namespace

extern "C" int kuku_meeting_meeting_environment(
    char *bundleID, size_t bundleIDLength, char *appName,
    size_t appNameLength, char *windowTitle, size_t windowTitleLength,
    uint32_t *windowID) {
  @autoreleasepool {
    NSRunningApplication *application =
        NSWorkspace.sharedWorkspace.frontmostApplication;
    CGWindowID selectedWindowID = kCGNullWindowID;
    CopyUtf8(application.bundleIdentifier, bundleID, bundleIDLength);
    CopyUtf8(application.localizedName, appName, appNameLength);
    CopyUtf8(LargestFrontmostWindowTitle(application.processIdentifier,
                                         &selectedWindowID),
             windowTitle, windowTitleLength);
    if (windowID) *windowID = selectedWindowID;
    return DefaultMicrophoneIsRunning() ? 1 : 0;
  }
}
