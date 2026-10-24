#pragma once

#include "hostcore/AudioOutput.h"

#include <cstdint>
#include <functional>
#include <memory>

// CoreAudio queries for the window's Output menu (no SDK; the model is hostcore/AudioOutput.h).
namespace bridge
{
    // Every audio device (input-only and hidden ones too; selectableOutputs() filters them), in CoreAudio's order.
    std::vector<OutputDevice> listAudioDevices ();

    // The system default output device, 0 if there is none.
    uint32_t defaultOutputDeviceId ();

    // The device's name, empty if it is gone.
    std::string audioDeviceName (uint32_t deviceId);

    // kAudioDevicePropertyDeviceIsRunning (this process's IO on the device) and
    // kAudioDevicePropertyDeviceIsRunningSomewhere (any process); false if the device is gone.
    bool deviceIsRunning (uint32_t deviceId);
    bool deviceIsRunningSomewhere (uint32_t deviceId);

    // Calls 'changed' on the main queue when the device list or the default output device changes, until
    // destroyed (destroy it on the main thread).
    class AudioDeviceListener
    {
    public:
        explicit AudioDeviceListener (std::function<void ()> changed);
        ~AudioDeviceListener ();

        AudioDeviceListener (const AudioDeviceListener&) = delete;
        AudioDeviceListener& operator= (const AudioDeviceListener&) = delete;

    private:
        struct Impl;
        std::unique_ptr<Impl> _impl;
    };
}
