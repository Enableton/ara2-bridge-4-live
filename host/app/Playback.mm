// SDK headers first (see MemoryAudioFile.h)
#include "app/Playback.h"

#include "audio/OutputDevices.h"

#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <CoreAudio/CoreAudio.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>

namespace
{
    std::string utf8 (NSString* text)
    {
        const char* bytes { text.UTF8String };
        return bytes != nullptr ? std::string { bytes } : std::string {};
    }
}

struct Playback::Impl
{
    AVAudioEngine* engine { nil };
    AVAudioSourceNode* node { nil };
    AVAudioFormat* sourceFormat { nil };
    PlugInInstance* instance { nullptr };
    int channelCount { 0 };
    int64_t start { 0 };
    int64_t end { 0 };
    bool started { false };
    std::string error;
    uint32_t requestedDevice { 0 };     // 0: the system default
    int outputChannels { 0 };
    double outputRate { 0.0 };
    std::atomic<bool> playing { false };
    std::atomic<int64_t> position { 0 };
    std::atomic<int64_t> pendingSeek { -1 };    // set by the main thread while playing, taken by the audio thread
    std::atomic<int64_t> cycleStart { 0 };
    std::atomic<int64_t> cycleEnd { 0 };
    std::atomic<bool> cycling { false };
    std::atomic<bool> muted { false };
    int restarts { 0 };
    id observer { nil };
    std::atomic<int64_t> callbacks { 0 };
    std::atomic<int64_t> frames { 0 };
    std::atomic<float> peak { 0.0f };

    static_assert (std::atomic<int64_t>::is_always_lock_free && std::atomic<float>::is_always_lock_free, "the audio thread needs lock-free atomics");

    static void silence (AudioBufferList* list, AVAudioFrameCount from, AVAudioFrameCount count)
    {
        for (UInt32 i = 0; i < list->mNumberBuffers; ++i)
            std::memset (static_cast<float*> (list->mBuffers[i].mData) + from, 0, count * sizeof (float));
    }

    // audio thread
    OSStatus render (BOOL* isSilence, AVAudioFrameCount count, AudioBufferList* list)
    {
        constexpr UInt32 kMaxChannels { 16 };
        if (! playing.load () || list->mNumberBuffers != static_cast<UInt32> (channelCount) || list->mNumberBuffers > kMaxChannels)
        {
            silence (list, 0, count);
            *isSilence = YES;
            return noErr;
        }

        float* buffers[kMaxChannels];
        AVAudioFrameCount done { 0 };
        int64_t at { position.load () };
        if (const int64_t seekTo { pendingSeek.exchange (-1) }; seekTo >= 0)
            at = seekTo;
        const bool loop { cycling.load () };
        const int64_t loopStart { cycleStart.load () }, loopEnd { cycleEnd.load () };
        const bool looping { loop && loopEnd > loopStart && at < loopEnd };
        float level { 0.0f };
        while (done < count)
        {
            if (looping && at >= loopEnd)
                at = loopStart;
            if (! looping && at >= end)
                break;
            const int64_t stopAt { looping ? loopEnd : end };
            const int chunk { static_cast<int> (std::min<int64_t> ({ static_cast<int64_t> (count - done), static_cast<int64_t> (kMaxBlock), stopAt - at })) };
            for (UInt32 i = 0; i < list->mNumberBuffers; ++i)
                buffers[i] = static_cast<float*> (list->mBuffers[i].mData) + done;
            instance->renderSamples (chunk, at, buffers);
            if (muted.load ())
                for (UInt32 i = 0; i < list->mNumberBuffers; ++i)
                    std::memset (buffers[i], 0, static_cast<size_t> (chunk) * sizeof (float));
            else
                for (UInt32 i = 0; i < list->mNumberBuffers; ++i)
                    for (int k = 0; k < chunk; ++k)
                        level = std::max (level, std::fabs (buffers[i][k]));
            at += chunk;
            done += static_cast<AVAudioFrameCount> (chunk);
        }
        if (done < count)
            silence (list, done, count - done);
        position = at;
        if (! looping && at >= end)
            playing = false;        // stops by itself at the end of the region
        ++callbacks;
        frames += done;
        if (level > peak.load ())
            peak = level;
        *isSilence = done == 0 ? YES : NO;
        return noErr;
    }

