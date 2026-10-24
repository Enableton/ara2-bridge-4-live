#include "check.h"
#include "testutil.h"

#include "audio/OutputDevices.h"
#include "hostcore/AudioOutput.h"
#include "jobio/Job.h"

#include <cstdlib>
#include <filesystem>
#include <sys/stat.h>

namespace
{
    constexpr uint32_t kBuiltIn { 0x626c746e };     // 'bltn'
    constexpr uint32_t kUsb { 0x75736220 };         // 'usb '

    bridge::OutputDevice device (uint32_t id, const std::string& uid, const std::string& name, uint32_t transport, int channels, double rate)
    {
        bridge::OutputDevice d;
        d.id = id;
        d.uid = uid;
        d.name = name;
        d.transport = transport;
        d.outputChannels = channels;
        d.sampleRate = rate;
        return d;
    }

    // speakers (default), a 4-channel USB interface, a microphone, a hidden aggregate
    std::vector<bridge::OutputDevice> sampleDevices ()
    {
        std::vector<bridge::OutputDevice> devices {
            device (117, "BuiltInSpeakerDevice", "MacBook Pro Speakers", kBuiltIn, 2, 48000.0),
            device (156, "AppleUSBAudioEngine:Vendor:P1:1234:1,2", "P1", kUsb, 4, 88200.0),
            device (90, "BuiltInMicrophoneDevice", "MacBook Pro Microphone", kBuiltIn, 0, 48000.0),
            device (200, "CADefaultDeviceAggregate-1-2", "CADefaultDeviceAggregate", 0x67727570, 2, 48000.0),
        };
        devices[3].hidden = true;
        return devices;
    }
}

TEST (audio_transport_names)
{
    CHECK (bridge::transportName (kBuiltIn) == "Built-in");
    CHECK (bridge::transportName (kUsb) == "USB");
    CHECK (bridge::transportName (0x626c7565) == "Bluetooth");      // 'blue'
    CHECK (bridge::transportName (0) .empty ());
    CHECK (bridge::transportName (0x12345678).empty ());
}

TEST (audio_selectable_outputs_skip_inputs_hidden_and_uidless_devices)
{
    auto devices { sampleDevices () };
    devices.push_back (device (300, "", "No UID", kUsb, 2, 44100.0));
    const auto outputs { bridge::selectableOutputs (devices) };
    REQUIRE (outputs.size () == 2);
    CHECK (outputs[0].id == 117);
    CHECK (outputs[1].id == 156);
}

TEST (audio_menu_titles)
{
    const auto devices { sampleDevices () };
    CHECK (bridge::outputMenuTitle (devices[1]) == "P1 (USB)");
    CHECK (bridge::outputMenuTitle (device (5, "x", "Thing", 0, 2, 0)) == "Thing");
    CHECK (bridge::outputMenuTitle (device (5, "x", "", 0, 2, 0)) == "Device 5");
    CHECK (bridge::systemDefaultMenuTitle (devices, 117) == "System default (MacBook Pro Speakers)");
    CHECK (bridge::systemDefaultMenuTitle (devices, 0) == "System default");
    CHECK (bridge::systemDefaultMenuTitle (devices, 999) == "System default");
}

TEST (audio_device_log_line_marks_default_and_selected)
{
    const std::string text { bridge::describeAudioDevices (sampleDevices (), 117, 156) };
    CHECK (text.rfind ("audio devices: [117] MacBook Pro Speakers (Built-in, 2 ch, 48000 Hz, default), [156] P1 (USB, 4 ch, 88200 Hz, selected)", 0) == 0);
    CHECK (text.find ("[90] MacBook Pro Microphone (Built-in, input only, 48000 Hz)") != std::string::npos);
    CHECK (text.find ("[200] CADefaultDeviceAggregate (Aggregate, 2 ch, 48000 Hz, hidden)") != std::string::npos);
    CHECK (bridge::describeAudioDevices ({}, 0, 0) == "audio devices: none");
    // the default selected: both marks on one device
    CHECK (bridge::describeAudioDevices ({ sampleDevices ()[0] }, 117, 117).find ("48000 Hz, default, selected)") != std::string::npos);
}

TEST (audio_uid_log_line_lists_outputs_only)
{
    CHECK (bridge::describeOutputUids (sampleDevices ()) == "audio output UIDs: [117] BuiltInSpeakerDevice, [156] AppleUSBAudioEngine:Vendor:P1:1234:1,2");
    CHECK (bridge::describeOutputUids ({}) == "audio output UIDs: none");
}

