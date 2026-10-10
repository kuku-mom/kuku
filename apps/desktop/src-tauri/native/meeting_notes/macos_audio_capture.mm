#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreMedia/CoreMedia.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <limits>
#include <vector>

extern "C" {
typedef void (*KukuAudioCallback)(const float *samples,
                                    size_t sample_count,
                                    double sample_rate,
                                    double presentation_seconds,
                                    int source);
typedef void (*KukuCaptureStateCallback)(int state, const char *message);
}

namespace {
std::atomic<KukuAudioCallback> gAudioCallback{nullptr};
std::atomic<KukuCaptureStateCallback> gStateCallback{nullptr};
std::atomic<uint64_t> gCaptureRequestGeneration{0};
std::atomic<uint32_t> gAcceptedDiagnosticBuffers{0};
std::atomic<uint32_t> gRejectedDiagnosticBuffers{0};

int MicrophoneAuthorizationCode(AVAuthorizationStatus status) {
  switch (status) {
    case AVAuthorizationStatusAuthorized:
      return 1;
    case AVAuthorizationStatusDenied:
      return 2;
    case AVAuthorizationStatusRestricted:
      return 3;
    case AVAuthorizationStatusNotDetermined:
    default:
      return 0;
  }
}

bool DiagnosticsEnabled() {
  const char *value = std::getenv("KUKU_MEETING_ASR_DIAGNOSTICS");
  return value && std::strcmp(value, "1") == 0;
}

void EmitState(int state, NSString *message) {
  KukuCaptureStateCallback callback =
      gStateCallback.load(std::memory_order_acquire);
  if (!callback) return;
  callback(state, message ? message.UTF8String : "");
}

bool CheckedSampleOffset(size_t frame, size_t frameStride,
                         size_t channelOffset, size_t sampleBytes,
                         size_t dataSize, size_t *offset) {
  if (!offset || frameStride == 0 || sampleBytes == 0 ||
      channelOffset > dataSize ||
      frame > (std::numeric_limits<size_t>::max() - channelOffset) /
                  frameStride) {
    return false;
  }
  const size_t candidate = frame * frameStride + channelOffset;
  if (candidate > dataSize || sampleBytes > dataSize - candidate) return false;
  *offset = candidate;
  return true;
}

bool ReadUnsignedSample(const uint8_t *data, size_t byteCount,
                        bool bigEndian, uint64_t *value) {
  if (!data || !value || byteCount == 0 || byteCount > sizeof(uint64_t)) {
    return false;
  }
  uint64_t decoded = 0;
  if (bigEndian) {
    for (size_t index = 0; index < byteCount; ++index) {
      decoded = (decoded << 8) | data[index];
    }
  } else {
    for (size_t index = byteCount; index > 0; --index) {
      decoded = (decoded << 8) | data[index - 1];
    }
  }
  *value = decoded;
  return true;
}

// ScreenCaptureKit converts system audio to the requested stream format, but
// microphone output retains the selected device's native LPCM representation.
// Decode from the ASBD instead of assuming aligned host-endian float samples.
bool ReadLPCMSample(const uint8_t *data, size_t dataSize, size_t frame,
                    size_t frameStride, size_t channelOffset,
                    size_t sampleSlotBytes,
                    const AudioStreamBasicDescription &asbd, float *sample) {
  if (!sample || asbd.mFormatID != kAudioFormatLinearPCM) return false;
  size_t offset = 0;
  if (!CheckedSampleOffset(frame, frameStride, channelOffset,
                           sampleSlotBytes, dataSize, &offset)) {
    return false;
  }

  const bool isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
  const bool isSigned =
      (asbd.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0;
  const bool isBigEndian =
      (asbd.mFormatFlags & kAudioFormatFlagIsBigEndian) != 0;
  const uint32_t bits = asbd.mBitsPerChannel;
  const uint8_t *slot = data + offset;

  if (isFloat) {
    if ((bits != 32 && bits != 64) || sampleSlotBytes != bits / 8) {
      return false;
    }
    uint64_t raw = 0;
    if (!ReadUnsignedSample(slot, sampleSlotBytes, isBigEndian, &raw)) {
      return false;
    }
    double decoded = 0.0;
    if (bits == 32) {
      const uint32_t raw32 = static_cast<uint32_t>(raw);
      float value = 0.0f;
      std::memcpy(&value, &raw32, sizeof(value));
      decoded = value;
    } else {
      std::memcpy(&decoded, &raw, sizeof(decoded));
    }
    const float value = static_cast<float>(decoded);
    if (!std::isfinite(decoded) || !std::isfinite(value)) return false;
    *sample = value;
    return true;
  }

  if (!isSigned || (bits != 16 && bits != 24 && bits != 32) ||
      sampleSlotBytes < (bits + 7) / 8 ||
      sampleSlotBytes > sizeof(uint64_t)) {
    return false;
  }
  uint64_t raw = 0;
  if (!ReadUnsignedSample(slot, sampleSlotBytes, isBigEndian, &raw)) {
    return false;
  }
  const size_t storageBits = sampleSlotBytes * 8;
  if ((asbd.mFormatFlags & kAudioFormatFlagIsAlignedHigh) != 0 &&
      storageBits > bits) {
    raw >>= storageBits - bits;
  }
  const uint64_t valueMask = (uint64_t{1} << bits) - 1;
  raw &= valueMask;
  const uint64_t signBit = uint64_t{1} << (bits - 1);
  const int64_t signedValue = (raw & signBit) != 0
                                  ? static_cast<int64_t>(raw) -
                                        static_cast<int64_t>(uint64_t{1} << bits)
                                  : static_cast<int64_t>(raw);
  *sample = static_cast<float>(
      static_cast<double>(signedValue) / static_cast<double>(signBit));
  return true;
}

bool ConvertLPCMToMono(const AudioBufferList *bufferList, size_t frames,
                       const AudioStreamBasicDescription &asbd,
                       std::vector<float> *mono) {
  if (!bufferList || !mono || frames == 0 ||
      asbd.mFormatID != kAudioFormatLinearPCM ||
      asbd.mChannelsPerFrame == 0 || asbd.mBytesPerFrame == 0) {
    return false;
  }
  mono->assign(frames, 0.0f);
  const size_t channels = asbd.mChannelsPerFrame;
  const bool nonInterleaved =
      (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0;

  if (nonInterleaved) {
    if (bufferList->mNumberBuffers < channels) return false;
    const size_t availableChannels = channels;
    for (size_t frame = 0; frame < frames; ++frame) {
      double sum = 0.0;
      size_t decodedChannels = 0;
      for (size_t channel = 0; channel < availableChannels; ++channel) {
        const AudioBuffer &buffer = bufferList->mBuffers[channel];
        if (!buffer.mData || buffer.mNumberChannels == 0) continue;
        float value = 0.0f;
        if (ReadLPCMSample(static_cast<const uint8_t *>(buffer.mData),
                           buffer.mDataByteSize, frame, asbd.mBytesPerFrame,
                           0, asbd.mBytesPerFrame, asbd, &value)) {
          sum += value;
          decodedChannels += 1;
        }
      }
      if (decodedChannels != availableChannels) return false;
      (*mono)[frame] =
          static_cast<float>(sum / static_cast<double>(decodedChannels));
    }
    return true;
  }

  if (bufferList->mNumberBuffers == 0) return false;
  const AudioBuffer &buffer = bufferList->mBuffers[0];
  if (!buffer.mData || buffer.mNumberChannels < channels ||
      asbd.mBytesPerFrame % channels != 0) {
    return false;
  }
  const size_t availableChannels = channels;
  const size_t sampleSlotBytes = asbd.mBytesPerFrame / channels;
  for (size_t frame = 0; frame < frames; ++frame) {
    double sum = 0.0;
    size_t decodedChannels = 0;
    for (size_t channel = 0; channel < availableChannels; ++channel) {
      float value = 0.0f;
      if (ReadLPCMSample(static_cast<const uint8_t *>(buffer.mData),
                         buffer.mDataByteSize, frame, asbd.mBytesPerFrame,
                         channel * sampleSlotBytes, sampleSlotBytes, asbd,
                         &value)) {
        sum += value;
        decodedChannels += 1;
      }
    }
    if (decodedChannels != availableChannels) return false;
    (*mono)[frame] =
        static_cast<float>(sum / static_cast<double>(decodedChannels));
  }
  return true;
}

bool HasDefaultInputChannels() {
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

  AudioObjectPropertyAddress streamConfiguration = {
      kAudioDevicePropertyStreamConfiguration,
      kAudioDevicePropertyScopeInput,
      kAudioObjectPropertyElementMain,
  };
  UInt32 listSize = 0;
  if (AudioObjectGetPropertyDataSize(device, &streamConfiguration, 0, nullptr,
                                     &listSize) != noErr ||
      listSize < sizeof(AudioBufferList)) {
    return false;
  }
  std::vector<uint8_t> storage(listSize);
  AudioBufferList *list = reinterpret_cast<AudioBufferList *>(storage.data());
  if (AudioObjectGetPropertyData(device, &streamConfiguration, 0, nullptr,
                                 &listSize, list) != noErr) {
    return false;
  }
  UInt32 channels = 0;
  for (UInt32 index = 0; index < list->mNumberBuffers; ++index) {
    channels += list->mBuffers[index].mNumberChannels;
  }
  return channels > 0;
}

CGFloat CaptureOverlapArea(CGRect windowFrame, CGRect displayFrame) {
  const CGRect intersection = CGRectIntersection(windowFrame, displayFrame);
  if (CGRectIsNull(intersection) || CGRectIsEmpty(intersection)) return 0.0;
  return intersection.size.width * intersection.size.height;
}

size_t CaptureDisplayIndexForWindow(
    CGRect windowFrame, const std::vector<CGRect> &displayFrames) {
  size_t selected = std::numeric_limits<size_t>::max();
  CGFloat largestOverlap = 0.0;
  for (size_t index = 0; index < displayFrames.size(); ++index) {
    const CGFloat overlap =
        CaptureOverlapArea(windowFrame, displayFrames[index]);
    if (overlap > largestOverlap) {
      largestOverlap = overlap;
      selected = index;
    }
  }
  return selected;
}

bool CaptureWindowMatchesTarget(CGWindowID actualWindowID,
                                NSString *actualBundleID,
                                CGWindowID requestedWindowID,
                                NSString *requestedBundleID) {
  return requestedWindowID != kCGNullWindowID &&
         actualWindowID == requestedWindowID &&
         requestedBundleID.length > 0 &&
         [actualBundleID isEqualToString:requestedBundleID];
}
}  // namespace

extern "C" int kuku_meeting_microphone_authorization_status() {
  return MicrophoneAuthorizationCode(
      [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]);
}

extern "C" void kuku_meeting_microphone_request_permission(void (*callback)(int)) {
  // Tauri commands run away from AppKit's main queue. Dispatch the initial
  // AVFoundation authorization request to the main queue so macOS can attach
  // the consent sheet to the signed application reliably.
  dispatch_async(dispatch_get_main_queue(), ^{
    AVAuthorizationStatus status =
        [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    if (status != AVAuthorizationStatusNotDetermined) {
      if (callback) callback(MicrophoneAuthorizationCode(status));
      return;
    }

    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                             completionHandler:^(BOOL granted) {
      (void)granted;
      AVAuthorizationStatus resolved =
          [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
      if (callback) callback(MicrophoneAuthorizationCode(resolved));
    }];
  });
}

API_AVAILABLE(macos(15.0))
@interface KukuCapture : NSObject <SCStreamDelegate, SCStreamOutput>
@property(atomic, strong) SCStream *stream;
@property(nonatomic, strong) AVAudioEngine *microphoneEngine;
@property(nonatomic, strong) dispatch_queue_t systemQueue;
@property(nonatomic, strong) dispatch_queue_t microphoneQueue;
@property(nonatomic, assign) BOOL microphoneOnly;
@property(nonatomic, assign) BOOL systemOnly;
@property(atomic, assign) uint64_t captureGeneration;
@property(atomic, assign) uint64_t streamGeneration;
- (BOOL)startMicrophoneEngine:(BOOL)emitReady generation:(uint64_t)generation;
- (void)startMicrophoneOnlyForGeneration:(uint64_t)generation;
- (void)stopMicrophoneEngine;
- (void)startSystemCaptureForBundleID:(NSString *)captureBundleID
                            windowID:(CGWindowID)captureWindowID
                           generation:(uint64_t)generation;
- (void)stopForGeneration:(uint64_t)generation;
@end

@implementation KukuCapture

- (instancetype)init {
  self = [super init];
  if (self) {
    _systemQueue = dispatch_queue_create("mom.kuku.meeting.capture.system", DISPATCH_QUEUE_SERIAL);
    _microphoneQueue = dispatch_queue_create("mom.kuku.meeting.capture.microphone", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (void)startMode:(int)captureMode
    captureBundleID:(NSString *)captureBundleID
    captureWindowID:(CGWindowID)captureWindowID
          generation:(uint64_t)generation {
  const BOOL microphoneOnly = captureMode == 1;
  const BOOL systemOnly = captureMode == 2;
  if (generation > self.captureGeneration) {
    [self stopMicrophoneEngine];
    SCStream *previousStream = self.stream;
    self.stream = nil;
    self.streamGeneration = 0;
    if (previousStream) {
      [previousStream stopCaptureWithCompletionHandler:^(NSError *error) {
        (void)error;
      }];
    }
  }
  self.captureGeneration = generation;
  self.microphoneOnly = microphoneOnly;
  self.systemOnly = systemOnly;
  EmitState(1, @"오디오 권한을 확인하고 있습니다");

  if (microphoneOnly) {
    [self startMicrophoneOnlyForGeneration:generation];
    return;
  }

  if (systemOnly) {
    [self startSystemCaptureForBundleID:captureBundleID
                               windowID:captureWindowID
                             generation:generation];
    return;
  }

  // ScreenCaptureKit does not itself present the AVFoundation microphone
  // consent prompt. Without an explicit request the system-audio stream can
  // start successfully while microphone buffers are silently omitted.
  AVAuthorizationStatus microphoneAuthorization =
      [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
  if (microphoneAuthorization == AVAuthorizationStatusNotDetermined) {
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                             completionHandler:^(BOOL granted) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (generation != self.captureGeneration ||
            generation != gCaptureRequestGeneration.load()) {
          return;
        }
        if (!granted) {
          EmitState(-2, @"마이크 권한이 필요합니다. 시스템 설정에서 Kuku의 마이크 접근을 허용한 뒤 다시 시도해 주세요.");
          return;
        }
        [self startMode:0
            captureBundleID:captureBundleID
            captureWindowID:captureWindowID
                  generation:generation];
      });
    }];
    return;
  }
  if (microphoneAuthorization != AVAuthorizationStatusAuthorized) {
    EmitState(-2, @"마이크 권한이 꺼져 있습니다. 시스템 설정에서 Kuku의 마이크 접근을 허용한 뒤 다시 시도해 주세요.");
    return;
  }
  // In combined mode ScreenCaptureKit owns both audio sources. Its microphone
  // output shares the stream's media clock with system audio, avoiding the
  // long-recording drift that can arise when AVAudioEngine host time is mixed
  // with ScreenCaptureKit presentation timestamps. Keep the explicit device
  // check here so a missing input still fails before screen capture starts.
  if (!HasDefaultInputChannels() ||
      ![AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio]) {
    EmitState(-4, @"연결된 마이크 입력 장치를 찾지 못했습니다. 마이크를 연결하거나 시스템 오디오만 시작해 주세요.");
    return;
  }

  [self startSystemCaptureForBundleID:captureBundleID
                             windowID:captureWindowID
                           generation:generation];
}

- (void)startSystemCaptureForBundleID:(NSString *)requestedBundleID
                            windowID:(CGWindowID)requestedWindowID
                           generation:(uint64_t)generation {
  const BOOL microphoneOnly = self.microphoneOnly;
  const BOOL systemOnly = self.systemOnly;
  NSString *captureBundleID = [requestedBundleID copy];
  const CGWindowID captureWindowID = requestedWindowID;

  [SCShareableContent
      getShareableContentExcludingDesktopWindows:NO
                          onScreenWindowsOnly:YES
                           completionHandler:^(SCShareableContent *content, NSError *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
    if (generation != self.captureGeneration ||
        generation != gCaptureRequestGeneration.load()) {
      return;
    }
    if (error || content.displays.count == 0) {
      NSString *message = error.localizedDescription ?: @"캡처할 디스플레이를 찾을 수 없습니다";
      [self stopMicrophoneEngine];
      EmitState(-1, message);
      return;
    }

    SCDisplay *display = content.displays.firstObject;
    NSMutableArray<SCRunningApplication *> *excluded = [NSMutableArray array];
    NSMutableArray<SCRunningApplication *> *included = [NSMutableArray array];
    NSString *bundleID = NSBundle.mainBundle.bundleIdentifier;
    NSString *captureOnlyBundleID = captureBundleID;
    if (captureOnlyBundleID.length == 0) {
      captureOnlyBundleID =
          NSProcessInfo.processInfo.environment[@"KUKU_MEETING_CAPTURE_ONLY_BUNDLE_ID"];
    }
    for (SCRunningApplication *application in content.applications) {
      if (bundleID && [application.bundleIdentifier isEqualToString:bundleID]) {
        [excluded addObject:application];
      }
      if (captureOnlyBundleID.length > 0 &&
          [application.bundleIdentifier isEqualToString:captureOnlyBundleID]) {
        [included addObject:application];
      }
    }

    // A display filter only receives audio associated with content on that
    // display. On multi-monitor setups `firstObject` is not guaranteed to be
    // the display hosting the requested app, which yields timestamped silence.
    // Select the display with the largest overlap with an on-screen target-app
    // window. Fall back to the macOS main display for ordinary system capture.
    SCDisplay *mainDisplay = nil;
    const CGDirectDisplayID mainDisplayID = CGMainDisplayID();
    for (SCDisplay *candidate in content.displays) {
      if (candidate.displayID == mainDisplayID) {
        mainDisplay = candidate;
        break;
      }
    }
    if (mainDisplay) display = mainDisplay;
    if (captureWindowID != kCGNullWindowID) {
      SCWindow *targetWindow = nil;
      BOOL windowIDFound = NO;
      for (SCWindow *window in content.windows) {
        if (window.windowID != captureWindowID) continue;
        windowIDFound = YES;
        if (CaptureWindowMatchesTarget(
                window.windowID, window.owningApplication.bundleIdentifier,
                captureWindowID, captureOnlyBundleID)) {
          targetWindow = window;
        }
        break;
      }
      if (!targetWindow) {
        NSString *message = windowIDFound
            ? @"감지한 회의 창의 소유 앱이 바뀌었습니다. 회의 창을 앞에 둔 뒤 다시 시도해 주세요."
            : @"감지한 회의 창을 더 이상 찾을 수 없습니다. 회의 창을 앞에 둔 뒤 다시 시도해 주세요.";
        EmitState(-1, message);
        return;
      }
      std::vector<CGRect> displayFrames;
      displayFrames.reserve(content.displays.count);
      for (SCDisplay *candidate in content.displays) {
        displayFrames.push_back(candidate.frame);
      }
      const size_t displayIndex =
          CaptureDisplayIndexForWindow(targetWindow.frame, displayFrames);
      if (displayIndex == std::numeric_limits<size_t>::max()) {
        EmitState(-1, @"감지한 회의 창이 캡처 가능한 디스플레이에 없습니다. 창을 화면에 표시한 뒤 다시 시도해 주세요.");
        return;
      }
      display = content.displays[displayIndex];
    } else if (captureOnlyBundleID.length > 0) {
      CGFloat largestOverlap = 0.0;
      for (SCWindow *window in content.windows) {
        if (![window.owningApplication.bundleIdentifier
                isEqualToString:captureOnlyBundleID]) {
          continue;
        }
        for (SCDisplay *candidate in content.displays) {
          const CGFloat overlap =
              CaptureOverlapArea(window.frame, candidate.frame);
          if (overlap > largestOverlap) {
            largestOverlap = overlap;
            display = candidate;
          }
        }
      }
    }
    if (DiagnosticsEnabled()) {
      NSLog(@"[meeting-capture-display] id=%u frame=%@ target=%@ window=%u",
            display.displayID, NSStringFromRect(display.frame),
            captureOnlyBundleID ?: @"system", captureWindowID);
    }

    if (captureOnlyBundleID.length > 0 && included.count == 0) {
      [self stopMicrophoneEngine];
      EmitState(-1, [NSString stringWithFormat:@"캡처할 앱을 찾지 못했습니다: %@",
                                               captureOnlyBundleID]);
      return;
    }

    // Use the requested app to select the correct display, but do not restrict
    // audio to its SCRunningApplication object. Chromium routes playback
    // through helper processes which are otherwise omitted and captured as
    // silence. Excluding Kuku still prevents transcription feedback.
    SCContentFilter *filter = [[SCContentFilter alloc]
        initWithDisplay:display
        excludingApplications:excluded
        exceptingWindows:@[]];
    SCStreamConfiguration *configuration = [[SCStreamConfiguration alloc] init];
    configuration.width = 2;
    configuration.height = 2;
    configuration.minimumFrameInterval = CMTimeMake(1, 2);
    configuration.queueDepth = 3;
    // ScreenCaptureKit's system-audio path is native 48 kHz stereo. Asking it
    // to perform the 16 kHz mono conversion can produce valid, timestamped
    // buffers filled with silence on some macOS/Chrome combinations. Keep the
    // capture format native and let the Rust mixer do the controlled resample.
    configuration.sampleRate = 48000;
    configuration.channelCount = 2;
    configuration.capturesAudio = !microphoneOnly;
    configuration.excludesCurrentProcessAudio = YES;
    AVCaptureDevice *microphoneDevice = nil;
    if (!systemOnly) {
      microphoneDevice =
          [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio];
      if (!microphoneDevice || !HasDefaultInputChannels()) {
        EmitState(-4, @"연결된 마이크 입력 장치를 찾지 못했습니다. 마이크를 연결하거나 시스템 오디오만 시작해 주세요.");
        self.stream = nil;
        self.streamGeneration = 0;
        return;
      }
      configuration.captureMicrophone = YES;
      configuration.microphoneCaptureDeviceID = microphoneDevice.uniqueID;
    }

    self.stream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:self];
    self.streamGeneration = generation;
    NSError *systemOutputError = nil;
    if (!microphoneOnly) {
      [self.stream addStreamOutput:self
                              type:SCStreamOutputTypeAudio
                sampleHandlerQueue:self.systemQueue
                             error:&systemOutputError];
    }
    NSError *microphoneOutputError = nil;
    if (!systemOnly) {
      [self.stream addStreamOutput:self
                              type:SCStreamOutputTypeMicrophone
                sampleHandlerQueue:self.microphoneQueue
                             error:&microphoneOutputError];
    }
    NSError *outputError = systemOutputError ?: microphoneOutputError;
    if (outputError) {
      [self stopMicrophoneEngine];
      EmitState(-1, outputError.localizedDescription);
      self.stream = nil;
      self.streamGeneration = 0;
      return;
    }

    [self.stream startCaptureWithCompletionHandler:^(NSError *startError) {
      if (generation !=
              gCaptureRequestGeneration.load(std::memory_order_acquire) ||
          generation != self.captureGeneration) {
        return;
      }
      if (startError) {
        [self stopMicrophoneEngine];
        EmitState(-1, startError.localizedDescription);
        self.stream = nil;
        self.streamGeneration = 0;
      } else {
        EmitState(2, systemOnly ? @"시스템 오디오 전사를 시작했습니다" : @"시스템 오디오와 마이크 전사를 시작했습니다");
      }
    }];
    });
  }];
}

