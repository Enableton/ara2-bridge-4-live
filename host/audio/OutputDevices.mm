#include "audio/OutputDevices.h"

#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>

#include <vector>

namespace bridge
{
    namespace
    {
        AudioObjectPropertyAddress address (AudioObjectPropertySelector selector, AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal)
        {
            return { selector, scope, kAudioObjectPropertyElementMain };
        }

        template <typename T>
        bool readProperty (AudioObjectID object, AudioObjectPropertyAddress where, T& value)
        {
            UInt32 size { sizeof (T) };
            return AudioObjectGetPropertyData (object, &where, 0, nullptr, &size, &value) == noErr && size == sizeof (T);
        }

        std::string readString (AudioObjectID object, AudioObjectPropertySelector selector)
        {
            CFStringRef text { nullptr };
            if (! readProperty (object, address (selector), text) || text == nullptr)
                return {};
            std::string result;
            if (const char* bytes { [(__bridge NSString*) text UTF8String] })
                result = bytes;
            CFRelease (text);
            return result;
        }

        int outputChannelCount (AudioObjectID device)
        {
            AudioObjectPropertyAddress where { address (kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeOutput) };
            UInt32 size { 0 };
            if (AudioObjectGetPropertyDataSize (device, &where, 0, nullptr, &size) != noErr || size < sizeof (AudioBufferList))
                return 0;
            std::vector<std::byte> storage (size);
            auto* list { reinterpret_cast<AudioBufferList*> (storage.data ()) };
            if (AudioObjectGetPropertyData (device, &where, 0, nullptr, &size, list) != noErr)
                return 0;
            int channels { 0 };
            for (UInt32 i { 0 }; i < list->mNumberBuffers; ++i)
                channels += static_cast<int> (list->mBuffers[i].mNumberChannels);
            return channels;
        }

        bool readFlag (uint32_t device, AudioObjectPropertySelector selector)
        {
            UInt32 flag { 0 };
            return device != 0 && readProperty (device, address (selector), flag) && flag != 0;
        }
    }

    std::vector<OutputDevice> listAudioDevices ()
    {
        std::vector<OutputDevice> devices;
        AudioObjectPropertyAddress where { address (kAudioHardwarePropertyDevices) };
        UInt32 size { 0 };
        if (AudioObjectGetPropertyDataSize (kAudioObjectSystemObject, &where, 0, nullptr, &size) != noErr || size == 0)
            return devices;
        std::vector<AudioObjectID> ids (size / sizeof (AudioObjectID));
        if (AudioObjectGetPropertyData (kAudioObjectSystemObject, &where, 0, nullptr, &size, ids.data ()) != noErr)
            return devices;
        ids.resize (size / sizeof (AudioObjectID));

        @autoreleasepool
        {
            for (const AudioObjectID id : ids)
            {
                OutputDevice device;
                device.id = id;
                device.uid = readString (id, kAudioDevicePropertyDeviceUID);
                device.name = readString (id, kAudioObjectPropertyName);
                UInt32 transport { 0 };
                if (readProperty (id, address (kAudioDevicePropertyTransportType), transport))
                    device.transport = transport;
                device.outputChannels = outputChannelCount (id);
                Float64 rate { 0.0 };
                if (readProperty (id, address (kAudioDevicePropertyNominalSampleRate), rate))
                    device.sampleRate = rate;
                device.hidden = readFlag (id, kAudioDevicePropertyIsHidden);
                devices.push_back (device);
            }
        }
        return devices;
    }

    uint32_t defaultOutputDeviceId ()
    {
        AudioObjectID device { kAudioObjectUnknown };
        if (! readProperty (kAudioObjectSystemObject, address (kAudioHardwarePropertyDefaultOutputDevice), device))
            return 0;
        return device;
    }

    std::string audioDeviceName (uint32_t deviceId)
    {
        if (deviceId == 0)
            return {};
        @autoreleasepool
        {
            return readString (deviceId, kAudioObjectPropertyName);
        }
    }

    bool deviceIsRunning (uint32_t deviceId) { return readFlag (deviceId, kAudioDevicePropertyDeviceIsRunning); }
    bool deviceIsRunningSomewhere (uint32_t deviceId) { return readFlag (deviceId, kAudioDevicePropertyDeviceIsRunningSomewhere); }

    struct AudioDeviceListener::Impl
    {
        AudioObjectPropertyListenerBlock block { nil };
        bool devices { false };
        bool defaultOutput { false };
    };

    AudioDeviceListener::AudioDeviceListener (std::function<void ()> changed)
    : _impl { new Impl }
    {
        // a copy the block owns; the block itself is kept until the listeners are removed
        auto callback { std::make_shared<std::function<void ()>> (std::move (changed)) };
        _impl->block = ^(UInt32, const AudioObjectPropertyAddress*) {
            (*callback) ();
        };
        AudioObjectPropertyAddress devices { address (kAudioHardwarePropertyDevices) };
        AudioObjectPropertyAddress defaultOutput { address (kAudioHardwarePropertyDefaultOutputDevice) };
        _impl->devices = AudioObjectAddPropertyListenerBlock (kAudioObjectSystemObject, &devices, dispatch_get_main_queue (), _impl->block) == noErr;
        _impl->defaultOutput = AudioObjectAddPropertyListenerBlock (kAudioObjectSystemObject, &defaultOutput, dispatch_get_main_queue (), _impl->block) == noErr;
    }

    AudioDeviceListener::~AudioDeviceListener ()
    {
        AudioObjectPropertyAddress devices { address (kAudioHardwarePropertyDevices) };
        AudioObjectPropertyAddress defaultOutput { address (kAudioHardwarePropertyDefaultOutputDevice) };
        if (_impl->devices)
            AudioObjectRemovePropertyListenerBlock (kAudioObjectSystemObject, &devices, dispatch_get_main_queue (), _impl->block);
        if (_impl->defaultOutput)
            AudioObjectRemovePropertyListenerBlock (kAudioObjectSystemObject, &defaultOutput, dispatch_get_main_queue (), _impl->block);
    }
}
