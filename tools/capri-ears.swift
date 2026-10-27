// Streams the Mac's system audio (the other side of a call, a video, anything
// playing) to stdout as 16 kHz mono 32-bit float samples, through
// ScreenCaptureKit. Capri runs it while her always-on log is on, and builds
// it on first use with `swiftc -O -parse-as-library tools/capri-ears.swift`.
// Needs Screen Recording permission. Exits when stdin closes (Capri quit).

import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

let outRate = 16000.0

final class Tap: NSObject, SCStreamOutput, SCStreamDelegate {
  private let out = FileHandle.standardOutput
  private var phase = 0.0  // resampling position, carried across buffers
  private var last: Float = 0

  func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .audio, buffer.isValid,
      let format = CMSampleBufferGetFormatDescription(buffer),
      let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee
    else { return }
    let frames = CMSampleBufferGetNumSamples(buffer)
    guard frames > 0 else { return }

    var size = 0
    CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      buffer, bufferListSizeNeededOut: &size, bufferListOut: nil, bufferListSize: 0,
      blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
    let raw = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 16)
    defer { raw.deallocate() }
    let list = raw.assumingMemoryBound(to: AudioBufferList.self)
    var block: CMBlockBuffer?
    guard
      CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        buffer, bufferListSizeNeededOut: nil, bufferListOut: list, bufferListSize: size,
        blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
        flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &block) == noErr
    else { return }

    // Mix down to mono. Buffers are float; one per channel, or interleaved.
    let buffers = UnsafeMutableAudioBufferListPointer(list)
    let channels = Int(asbd.mChannelsPerFrame)
    var mono = [Float](repeating: 0, count: frames)
    if buffers.count == 1 && channels > 1 {
      guard let p = buffers[0].mData?.assumingMemoryBound(to: Float.self) else { return }
      for i in 0..<frames {
        var sum: Float = 0
        for c in 0..<channels { sum += p[i * channels + c] }
        mono[i] = sum / Float(channels)
      }
    } else {
      for b in buffers {
        guard let p = b.mData?.assumingMemoryBound(to: Float.self) else { continue }
        for i in 0..<frames { mono[i] += p[i] }
      }
      let n = Float(max(1, buffers.count))
      for i in 0..<frames { mono[i] /= n }
    }

    // Resample to 16 kHz (linear), unless ScreenCaptureKit already did.
    var samples: [Float]
    let step = asbd.mSampleRate / outRate
    if abs(step - 1) < 0.0001 {
      samples = mono
    } else {
      samples = []
      samples.reserveCapacity(Int(Double(frames) / step) + 2)
      while phase < Double(frames) {
        let i = Int(phase)
        let t = Float(phase - Double(i))
        let a = i == 0 ? last : mono[i - 1]
        let b = mono[i]
        samples.append(a + (b - a) * t)
        phase += step
      }
      phase -= Double(frames)
      last = mono[frames - 1]
    }
    samples.withUnsafeBufferPointer { out.write(Data(buffer: $0)) }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    FileHandle.standardError.write("capture stopped: \(error.localizedDescription)\n".data(using: .utf8)!)
    exit(3)
  }
}

// Video frames aren't wanted, but a stream without a screen output logs a
// complaint for every frame it drops.
final class Sink: NSObject, SCStreamOutput {
  func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {}
}

@main
struct Ears {
  static func main() async {
    // Capri quit (or crashed): stdin closes, so do we.
    Thread.detachNewThread {
      while !FileHandle.standardInput.availableData.isEmpty {}
      exit(0)
    }
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
      guard let display = content.displays.first else {
        FileHandle.standardError.write("no display to capture\n".data(using: .utf8)!)
        exit(2)
      }
      let config = SCStreamConfiguration()
      config.capturesAudio = true
      config.sampleRate = Int(outRate)
      config.channelCount = 1
      config.excludesCurrentProcessAudio = true
      config.width = 2
      config.height = 2
      config.minimumFrameInterval = CMTime(value: 10, timescale: 1)
      config.queueDepth = 3
      let tap = Tap()
      let sink = Sink()
      let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
      let stream = SCStream(filter: filter, configuration: config, delegate: tap)
      try stream.addStreamOutput(tap, type: .audio, sampleHandlerQueue: DispatchQueue(label: "capri.audio"))
      try stream.addStreamOutput(sink, type: .screen, sampleHandlerQueue: DispatchQueue(label: "capri.screen"))
      try await stream.startCapture()
      while true { try await Task.sleep(nanoseconds: 3_600_000_000_000) }
    } catch {
      FileHandle.standardError.write("\(error.localizedDescription)\n".data(using: .utf8)!)
      exit(1)
    }
  }
}