- (void)startMicrophoneOnlyForGeneration:(uint64_t)generation {
  [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                           completionHandler:^(BOOL granted) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (generation != self.captureGeneration ||
          generation != gCaptureRequestGeneration.load()) {
        return;
      }
      if (!granted) {
        EmitState(-2, @"마이크 권한이 필요합니다. 시스템 설정의 개인정보 보호 및 보안에서 Kuku를 허용해 주세요.");
        return;
      }

      [self startMicrophoneEngine:YES generation:generation];
    });
  }];
}

- (BOOL)startMicrophoneEngine:(BOOL)emitReady generation:(uint64_t)generation {
  if (self.microphoneEngine) return YES;
  if (!HasDefaultInputChannels()) {
    EmitState(-4, @"연결된 마이크 입력 장치를 찾지 못했습니다. 마이크를 연결하거나 시스템 오디오만 시작해 주세요.");
    return NO;
  }
  AVCaptureDevice *device = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio];
  if (!device) {
    EmitState(-4, @"연결된 마이크 입력 장치를 찾지 못했습니다. 마이크를 연결하거나 시스템 오디오만 시작해 주세요.");
    return NO;
  }
  AVAudioEngine *engine = [[AVAudioEngine alloc] init];
  AVAudioInputNode *input = engine.inputNode;
  AVAudioFormat *format = [input outputFormatForBus:0];
  if (!input || !format || format.sampleRate <= 0) {
    EmitState(-1, @"사용할 수 있는 마이크 입력을 찾지 못했습니다");
    return NO;
  }

  [input installTapOnBus:0
              bufferSize:3200
                  format:nil
                   block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
    if (buffer.frameLength == 0 ||
        generation !=
            gCaptureRequestGeneration.load(std::memory_order_acquire) ||
        generation != self.captureGeneration) {
      return;
    }
    AVAudioFormat *bufferFormat = buffer.format;
    const AVAudioFrameCount frames = buffer.frameLength;
    const AVAudioChannelCount channels =
        std::max<AVAudioChannelCount>(1, bufferFormat.channelCount);
    std::vector<float> mono(frames, 0.0f);
    float *const *channelData = buffer.floatChannelData;
    if (!channelData) return;
    for (AVAudioChannelCount channel = 0; channel < channels; ++channel) {
      const float *samples = channelData[channel];
      if (!samples) continue;
      for (AVAudioFrameCount frame = 0; frame < frames; ++frame) {
        mono[frame] += samples[frame] / static_cast<float>(channels);
      }
    }
    double seconds = 0.0;
    if (when.isHostTimeValid) {
      seconds = [AVAudioTime secondsForHostTime:when.hostTime];
    } else if (when.isSampleTimeValid && bufferFormat.sampleRate > 0) {
      seconds = static_cast<double>(when.sampleTime) / bufferFormat.sampleRate;
    }
    if (generation !=
            gCaptureRequestGeneration.load(std::memory_order_acquire) ||
        generation != self.captureGeneration) {
      return;
    }
    KukuAudioCallback callback =
        gAudioCallback.load(std::memory_order_acquire);
    if (callback) {
      callback(mono.data(), mono.size(), bufferFormat.sampleRate, seconds, 1);
    }
  }];

  NSError *error = nil;
  [engine prepare];
  if (![engine startAndReturnError:&error]) {
    [input removeTapOnBus:0];
    EmitState(-1, error.localizedDescription ?: @"마이크를 시작할 수 없습니다");
    return NO;
  }
  self.microphoneEngine = engine;
  if (emitReady) EmitState(2, @"마이크 전사를 시작했습니다");
  return YES;
}

