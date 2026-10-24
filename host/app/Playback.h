#pragma once

#include "CompanionAPIs.h"

#include <cstdint>
#include <memory>
#include <string>

// Real-time playback of an ARA plug-in instance (bound as playback renderer) through an output device (the
// window's Output menu; 0 = the system default). The instance must already have been startRendering()-ed
// with the same channel count and sample rate and a maximum block size of kMaxBlock. Playback covers
// [startSample, endSample) of the playback timeline and stops by itself at the end. The plug-in is called on
// the audio device's thread; the destructor stops the engine, so the instance may be stopped and destroyed
// after the Playback is gone.
//
// The plug-in always renders at the clip's sample rate and channel count; the engine's main mixer converts
// to the device's nominal rate (whatever it is, e.g. 44.1, 48, 88.2 or 96 kHz; the device's rate is never
// changed) and to at most two channels, which the output unit sends to the device's first channels (a mono
// device gets a mono mix). Main thread only, except the render callback.
class Playback
{
public:
    static constexpr int kMaxBlock { 4096 };      // pass this to PlugInInstance::startRendering

    Playback (PlugInInstance* instance, int channelCount, double sampleRate, int64_t startSample, int64_t endSample,
              uint32_t outputDevice = 0);
    ~Playback ();

    Playback (const Playback&) = delete;
    Playback& operator= (const Playback&) = delete;

    bool started () const;                  // the output engine was started (on the last build or restart)
    bool engineRunning () const;            // ... and still runs
    const std::string& error () const;      // why it did not start

    // Moves the output to another device (AudioDeviceID; 0 = the system default, resolved now), also while
    // playing: the engine is stopped and built again for that device; the play state, play position and
    // cycle stay. Returns started(); on failure error() says why and the Play button is disabled until a
    // later switch or restart works.
    bool setOutputDevice (uint32_t outputDevice);
    uint32_t requestedOutputDevice () const;    // as passed (0 = the system default)
    uint32_t outputDeviceId () const;           // the device the output unit really uses (read back), 0 if none
    int outputChannels () const;                // channels sent to the device (1 or 2)
    double outputSampleRate () const;           // the device's rate the engine runs at
    // "P1 (device 152), 2 ch, rate 88200 Hz" (of the device in use), for the log
    std::string deviceDescription () const;

    void play ();                           // from the start, or from where stop() left off
    void rewind ();                         // the next play() starts at the beginning
    void stop ();
    bool isPlaying () const;
    int64_t positionSamples () const;
    int64_t startSample () const;
    int64_t endSample () const;

    // Moves the play position (clamped to the region), also while playing.
    void seek (int64_t sample);

    // Loops [start, end) (clamped to the region) while enabled; ignored if the range is empty.
    void setCycle (int64_t start, int64_t end);
    void enableCycle (bool enable);

    // The output device's configuration changed (AVAudioEngineConfigurationChangeNotification, e.g. its
    // sample rate was changed by another app, or it went away): the engine has stopped itself and is built
    // again on the main thread for the same requested device (0: the current system default). Playback keeps
    // its state; if the restart fails, playback stops and started() turns false. A notification while the
    // engine still runs (e.g. one caused by building it) is ignored.
    int restarts () const;                  // how often the engine was restarted (for the log and tests)
    void simulateConfigurationChangeForTests ();

    // for tests and the log: render callbacks that called the plug-in, frames rendered and the peak level
    struct Stats
    {
        int64_t callbacks { 0 };
        int64_t frames { 0 };
        float peak { 0.0f };
    };
    Stats stats () const;

private:
    struct Impl;
    std::unique_ptr<Impl> _impl;
};