    static bool connect (AVAudioEngine* engine, AVAudioNode* from, AVAudioNode* to, AVAudioFormat* format, NSError** error)
    {
        if (@available (macOS 27.0, *))
            return [engine connect: from to: to format: format error: error];
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
        [engine connect: from to: to format: format];
#pragma clang diagnostic pop
        return true;
    }

    void fail (const std::string& why)
    {
        error = why;
        started = false;
    }

    // main thread; afterwards the plug-in is not called from the old engine's thread anymore
    void teardownEngine ()
    {
        if (observer != nil)
            [[NSNotificationCenter defaultCenter] removeObserver: observer];
        observer = nil;
        [engine stop];
        engine = nil;
        node = nil;
        started = false;
        outputChannels = 0;
        outputRate = 0.0;
    }

    // main thread: a new engine (and source node: a node belongs to one engine) for requestedDevice. The play
    // state and position are left alone, so playing goes on where it was once the new engine runs.
    bool buildEngine ()
    {
        teardownEngine ();
        error.clear ();
        // Right after another device's engine was stopped, the output unit may refuse a device for a moment
        // (measured: P1 within 0.2 s after a virtual device gave 'nope'; 2 s later it worked): a few retries.
        constexpr int kAttempts { 6 };
        for (int attempt { 1 }; attempt <= kAttempts; ++attempt)
        {
            const uint32_t device { requestedDevice != 0 ? requestedDevice : bridge::defaultOutputDeviceId () };
            if (device == 0)
            {
                fail ("there is no output device");
                return false;
            }
            if (buildEngineOnce (device))
                return true;
            if (attempt < kAttempts)
                [NSThread sleepForTimeInterval: 0.1];
        }
        return false;
    }

    bool buildEngineOnce (uint32_t device)
    {
        engine = [[AVAudioEngine alloc] init];
        // the device first: touching mainMixerNode would wire the mixer to the output at the old device's format
        AudioDeviceID deviceId { device };
        AudioUnit unit { engine.outputNode.audioUnit };
        const OSStatus status { unit == nullptr ? kAudioUnitErr_Uninitialized
                                                : AudioUnitSetProperty (unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &deviceId, sizeof (deviceId)) };
        if (status != noErr)
        {
            engine = nil;
            fail ("cannot play to device " + std::to_string (device) + " (error " + std::to_string (status) + ")");
            return false;
        }
        AVAudioFormat* hardware { [engine.outputNode outputFormatForBus: 0] };
        if (hardware.channelCount == 0 || ! (hardware.sampleRate > 0.0))
        {
            engine = nil;
            fail ("device " + std::to_string (device) + " has no usable output format");
            return false;
        }
        // the first two channels of the device (a mono device gets a mono mix), at the device's own rate
        outputChannels = std::min<int> (2, static_cast<int> (hardware.channelCount));
        outputRate = hardware.sampleRate;
        AVAudioFormat* outputFormat { [[AVAudioFormat alloc] initStandardFormatWithSampleRate: outputRate channels: static_cast<AVAudioChannelCount> (outputChannels)] };

        Impl* impl { this };
        node = [[AVAudioSourceNode alloc] initWithFormat: sourceFormat renderBlock: ^OSStatus (BOOL* isSilence, const AudioTimeStamp*, AVAudioFrameCount count, AudioBufferList* list) {
            return impl->render (isSilence, count, list);
        }];
        [engine attachNode: node];
        NSError* nsError { nil };
        if (outputFormat == nil || ! connect (engine, node, engine.mainMixerNode, sourceFormat, &nsError)
            || ! connect (engine, engine.mainMixerNode, engine.outputNode, outputFormat, &nsError))
        {
            const std::string why { nsError != nil ? utf8 (nsError.localizedDescription) : std::string { "the audio graph could not be connected" } };
            teardownEngine ();
            fail (why);
            return false;
        }
        [engine prepare];
        started = [engine startAndReturnError: &nsError];
        if (! started)
        {
            const std::string why { nsError != nil ? utf8 (nsError.localizedDescription) : std::string { "the audio engine did not start" } };
            teardownEngine ();
            fail (why);
            return false;
        }

        // the device's configuration changed (rate, channels, gone): the engine stopped itself; build it again
        AVAudioEngine* observed { engine };
        observer = [[NSNotificationCenter defaultCenter] addObserverForName: AVAudioEngineConfigurationChangeNotification object: observed
                                                                      queue: [NSOperationQueue mainQueue] usingBlock: ^(NSNotification*) {
            if (impl->engine != observed || impl->engine.isRunning)
                return;     // an old engine, or nothing stopped (e.g. the notification of building this engine)
            ++impl->restarts;
            if (! impl->buildEngine ())
                impl->playing = false;
        }];
        return true;
    }

