#include "macos_audio_capture.mm"

#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>
#include <vector>

namespace {

void ExpectNear(float actual, float expected) {
  assert(std::abs(actual - expected) < 0.0001f);
}

AudioStreamBasicDescription FloatFormat(UInt32 channels,
                                        bool nonInterleaved,
                                        UInt32 bits = 32,
                                        bool bigEndian = false) {
  const UInt32 slotBytes = bits / 8;
  AudioStreamBasicDescription format{};
  format.mSampleRate = 48000.0;
  format.mFormatID = kAudioFormatLinearPCM;
  format.mFormatFlags =
      kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked |
      (nonInterleaved ? kAudioFormatFlagIsNonInterleaved : 0) |
      (bigEndian ? kAudioFormatFlagIsBigEndian : 0);
  format.mBytesPerPacket = slotBytes * (nonInterleaved ? 1 : channels);
  format.mFramesPerPacket = 1;
  format.mBytesPerFrame = slotBytes * (nonInterleaved ? 1 : channels);
  format.mChannelsPerFrame = channels;
  format.mBitsPerChannel = bits;
  return format;
}

AudioStreamBasicDescription IntegerFormat(UInt32 channels, UInt32 bits,
                                          UInt32 slotBytes, bool bigEndian,
                                          bool alignedHigh) {
  AudioStreamBasicDescription format{};
  format.mSampleRate = 44100.0;
  format.mFormatID = kAudioFormatLinearPCM;
  format.mFormatFlags =
      kAudioFormatFlagIsSignedInteger |
      (slotBytes * 8 == bits ? kAudioFormatFlagIsPacked : 0) |
      (bigEndian ? kAudioFormatFlagIsBigEndian : 0) |
      (alignedHigh ? kAudioFormatFlagIsAlignedHigh : 0);
  format.mBytesPerPacket = slotBytes * channels;
  format.mFramesPerPacket = 1;
  format.mBytesPerFrame = slotBytes * channels;
  format.mChannelsPerFrame = channels;
  format.mBitsPerChannel = bits;
  return format;
}

void AppendUnsignedBytes(std::vector<uint8_t> *bytes, uint64_t value,
                         UInt32 byteCount, bool bigEndian) {
  assert(bytes);
  assert(byteCount > 0 && byteCount <= sizeof(value));
  for (UInt32 index = 0; index < byteCount; ++index) {
    const UInt32 byteIndex = bigEndian ? byteCount - index - 1 : index;
    bytes->push_back(
        static_cast<uint8_t>((value >> (byteIndex * 8)) & 0xff));
  }
}

void AppendFloatSample(std::vector<uint8_t> *bytes, double value, UInt32 bits,
                       bool bigEndian) {
  if (bits == 32) {
    const float sample = static_cast<float>(value);
    uint32_t encoded = 0;
    std::memcpy(&encoded, &sample, sizeof(sample));
    AppendUnsignedBytes(bytes, encoded, sizeof(encoded), bigEndian);
    return;
  }
  assert(bits == 64);
  uint64_t encoded = 0;
  std::memcpy(&encoded, &value, sizeof(value));
  AppendUnsignedBytes(bytes, encoded, sizeof(encoded), bigEndian);
}

void AppendSignedSample(std::vector<uint8_t> *bytes, int64_t value,
                        UInt32 bits, UInt32 slotBytes, bool bigEndian,
                        bool alignedHigh) {
  assert(bits > 1 && bits < 64);
  assert(slotBytes * 8 >= bits && slotBytes <= sizeof(uint64_t));
  const int64_t signBit = int64_t{1} << (bits - 1);
  assert(value >= -signBit && value < signBit);
  const uint64_t mask = (uint64_t{1} << bits) - 1;
  uint64_t encoded = static_cast<uint64_t>(value) & mask;
  if (alignedHigh) encoded <<= slotBytes * 8 - bits;
  AppendUnsignedBytes(bytes, encoded, slotBytes, bigEndian);
}

void ExpectBytes(const std::vector<uint8_t> &actual,
                 std::initializer_list<uint8_t> expected) {
  assert(actual == std::vector<uint8_t>(expected));
}

void TestByteExactBuilders() {
  std::vector<uint8_t> bytes;
  AppendFloatSample(&bytes, 1.0, 32, false);
  ExpectBytes(bytes, {0x00, 0x00, 0x80, 0x3f});
  bytes.clear();
  AppendFloatSample(&bytes, 1.0, 32, true);
  ExpectBytes(bytes, {0x3f, 0x80, 0x00, 0x00});
  bytes.clear();
  AppendFloatSample(&bytes, 0.5, 64, false);
  ExpectBytes(bytes, {0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xe0, 0x3f});
  bytes.clear();
  AppendFloatSample(&bytes, 0.5, 64, true);
  ExpectBytes(bytes, {0x3f, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00});

  bytes.clear();
  AppendSignedSample(&bytes, 0x123456, 24, 3, false, false);
  ExpectBytes(bytes, {0x56, 0x34, 0x12});
  bytes.clear();
  AppendSignedSample(&bytes, 0x123456, 24, 3, true, false);
  ExpectBytes(bytes, {0x12, 0x34, 0x56});
  bytes.clear();
  AppendSignedSample(&bytes, 0x123456, 24, 4, false, false);
  ExpectBytes(bytes, {0x56, 0x34, 0x12, 0x00});
  bytes.clear();
  AppendSignedSample(&bytes, 0x123456, 24, 4, true, false);
  ExpectBytes(bytes, {0x00, 0x12, 0x34, 0x56});
  bytes.clear();
  AppendSignedSample(&bytes, 0x123456, 24, 4, false, true);
  ExpectBytes(bytes, {0x00, 0x56, 0x34, 0x12});
  bytes.clear();
  AppendSignedSample(&bytes, 0x123456, 24, 4, true, true);
  ExpectBytes(bytes, {0x12, 0x34, 0x56, 0x00});
}

void ExpectMonoBytes(std::vector<uint8_t> *bytes, size_t frames,
                     const AudioStreamBasicDescription &format,
                     const std::vector<float> &expected) {
  assert(bytes);
  assert(frames == expected.size());
  assert(bytes->size() <= std::numeric_limits<UInt32>::max());
  AudioBufferList list{};
  list.mNumberBuffers = 1;
  list.mBuffers[0].mNumberChannels = format.mChannelsPerFrame;
  list.mBuffers[0].mDataByteSize = static_cast<UInt32>(bytes->size());
  list.mBuffers[0].mData = bytes->data();

  std::vector<float> mono;
  assert(ConvertLPCMToMono(&list, frames, format, &mono));
  assert(mono.size() == expected.size());
  for (size_t index = 0; index < expected.size(); ++index) {
    ExpectNear(mono[index], expected[index]);
  }
}

void TestInterleavedFloatStereo() {
  std::vector<uint8_t> samples;
  for (double value : {1.0, -1.0, 0.5, 0.25, -0.5, -0.25}) {
    AppendFloatSample(&samples, value, 32, false);
  }
  ExpectMonoBytes(&samples, 3, FloatFormat(2, false),
                  {0.0f, 0.375f, -0.375f});
}

void TestScreenCaptureKitNonInterleavedFloatStereo() {
  std::vector<uint8_t> left;
  std::vector<uint8_t> right;
  for (double value : {1.0, 0.5, -0.5}) {
    AppendFloatSample(&left, value, 32, false);
  }
  for (double value : {-1.0, 0.25, -0.25}) {
    AppendFloatSample(&right, value, 32, false);
  }
  struct {
    UInt32 count;
    AudioBuffer buffers[2];
  } storage{};
  storage.count = 2;
  storage.buffers[0] = {1, static_cast<UInt32>(left.size()), left.data()};
  storage.buffers[1] = {1, static_cast<UInt32>(right.size()), right.data()};

  std::vector<float> mono;
  assert(ConvertLPCMToMono(
      reinterpret_cast<const AudioBufferList *>(&storage), 3,
      FloatFormat(2, true), &mono));
  assert(mono.size() == 3);
  ExpectNear(mono[0], 0.0f);
  ExpectNear(mono[1], 0.375f);
  ExpectNear(mono[2], -0.375f);
}

void TestFloatWidthsAndEndianness() {
  for (UInt32 bits : {32u, 64u}) {
    for (bool bigEndian : {false, true}) {
      std::vector<uint8_t> samples;
      for (double value : {-1.0, 0.5, 0.25}) {
        AppendFloatSample(&samples, value, bits, bigEndian);
      }
      ExpectMonoBytes(&samples, 3, FloatFormat(1, false, bits, bigEndian),
                      {-1.0f, 0.5f, 0.25f});
    }
  }
}

void TestPackedIntegerWidthsAndEndianness() {
  for (UInt32 bits : {16u, 24u, 32u}) {
    const UInt32 slotBytes = (bits + 7) / 8;
    const int64_t signBit = int64_t{1} << (bits - 1);
    for (bool bigEndian : {false, true}) {
      std::vector<uint8_t> samples;
      AppendSignedSample(&samples, -signBit, bits, slotBytes, bigEndian,
                         false);
      AppendSignedSample(&samples, signBit / 2, bits, slotBytes, bigEndian,
                         false);
      AppendSignedSample(&samples, signBit - 1, bits, slotBytes, bigEndian,
                         false);
      ExpectMonoBytes(&samples, 3,
                      IntegerFormat(1, bits, slotBytes, bigEndian, false),
                      {-1.0f, 0.5f,
                       static_cast<float>(static_cast<double>(signBit - 1) /
                                          static_cast<double>(signBit))});
    }
  }
}

void TestPadded24BitAlignmentAndEndianness() {
  constexpr UInt32 bits = 24;
  constexpr UInt32 slotBytes = 4;
  constexpr int64_t signBit = int64_t{1} << (bits - 1);
  for (bool bigEndian : {false, true}) {
    for (bool alignedHigh : {false, true}) {
      std::vector<uint8_t> samples;
      AppendSignedSample(&samples, -signBit, bits, slotBytes, bigEndian,
                         alignedHigh);
      AppendSignedSample(&samples, signBit / 2, bits, slotBytes, bigEndian,
                         alignedHigh);
      AppendSignedSample(&samples, signBit - 1, bits, slotBytes, bigEndian,
                         alignedHigh);
      ExpectMonoBytes(&samples, 3,
                      IntegerFormat(1, bits, slotBytes, bigEndian, alignedHigh),
                      {-1.0f, 0.5f,
                       static_cast<float>(static_cast<double>(signBit - 1) /
                                          static_cast<double>(signBit))});
    }
  }
}

void TestInterleavedSignedIntegerStereo() {
  std::vector<uint8_t> samples;
  for (int64_t value : {-32768, 32767, 16384, 16384}) {
    AppendSignedSample(&samples, value, 16, 2, false, false);
  }
  ExpectMonoBytes(&samples, 2, IntegerFormat(2, 16, 2, false, false),
                  {-1.0f / 65536.0f, 0.5f});
}

void TestMalformedBuffersAreRejected() {
  std::vector<uint8_t> truncated;
  for (double value : {1.0, -1.0, 0.5}) {
    AppendFloatSample(&truncated, value, 32, false);
  }
  AudioBufferList truncatedList{};
  truncatedList.mNumberBuffers = 1;
  truncatedList.mBuffers[0].mNumberChannels = 2;
  truncatedList.mBuffers[0].mDataByteSize =
      static_cast<UInt32>(truncated.size());
  truncatedList.mBuffers[0].mData = truncated.data();
  std::vector<float> mono;
  assert(!ConvertLPCMToMono(&truncatedList, 2, FloatFormat(2, false),
                           &mono));

  std::vector<uint8_t> completeStereo;
  for (double value : {1.0, -1.0}) {
    AppendFloatSample(&completeStereo, value, 32, false);
  }
  AudioBufferList missingInterleavedChannel{};
  missingInterleavedChannel.mNumberBuffers = 1;
  missingInterleavedChannel.mBuffers[0].mNumberChannels = 1;
  missingInterleavedChannel.mBuffers[0].mDataByteSize =
      static_cast<UInt32>(completeStereo.size());
  missingInterleavedChannel.mBuffers[0].mData = completeStereo.data();
  assert(!ConvertLPCMToMono(&missingInterleavedChannel, 1,
                           FloatFormat(2, false), &mono));

  std::vector<uint8_t> singlePlanarChannel;
  AppendFloatSample(&singlePlanarChannel, 1.0, 32, false);
  AudioBufferList missingPlanarChannel{};
  missingPlanarChannel.mNumberBuffers = 1;
  missingPlanarChannel.mBuffers[0].mNumberChannels = 1;
  missingPlanarChannel.mBuffers[0].mDataByteSize =
      static_cast<UInt32>(singlePlanarChannel.size());
  missingPlanarChannel.mBuffers[0].mData = singlePlanarChannel.data();
  assert(!ConvertLPCMToMono(&missingPlanarChannel, 1,
                           FloatFormat(2, true), &mono));

  std::vector<uint8_t> invalid;
  AppendFloatSample(&invalid, std::numeric_limits<double>::quiet_NaN(), 32,
                    false);
  AppendFloatSample(&invalid, 0.5, 32, false);
  AudioBufferList invalidList{};
  invalidList.mNumberBuffers = 1;
  invalidList.mBuffers[0].mNumberChannels = 2;
  invalidList.mBuffers[0].mDataByteSize =
      static_cast<UInt32>(invalid.size());
  invalidList.mBuffers[0].mData = invalid.data();
  assert(!ConvertLPCMToMono(&invalidList, 1, FloatFormat(2, false), &mono));

  AudioStreamBasicDescription unsignedFormat =
      IntegerFormat(1, 16, 2, false, false);
  unsignedFormat.mFormatFlags &= ~kAudioFormatFlagIsSignedInteger;
  assert(!ConvertLPCMToMono(&invalidList, 1, unsignedFormat, &mono));
  AudioStreamBasicDescription unsupportedInteger =
      IntegerFormat(1, 8, 1, false, false);
  assert(!ConvertLPCMToMono(&invalidList, 1, unsupportedInteger, &mono));
  assert(!ConvertLPCMToMono(nullptr, 1, FloatFormat(1, false), &mono));
  assert(!ConvertLPCMToMono(&invalidList, 0, FloatFormat(1, false), &mono));
  assert(!ConvertLPCMToMono(&invalidList, 1, FloatFormat(1, false), nullptr));
}

void TestSampleBounds() {
  size_t offset = 0;
  assert(CheckedSampleOffset(3, 8, 4, 4, 32, &offset));
  assert(offset == 28);
  assert(!CheckedSampleOffset(0, 0, 0, 4, 32, &offset));
  assert(!CheckedSampleOffset(0, 8, 33, 4, 32, &offset));
  assert(!CheckedSampleOffset(3, 8, 5, 4, 32, &offset));
  assert(!CheckedSampleOffset(0, 8, 0, 0, 32, &offset));
  assert(!CheckedSampleOffset(0, 8, 0, 4, 32, nullptr));
  assert(!CheckedSampleOffset(std::numeric_limits<size_t>::max(), 8, 0, 4,
                              32, &offset));
}

void TestExactCaptureWindowDisplaySelection() {
  const std::vector<CGRect> displays = {
      CGRectMake(0, 0, 1920, 1080),
      CGRectMake(1920, 0, 2560, 1440),
  };
  assert(CaptureDisplayIndexForWindow(CGRectMake(2200, 100, 900, 700),
                                      displays) == 1);
  assert(CaptureDisplayIndexForWindow(CGRectMake(-800, -600, 100, 100),
                                      displays) ==
         std::numeric_limits<size_t>::max());

  assert(CaptureWindowMatchesTarget(42, @"com.google.Chrome", 42,
                                    @"com.google.Chrome"));
  assert(!CaptureWindowMatchesTarget(73, @"com.google.Chrome", 42,
                                     @"com.google.Chrome"));
  assert(!CaptureWindowMatchesTarget(42, @"com.evil.other", 42,
                                     @"com.google.Chrome"));
}

}  // namespace

int main() {
  // The app's minimum supported deployment target is macOS 15.
  assert(kuku_meeting_audio_capture_available() == 1);
  TestByteExactBuilders();
  TestInterleavedFloatStereo();
  TestScreenCaptureKitNonInterleavedFloatStereo();
  TestFloatWidthsAndEndianness();
  TestPackedIntegerWidthsAndEndianness();
  TestPadded24BitAlignmentAndEndianness();
  TestInterleavedSignedIntegerStereo();
  TestMalformedBuffersAreRejected();
  TestSampleBounds();
  TestExactCaptureWindowDisplaySelection();
  std::cout << "native audio capture format contracts passed\n";
  return 0;
}