- (void)stopMicrophoneEngine {
  AVAudioEngine *engine = self.microphoneEngine;
  self.microphoneEngine = nil;
  if (!engine) return;
  [engine.inputNode removeTapOnBus:0];
  [engine stop];
}

- (void)stopForGeneration:(uint64_t)generation {
  if (generation < self.captureGeneration) return;
  self.captureGeneration = generation;
  BOOL stoppedMicrophone = self.microphoneEngine != nil;
  [self stopMicrophoneEngine];
  SCStream *stream = self.stream;
  self.stream = nil;
  self.streamGeneration = 0;
  if (!stream) {
    if (generation == gCaptureRequestGeneration.load()) {
      EmitState(0, stoppedMicrophone ? @"마이크 캡처가 중지되었습니다" : @"오디오 캡처가 중지되었습니다");
    }
    return;
  }
  [stream stopCaptureWithCompletionHandler:^(NSError *error) {
    if (generation ==
            gCaptureRequestGeneration.load(std::memory_order_acquire) &&
        generation == self.captureGeneration) {
      EmitState(error ? -1 : 0, error ? error.localizedDescription : @"오디오 캡처가 중지되었습니다");
    }
  }];
}

- (void)stream:(SCStream *)stream
    didStopWithError:(NSError *)error {
  const uint64_t generation =
      gCaptureRequestGeneration.load(std::memory_order_acquire);
  if (generation != self.captureGeneration || stream != self.stream ||
      self.streamGeneration != generation ||
      generation !=
          gCaptureRequestGeneration.load(std::memory_order_acquire)) {
    return;
  }
  EmitState(-1, error.localizedDescription);
}

