#include "hostcore/AudioOutput.h"

#include <cmath>

namespace bridge
{
    namespace
    {
        constexpr uint32_t fourCC (const char (&code)[5])
        {
            return (static_cast<uint32_t> (static_cast<unsigned char> (code[0])) << 24) | (static_cast<uint32_t> (static_cast<unsigned char> (code[1])) << 16)
                 | (static_cast<uint32_t> (static_cast<unsigned char> (code[2])) << 8) | static_cast<uint32_t> (static_cast<unsigned char> (code[3]));
        }

        std::string rateText (double rate)
        {
            return std::to_string (static_cast<long long> (std::llround (rate))) + " Hz";
        }
    }

    std::string transportName (uint32_t transport)
    {
        // the kAudioDeviceTransportType... values of CoreAudio/AudioHardwareBase.h
        struct Entry { uint32_t code; const char* name; };
        static const Entry kNames[] {
            { fourCC ("bltn"), "Built-in" },
            { fourCC ("usb "), "USB" },
            { fourCC ("thun"), "Thunderbolt" },
            { fourCC ("pci "), "PCI" },
            { fourCC ("1394"), "FireWire" },
            { fourCC ("blue"), "Bluetooth" },
            { fourCC ("blea"), "Bluetooth LE" },
            { fourCC ("hdmi"), "HDMI" },
            { fourCC ("dprt"), "DisplayPort" },
            { fourCC ("airp"), "AirPlay" },
            { fourCC ("eavb"), "AVB" },
            { fourCC ("grup"), "Aggregate" },
            { fourCC ("fgrp"), "Aggregate" },
            { fourCC ("virt"), "Virtual" },
            { fourCC ("ccap"), "Continuity" },
            { fourCC ("ccwd"), "Continuity" },
            { fourCC ("ccwl"), "Continuity" },
        };
        for (const Entry& entry : kNames)
            if (entry.code == transport)
                return entry.name;
        return {};
    }

    bool isSelectableOutput (const OutputDevice& device)
    {
        return ! device.hidden && device.outputChannels > 0 && ! device.uid.empty ();
    }

    std::vector<OutputDevice> selectableOutputs (const std::vector<OutputDevice>& devices)
    {
        std::vector<OutputDevice> outputs;
        for (const OutputDevice& device : devices)
            if (isSelectableOutput (device))
                outputs.push_back (device);
        return outputs;
    }

    const OutputDevice* findDeviceByUid (const std::vector<OutputDevice>& devices, const std::string& uid)
    {
        if (uid.empty ())
            return nullptr;
        for (const OutputDevice& device : devices)
            if (device.uid == uid)
                return &device;
        return nullptr;
    }

    const OutputDevice* findDeviceById (const std::vector<OutputDevice>& devices, uint32_t id)
    {
        if (id == 0)
            return nullptr;
        for (const OutputDevice& device : devices)
            if (device.id == id)
                return &device;
        return nullptr;
    }

    std::string outputMenuTitle (const OutputDevice& device)
    {
        const std::string name { device.name.empty () ? "Device " + std::to_string (device.id) : device.name };
        const std::string transport { transportName (device.transport) };
        return transport.empty () ? name : name + " (" + transport + ")";
    }

    std::string systemDefaultMenuTitle (const std::vector<OutputDevice>& devices, uint32_t defaultId)
    {
        const OutputDevice* device { findDeviceById (devices, defaultId) };
        return device != nullptr && ! device->name.empty () ? "System default (" + device->name + ")" : "System default";
    }

    std::string describeAudioDevices (const std::vector<OutputDevice>& devices, uint32_t defaultId, uint32_t selectedId)
    {
        std::string text { "audio devices:" };
        if (devices.empty ())
            return text + " none";
        bool first { true };
        for (const OutputDevice& device : devices)
        {
            text += first ? " " : ", ";
            first = false;
            text += "[" + std::to_string (device.id) + "] " + (device.name.empty () ? std::string { "(no name)" } : device.name) + " (";
            const std::string transport { transportName (device.transport) };
            if (! transport.empty ())
                text += transport + ", ";
            text += device.outputChannels > 0 ? std::to_string (device.outputChannels) + " ch" : std::string { "input only" };
            if (device.sampleRate > 0.0)
                text += ", " + rateText (device.sampleRate);
            if (device.hidden)
                text += ", hidden";
            if (device.uid.empty ())
                text += ", no UID";
            if (device.id == defaultId)
                text += ", default";
            if (device.id == selectedId)
                text += ", selected";
            text += ")";
        }
        return text;
    }

    std::string describeOutputUids (const std::vector<OutputDevice>& devices)
    {
        std::string text { "audio output UIDs:" };
        bool first { true };
        for (const OutputDevice& device : devices)
        {
            if (! isSelectableOutput (device))
                continue;
            text += (first ? " [" : ", [") + std::to_string (device.id) + "] " + device.uid;
            first = false;
        }
        return first ? text + " none" : text;
    }

    OutputChoice chooseOutput (const std::vector<OutputDevice>& devices, const std::string& savedUid, const std::string& environmentUid)
    {
        OutputChoice choice;
        if (! environmentUid.empty ())
        {
            if (environmentUid == kSystemDefaultOutputUid)
            {
                choice.source = OutputSource::environment;
                return choice;
            }
            choice.source = OutputSource::environment;
            choice.requestedUid = environmentUid;
        }
        else if (! savedUid.empty ())
        {
            choice.source = OutputSource::saved;
            choice.requestedUid = savedUid;
        }
        else
        {
            return choice;
        }

        const OutputDevice* device { findDeviceByUid (devices, choice.requestedUid) };
        if (device == nullptr || ! isSelectableOutput (*device))
        {
            choice.requestedMissing = true;
            return choice;
        }
        choice.uid = device->uid;
        choice.deviceId = device->id;
        return choice;
    }

    std::string outputStatusText (const OutputChoice& choice, const std::vector<OutputDevice>& devices, uint32_t defaultId)
    {
        if (choice.requestedMissing)
            return std::string { "Output: System default (" } + (choice.source == OutputSource::environment ? "requested" : "saved") + " device not available)";
        if (const OutputDevice* device { choice.deviceId != 0 ? findDeviceById (devices, choice.deviceId) : nullptr })
            return "Output: " + (device->name.empty () ? outputMenuTitle (*device) : device->name);
        return "Output: " + systemDefaultMenuTitle (devices, defaultId);
    }

    bool outputLooksDead (int64_t renderCallbacksSincePlay, bool engineRunning)
    {
        return ! engineRunning || renderCallbacksSincePlay <= 0;
    }
}
