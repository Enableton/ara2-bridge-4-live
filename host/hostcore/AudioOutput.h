#pragma once

#include <cstdint>
#include <string>
#include <vector>

// The window's output device choice, SDK-free and CoreAudio-free so it can be unit-tested. The CoreAudio
// side (audio/OutputDevices.h) fills OutputDevice; the window builds its Output menu, its status text and
// the log lines from the functions here.
//
// Why the host needs its own choice: an ARA plug-in has no audio device preferences (the host owns the
// output), and a host launched by the M4L device inherits the system default output, which may not be the
// interface Live plays to.
namespace bridge
{
    struct OutputDevice
    {
        uint32_t id { 0 };              // AudioObjectID; changes between boots and reconnects
        std::string uid;                // kAudioDevicePropertyDeviceUID; stable, what audio.json stores
        std::string name;
        uint32_t transport { 0 };       // kAudioDevicePropertyTransportType (a four-char code)
        int outputChannels { 0 };       // 0: an input-only device
        double sampleRate { 0.0 };      // nominal rate
        bool hidden { false };          // kAudioDevicePropertyIsHidden
    };

    // "Built-in", "USB", "Bluetooth", ... for a transport type code; empty if unknown.
    std::string transportName (uint32_t transport);

    // An output the menu offers: not hidden, at least one output channel, a UID.
    bool isSelectableOutput (const OutputDevice& device);
    std::vector<OutputDevice> selectableOutputs (const std::vector<OutputDevice>& devices);

    const OutputDevice* findDeviceByUid (const std::vector<OutputDevice>& devices, const std::string& uid);
    const OutputDevice* findDeviceById (const std::vector<OutputDevice>& devices, uint32_t id);

    // "P1 (USB)", or "P1" if the transport is unknown.
    std::string outputMenuTitle (const OutputDevice& device);
    // "System default (MacBook Pro Speakers)", or "System default" if there is no default output.
    std::string systemDefaultMenuTitle (const std::vector<OutputDevice>& devices, uint32_t defaultId);

    // The startup log line: "audio devices: [117] MacBook Pro Speakers (Built-in, 2 ch, 48000 Hz, default),
    // [156] P1 (USB, 4 ch, 88200 Hz, selected)"; input-only and hidden devices are listed as such.
    std::string describeAudioDevices (const std::vector<OutputDevice>& devices, uint32_t defaultId, uint32_t selectedId);

    // "audio output UIDs: [117] BuiltInSpeakerDevice, [152] AppleUSB..." (selectable outputs only), for
    // ARABRIDGE_AUDIO_OUTPUT_UID and audio.json.
    std::string describeOutputUids (const std::vector<OutputDevice>& devices);

    // The value of ARABRIDGE_AUDIO_OUTPUT_UID that means "system default" (ignores audio.json).
    constexpr const char* kSystemDefaultOutputUid { "default" };

    enum class OutputSource
    {
        systemDefault,  // nothing asked for
        saved,          // audio.json
        environment,    // ARABRIDGE_AUDIO_OUTPUT_UID
    };

    struct OutputChoice
    {
        OutputSource source { OutputSource::systemDefault };
        std::string requestedUid;       // what audio.json or the environment asked for (empty: nothing)
        std::string uid;                // the device to use; empty: the system default
        uint32_t deviceId { 0 };        // 0: the system default
        bool requestedMissing { false };    // requestedUid names no selectable device: the system default is used
    };

    // The output to start with. The environment (non-empty) wins over audio.json; kSystemDefaultOutputUid in
    // the environment means the system default whatever audio.json says. A requested UID that is not
    // connected (or not a selectable output) falls back to the system default with requestedMissing set.
    OutputChoice chooseOutput (const std::vector<OutputDevice>& devices, const std::string& savedUid, const std::string& environmentUid);

    // The status line part for the output: "Output: P1", "Output: System default (MacBook Pro Speakers)",
    // "Output: System default (saved device not available)" (requestedMissing; "requested device" for the
    // environment).
    std::string outputStatusText (const OutputChoice& choice, const std::vector<OutputDevice>& devices, uint32_t defaultId);

    // The check 500 ms after Play started: true if no audio came from the output device (the engine is not
    // running, or it called the render callback not once while playing).
    bool outputLooksDead (int64_t renderCallbacksSincePlay, bool engineRunning);
}