    uint32_t currentDevice () const
    {
        AudioUnit unit { engine != nil ? engine.outputNode.audioUnit : nullptr };
        if (unit == nullptr)
            return 0;
        AudioDeviceID device { kAudioObjectUnknown };
        UInt32 size { sizeof (device) };
        if (AudioUnitGetProperty (unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device, &size) != noErr)
            return 0;
        return device;
    }
};

Playback::Playback (PlugInInstance* instance, int channelCount, double sampleRate, int64_t startSample, int64_t endSample, uint32_t outputDevice)
: _impl { new Impl }
{
    Impl* impl { _impl.get () };
    impl->instance = instance;
    impl->channelCount = channelCount;
    impl->start = startSample;
    impl->end = std::max (startSample, endSample);
    impl->position = startSample;
    impl->requestedDevice = outputDevice;

    impl->sourceFormat = [[AVAudioFormat alloc] initStandardFormatWithSampleRate: sampleRate channels: static_cast<AVAudioChannelCount> (channelCount)];
    if (impl->sourceFormat == nil)
    {
        impl->error = "unsupported audio format";
        return;
    }
    impl->buildEngine ();
}

Playback::~Playback ()
{
    _impl->playing = false;
    _impl->teardownEngine ();   // after this the plug-in is not called anymore
}

bool Playback::started () const { return _impl->started; }
const std::string& Playback::error () const { return _impl->error; }

bool Playback::engineRunning () const { return _impl->engine != nil && _impl->engine.isRunning; }

bool Playback::setOutputDevice (uint32_t outputDevice)
{
    _impl->requestedDevice = outputDevice;
    return _impl->buildEngine ();
}

uint32_t Playback::requestedOutputDevice () const { return _impl->requestedDevice; }
uint32_t Playback::outputDeviceId () const { return _impl->currentDevice (); }
int Playback::outputChannels () const { return _impl->outputChannels; }
double Playback::outputSampleRate () const { return _impl->outputRate; }

std::string Playback::deviceDescription () const
{
    const uint32_t device { _impl->currentDevice () };
    if (device == 0)
        return "no output device" + (_impl->requestedDevice != 0 ? " (device " + std::to_string (_impl->requestedDevice) + " requested)" : std::string {});
    const std::string name { bridge::audioDeviceName (device) };
    return (name.empty () ? std::string { "(no name)" } : name) + " (device " + std::to_string (device) + "), " + std::to_string (_impl->outputChannels)
         + " ch, rate " + std::to_string (static_cast<long long> (std::llround (_impl->outputRate))) + " Hz";
}

void Playback::play ()
{
    if (! _impl->started)
        return;
    if (_impl->position.load () >= _impl->end)
        _impl->position = _impl->start;
    _impl->playing = true;
}

void Playback::rewind ()
{
    _impl->playing = false;
    _impl->position = _impl->start;
}

void Playback::stop () { _impl->playing = false; }
int64_t Playback::startSample () const { return _impl->start; }
int64_t Playback::endSample () const { return _impl->end; }

void Playback::seek (int64_t sample)
{
    const int64_t to { std::clamp (sample, _impl->start, std::max (_impl->start, _impl->end - 1)) };
    if (_impl->playing.load ())
        _impl->pendingSeek = to;
    else
        _impl->position = to;
}

void Playback::setCycle (int64_t start, int64_t end)
{
    _impl->cycleStart = std::clamp (start, _impl->start, _impl->end);
    _impl->cycleEnd = std::clamp (end, _impl->start, _impl->end);
}

void Playback::enableCycle (bool enable) { _impl->cycling = enable; }
void Playback::setMuted (bool muted) { _impl->muted = muted; }
bool Playback::muted () const { return _impl->muted.load (); }
int Playback::restarts () const { return _impl->restarts; }

void Playback::simulateConfigurationChangeForTests ()
{
    [_impl->engine stop];
    [[NSNotificationCenter defaultCenter] postNotificationName: AVAudioEngineConfigurationChangeNotification object: _impl->engine];
}
bool Playback::isPlaying () const { return _impl->playing.load (); }
int64_t Playback::positionSamples () const { return _impl->position.load (); }

Playback::Stats Playback::stats () const
{
    return { _impl->callbacks.load (), _impl->frames.load (), _impl->peak.load () };
}