- (void)stream:(SCStream *)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
                   ofType:(SCStreamOutputType)type {
  const uint64_t generation =
      gCaptureRequestGeneration.load(std::memory_order_acquire);
  if (generation != self.captureGeneration || stream != self.stream ||
      self.streamGeneration != generation ||
      generation !=
          gCaptureRequestGeneration.load(std::memory_order_acquire) ||
      !CMSampleBufferIsValid(sampleBuffer)) {
    return;
  }
  if (type != SCStreamOutputTypeAudio && type != SCStreamOutputTypeMicrophone) return;

  CMAudioFormatDescriptionRef description =
      (CMAudioFormatDescriptionRef)CMSampleBufferGetFormatDescription(sampleBuffer);
  if (!description) return;
  const AudioStreamBasicDescription *asbdPtr =
      CMAudioFormatDescriptionGetStreamBasicDescription(description);
  if (!asbdPtr || asbdPtr->mFormatID != kAudioFormatLinearPCM) return;
  const AudioStreamBasicDescription asbd = *asbdPtr;

  size_t listSize = 0;
  OSStatus sizeStatus = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sampleBuffer, &listSize, nullptr, 0, nullptr, nullptr, 0, nullptr);
  if (sizeStatus != noErr || listSize == 0) return;

  std::vector<uint8_t> listStorage(listSize);
  AudioBufferList *bufferList = reinterpret_cast<AudioBufferList *>(listStorage.data());
  CMBlockBufferRef blockBuffer = nullptr;
  OSStatus status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sampleBuffer, nullptr, bufferList, listSize, nullptr, nullptr,
      kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, &blockBuffer);
  if (status != noErr) {
    if (blockBuffer) CFRelease(blockBuffer);
    return;
  }

  const size_t frames = static_cast<size_t>(CMSampleBufferGetNumSamples(sampleBuffer));
  std::vector<float> mono;
  if (!ConvertLPCMToMono(bufferList, frames, asbd, &mono)) {
    if (DiagnosticsEnabled() &&
        gRejectedDiagnosticBuffers.fetch_add(1, std::memory_order_relaxed) <
            4) {
      NSLog(@"[meeting-audio-format] rejected LPCM rate=%.0f channels=%u bits=%u bytesPerFrame=%u flags=0x%x frames=%zu",
            asbd.mSampleRate, asbd.mChannelsPerFrame, asbd.mBitsPerChannel,
            asbd.mBytesPerFrame, asbd.mFormatFlags, frames);
    }
    if (blockBuffer) CFRelease(blockBuffer);
    return;
  }

  if (DiagnosticsEnabled() &&
      gAcceptedDiagnosticBuffers.fetch_add(1, std::memory_order_relaxed) < 4) {
    float peak = 0.0f;
    for (float value : mono) peak = std::max(peak, std::abs(value));
    NSLog(@"[meeting-audio-format] rate=%.0f channels=%u bits=%u bytesPerFrame=%u flags=0x%x frames=%zu peak=%.6f",
          asbd.mSampleRate, asbd.mChannelsPerFrame, asbd.mBitsPerChannel,
          asbd.mBytesPerFrame, asbd.mFormatFlags, frames, peak);
  }

  CMTime presentation = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
  const double seconds = CMTIME_IS_NUMERIC(presentation) ? CMTimeGetSeconds(presentation) : 0.0;
  if (generation !=
          gCaptureRequestGeneration.load(std::memory_order_acquire) ||
      generation != self.captureGeneration || stream != self.stream ||
      self.streamGeneration != generation) {
    if (blockBuffer) CFRelease(blockBuffer);
    return;
  }
  KukuAudioCallback callback =
      gAudioCallback.load(std::memory_order_acquire);
  if (callback) {
    callback(mono.data(), mono.size(), asbd.mSampleRate, seconds,
             type == SCStreamOutputTypeMicrophone ? 1 : 0);
  }
  if (blockBuffer) CFRelease(blockBuffer);
}