TEST (audio_choice_defaults_to_the_system_output)
{
    const auto choice { bridge::chooseOutput (sampleDevices (), "", "") };
    CHECK (choice.source == bridge::OutputSource::systemDefault);
    CHECK (choice.deviceId == 0);
    CHECK (choice.uid.empty ());
    CHECK (! choice.requestedMissing);
    CHECK (bridge::outputStatusText (choice, sampleDevices (), 117) == "Output: System default (MacBook Pro Speakers)");
}

TEST (audio_choice_uses_the_saved_device)
{
    const auto choice { bridge::chooseOutput (sampleDevices (), "AppleUSBAudioEngine:Vendor:P1:1234:1,2", "") };
    CHECK (choice.source == bridge::OutputSource::saved);
    CHECK (choice.deviceId == 156);
    CHECK (choice.uid == "AppleUSBAudioEngine:Vendor:P1:1234:1,2");
    CHECK (! choice.requestedMissing);
    CHECK (bridge::outputStatusText (choice, sampleDevices (), 117) == "Output: P1");
}

TEST (audio_choice_falls_back_when_the_saved_device_is_gone)
{
    const auto choice { bridge::chooseOutput (sampleDevices (), "UnpluggedInterface", "") };
    CHECK (choice.source == bridge::OutputSource::saved);
    CHECK (choice.requestedUid == "UnpluggedInterface");
    CHECK (choice.deviceId == 0);
    CHECK (choice.uid.empty ());
    CHECK (choice.requestedMissing);
    CHECK (bridge::outputStatusText (choice, sampleDevices (), 117) == "Output: System default (saved device not available)");

    // an input-only or hidden device is not an output either
    CHECK (bridge::chooseOutput (sampleDevices (), "BuiltInMicrophoneDevice", "").requestedMissing);
    CHECK (bridge::chooseOutput (sampleDevices (), "CADefaultDeviceAggregate-1-2", "").requestedMissing);
    // and with no devices at all
    CHECK (bridge::chooseOutput ({}, "BuiltInSpeakerDevice", "").requestedMissing);
}

TEST (audio_choice_environment_wins_over_the_saved_device)
{
    const auto devices { sampleDevices () };
    auto choice { bridge::chooseOutput (devices, "AppleUSBAudioEngine:Vendor:P1:1234:1,2", "BuiltInSpeakerDevice") };
    CHECK (choice.source == bridge::OutputSource::environment);
    CHECK (choice.deviceId == 117);

    // "default" forces the system default whatever audio.json says
    choice = bridge::chooseOutput (devices, "AppleUSBAudioEngine:Vendor:P1:1234:1,2", bridge::kSystemDefaultOutputUid);
    CHECK (choice.source == bridge::OutputSource::environment);
    CHECK (choice.deviceId == 0);
    CHECK (! choice.requestedMissing);

    // an environment UID that is not connected falls back (it does not fall through to the saved device)
    choice = bridge::chooseOutput (devices, "AppleUSBAudioEngine:Vendor:P1:1234:1,2", "NoSuchDevice");
    CHECK (choice.deviceId == 0);
    CHECK (choice.requestedMissing);
    CHECK (bridge::outputStatusText (choice, devices, 117) == "Output: System default (requested device not available)");
}

TEST (audio_status_names_an_explicit_default_device_by_name)
{
    // choosing the device that is also the default is still an explicit choice
    const auto choice { bridge::chooseOutput (sampleDevices (), "BuiltInSpeakerDevice", "") };
    CHECK (choice.deviceId == 117);
    CHECK (bridge::outputStatusText (choice, sampleDevices (), 117) == "Output: MacBook Pro Speakers");
}

TEST (audio_output_check)
{
    CHECK (bridge::outputLooksDead (0, true));
    CHECK (bridge::outputLooksDead (12, false));
    CHECK (! bridge::outputLooksDead (12, true));
}

TEST (audio_settings_round_trip)
{
    const std::string dir { makeTempDir ("audioset") };
    const std::string path { dir + "/nested/folder/audio.json" };   // the folder is created
    bridge::AudioSettings settings;
    std::string error;

    // missing file: system default, no error
    settings.outputUID = "stale";
    CHECK (bridge::loadAudioSettings (path, settings, error));
    CHECK (settings.outputUID.empty () && error.empty ());

    bridge::AudioSettings saved;
    saved.outputUID = "AppleUSBAudioEngine:Vendor:P1:1234:1,2 \"quoted\" \\ and ümlaut";
    saved.outputName = "P1 \"Studio\"";
    REQUIRE (bridge::saveAudioSettings (path, saved, error));
    CHECK (error.empty ());
    CHECK (! std::filesystem::exists (path + ".tmp"));
    CHECK (bridge::loadAudioSettings (path, settings, error));
    CHECK (settings.outputUID == saved.outputUID);
    CHECK (settings.outputName == saved.outputName);
    CHECK (readTextFile (path).find ("\"outputUID\"") != std::string::npos);

    // the system default writes {}
    REQUIRE (bridge::saveAudioSettings (path, {}, error));
    CHECK (readTextFile (path).find ("outputUID") == std::string::npos);
    CHECK (bridge::loadAudioSettings (path, settings, error));
    CHECK (settings.outputUID.empty () && settings.outputName.empty ());
}