@end

namespace {
KukuCapture *gCapture API_AVAILABLE(macos(15.0)) = nil;
}

extern "C" int kuku_meeting_audio_capture_available(void) {
  if (@available(macOS 15.0, *)) return 1;
  return 0;
}

extern "C" void kuku_meeting_audio_capture_start(KukuAudioCallback audioCallback,
                                            KukuCaptureStateCallback stateCallback,
                                            int captureMode,
                                            const char *captureBundleID,
                                            uint32_t captureWindowID) {
  const uint64_t generation =
      gCaptureRequestGeneration.fetch_add(1, std::memory_order_acq_rel) + 1;
  gAudioCallback.store(audioCallback, std::memory_order_release);
  gStateCallback.store(stateCallback, std::memory_order_release);
  gAcceptedDiagnosticBuffers.store(0, std::memory_order_relaxed);
  gRejectedDiagnosticBuffers.store(0, std::memory_order_relaxed);
  NSString *targetBundleID = captureBundleID
                                 ? [NSString stringWithUTF8String:captureBundleID]
                                 : nil;
  dispatch_async(dispatch_get_main_queue(), ^{
    if (generation != gCaptureRequestGeneration.load()) return;
    if (@available(macOS 15.0, *)) {
      if (!gCapture) gCapture = [[KukuCapture alloc] init];
      if (DiagnosticsEnabled()) {
        NSLog(@"[meeting-capture] native start mode=%d target=%@ window=%u",
              captureMode, targetBundleID ?: @"system", captureWindowID);
      }
      [gCapture startMode:captureMode
          captureBundleID:targetBundleID
          captureWindowID:captureWindowID
                generation:generation];
    } else if (stateCallback) {
      stateCallback(-3, "Meeting notes requires macOS 15 or later");
    }
  });
}

extern "C" void kuku_meeting_audio_capture_stop(void) {
  const uint64_t generation =
      gCaptureRequestGeneration.fetch_add(1, std::memory_order_acq_rel) + 1;
  dispatch_async(dispatch_get_main_queue(), ^{
    if (@available(macOS 15.0, *)) {
      [gCapture stopForGeneration:generation];
    }
  });
}