TEST (audio_settings_corrupt_files_mean_system_default)
{
    const std::string dir { makeTempDir ("audioset2") };
    const std::string path { dir + "/audio.json" };
    bridge::AudioSettings settings;
    std::string error;

    for (const char* text : { "not json", "[]", "", R"({"outputUID": 5})", R"({"outputUID": true})", R"({"outputUID": ["x"]})",
                              R"({"outputUID": "x", "outputName": 3})", R"({"outputUID": "a\u0000b"})" })
    {
        writeTextFile (path, text);
        settings.outputUID = "stale";
        CHECK (! bridge::loadAudioSettings (path, settings, error));
        CHECK (settings.outputUID.empty ());
        CHECK (! error.empty ());
    }

    // null and unknown keys are fine
    writeTextFile (path, R"({"outputUID": null, "other": 1})");
    CHECK (bridge::loadAudioSettings (path, settings, error));
    CHECK (settings.outputUID.empty () && error.empty ());
    writeTextFile (path, R"({"outputUID": "dev", "future": {"a": 1}})");
    CHECK (bridge::loadAudioSettings (path, settings, error));
    CHECK (settings.outputUID == "dev");
    // a name without a UID is dropped
    writeTextFile (path, R"({"outputName": "P1"})");
    CHECK (bridge::loadAudioSettings (path, settings, error));
    CHECK (settings.outputName.empty ());

    // saving replaces a corrupt file
    writeTextFile (path, "{{{");
    bridge::AudioSettings saved;
    saved.outputUID = "BuiltInSpeakerDevice";
    REQUIRE (bridge::saveAudioSettings (path, saved, error));
    CHECK (bridge::loadAudioSettings (path, settings, error));
    CHECK (settings.outputUID == "BuiltInSpeakerDevice");

    // a folder is not a settings file
    std::filesystem::create_directories (dir + "/folder.json");
    CHECK (! bridge::loadAudioSettings (dir + "/folder.json", settings, error));
    CHECK (! error.empty ());

    // a NUL in a value is refused before anything is written
    saved.outputUID = std::string ("a\0b", 3);
    CHECK (! bridge::saveAudioSettings (path, saved, error));
    CHECK (bridge::loadAudioSettings (path, settings, error));
    CHECK (settings.outputUID == "BuiltInSpeakerDevice");
}

TEST (audio_settings_write_failure_says_why)
{
    const std::string dir { makeTempDir ("audioset3") };
    writeTextFile (dir + "/file", "x");
    std::string error;
    bridge::AudioSettings saved;
    saved.outputUID = "dev";
    CHECK (! bridge::saveAudioSettings (dir + "/file/audio.json", saved, error));     // the folder is a file
    CHECK (! error.empty ());
}

TEST (default_audio_settings_path_is_in_application_support)
{
    const std::string path { bridge::defaultAudioSettingsPath () };
    const char* home { std::getenv ("HOME") };
    CHECK (home != nullptr && path.rfind (home, 0) == 0);
    const std::string tail { "/Library/Application Support/ARABridge/audio.json" };
    CHECK (path.size () > tail.size () && path.compare (path.size () - tail.size (), tail.size (), tail) == 0);
}

// The machine's real devices (no audio is played). A Mac without any output device only prints that.
TEST (audio_real_devices_are_listed)
{
    const auto devices { bridge::listAudioDevices () };
    const uint32_t defaultId { bridge::defaultOutputDeviceId () };
    std::printf ("    %s\n", bridge::describeAudioDevices (devices, defaultId, 0).c_str ());
    if (defaultId == 0)
        return;
    const bridge::OutputDevice* found { bridge::findDeviceById (devices, defaultId) };
    REQUIRE (found != nullptr);
    CHECK (bridge::isSelectableOutput (*found));
    CHECK (! found->uid.empty ());
    CHECK (found->sampleRate > 0.0);
    // the default output can be found again by its UID
    CHECK (bridge::chooseOutput (devices, found->uid, "").deviceId == defaultId);
}
