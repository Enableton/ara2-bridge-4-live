# Bridge Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Bridge Host macOS app: it takes a job folder (clip + plug-in choice), opens Melodyne or VocAlign as an ARA plug-in with a playable editor window, and on "Apply to Live" renders the edited audio offline, realigns it after Melodyne edits, and writes `result.wav` + `result.json`.

**Architecture:** Pure C++/ObjC++ libraries (WAV I/O, realignment, job files, audio decoding, plug-in discovery) are built and tested standalone with CMake. The host app itself is built inside Celemony's ARA SDK CMake project as an extra target (`BridgeHost`), reusing the SDK's TestHost ARA host classes and the spike's patched VST3 loader. The app has a headless mode (`--autorender`) and a Cocoa UI mode.

**Tech Stack:** C++17, Objective-C++ (Cocoa, AVFoundation, AudioToolbox), CMake + Xcode generator, Celemony ARA SDK (Apache 2.0), Steinberg VST3 SDK, Python 3 (+ numpy) for helper scripts.

**Spec:** `docs/superpowers/specs/2026-10-22-ara-bridge-design.md`

**Scope of this plan:** spec milestones 1–3 (host core, playback + Apply/Cancel, realignment) and the VocAlign host flow. The M4L device (milestones 4–6) and the retail-install check (milestone 7) get their own plan, written after Task 14, because they depend on two Live facts that still need confirming (take-lane creation and launching the host from Max).

## Deviations from the spec (decided while planning)

1. **Build order:** the realignment module (spec milestone 3) is built first. It is pure code with no dependencies and is the best fit for test-first work.
2. **`job.json` fields:** the host ignores `sampleRate`, `channels` and `live.trackIndex` (it decodes those from the audio file; the device keeps `trackIndex` for itself). Unknown keys are tolerated.
3. **Cancel behaviour:** closing the window or pressing Cancel writes `result.json` with `status: "cancelled"` (the spec said nothing is written). A crash still writes nothing. A *failed* Apply in the UI does not write `result.json`, so you can retry.
4. **Fractional shifts (found during Task 3 review):** the real Melodyne tail shift is fractional (about 30.75 samples, not 31). `ShiftSegment::shift` is a `double`, detection refines to a fractional shift and ignores one-window segments, and Task 4 moves audio with a windowed-sinc fractional delay. The acceptance limit of 1e-5 in Task 5 is replaced by measured relative-error limits. See the spec, section 7.
5. **Playback and Melodyne:** to hear audio, the editor instance must be bound with all three ARA roles for Melodyne too (the spike used only the editor-view role for Melodyne). Task 12 re-checks that editing still works.
6. **Task 10 (host core) as built:** the code below Task 10 was written before these changes; the real headers win.
   1. `ApplyJob` lives in the SDK-free `host/hostcore/` (unit tested in `bridge_tests`) and takes a render callback (`RenderFunction`: rendered audio, error, diagnostics) instead of the plug-in entry and document. Also in `hostcore/`: `JobLayout`, `RunGuard`, `Options`, `RenderRepair`.
   2. Regions are snapped to the sample grid: start/end markers and the guide/dub offset from beats are rounded to whole frames (half away from zero); an end up to 1 ms past the file is cut at the file end. `result.wav` has exactly `round(end*sr) - round(start*sr)` frames.
   3. Crash fallback: `result.json` with status error is prepared up front and published (with `link()`, never over a real result) on a crash signal, a second stop signal, a hung render after the grace time or the SIGALRM watchdog. This replaces "a crash still writes nothing" in deviation 3.
   4. Headless time budget 300 s + 4 s per second of audio (`ARABRIDGE_TIMEOUT_SEC` overrides it), grace time timeout/4 (1..15 s), SIGALRM backstop, 30 s teardown alarm. Exit codes (hostcore/Options.h): 0 ok, 1 cancelled, 2 usage/bad job/result exists, 3 plug-in, 4 audio, 5 render, 6 stopped or timed out. SIGPIPE is ignored. The device trusts `result.json`, not the exit code.
   5. A job whose `result.json` already exists is refused (exit 2, nothing written); `result.wav` is written to a temp file and renamed.
   6. Only mono and stereo clips are accepted; guide and dub must share a sample rate.
   7. The licence is checked without a dialog (`isLicensedForCapabilities(false)`; the window mode may show the dialog) and the analysis is requested directly, not through the SDK helper that turns the process into a foreground app. Headless mode waits for the analysis to finish.
   8. Melodyne doubled-sample repair (spec 2.1): Melodyne is rendered twice (block sizes 4096 and 3001, the second with a pre-roll) and frames with the doubled-sample signature are repaired; `renderJobClip` (host/app/JobRender) does this for headless mode and the window's Apply alike. The grids stay apart for regions up to 12,288,000 frames (about 4.6 min at 44.1 kHz, 4.3 min at 48 kHz, 2.1 min at 96 kHz). "Doubled" means within 1% of the level plus twice the largest render difference one or two frames away; "the neighbours agree" means those differences are below 25% of the difference at the frame.
   9. `result.json` gains `diagnostics` (logs only), `sourceStartFrame`, `frames` and `sampleRate`; `writeResult` has an exclusive mode.
   10. Test and diagnosis environment: `ARABRIDGE_SETTINGS`, `ARABRIDGE_PLUGIN_DIRS`, `ARABRIDGE_TIMEOUT_SEC`, `ARABRIDGE_TEST_HANG`.
7. **Task 11 (window) as built:** Apply runs from a run loop timer with an event-pumping idle and a blocking sheet (not in a main-queue block), waits for the analysis first and can be stopped (Cancel, close, Quit, signal, budget); the app ends with `[NSApp stop:]` so teardown runs in order; a stop signal in the window writes `status: "cancelled"` (message "stopped by SIGTERM ...") with exit code 6; Quit goes to the delegate directly because `terminate:` is inert while a sheet is shown; `applyJob` publishes `result.json` exclusively. Test hooks `ARABRIDGE_TEST_AUTOPLAY`, `ARABRIDGE_TEST_AUTOAPPLY`, `ARABRIDGE_TEST_AUTOCANCEL`. After the review: `notifyModelUpdates` polling and the plug-in's transport requests (two SDK patch additions), a quit before the window opens writes `cancelled` (early quit handler + exit fallback), audio restarts after a device change, Escape cancels through the responder chain, realign notes go to `diagnostics`. Details in Task 11. After the first manual test: Melodyne passes Space up unused and sends no ARA transport request, so the window itself turns an unused plain Space into Play/Stop (`hostcore/TransportKey`, no double toggle with a plug-in request within 150 ms); Escape is forwarded to Cancel by the window class. After the first test from Live (no sound: the host played to the system default, MacBook Pro Speakers, while the user's monitors are on Live's interface P1): an **Output** menu in the window's bar (`hostcore/AudioOutput`, `audio/OutputDevices`, `audio.json` in Application Support, `ARABRIDGE_AUDIO_OUTPUT_UID`), the device list in the log and the output in the status line, and an output check 500 ms after Play (Task 11 Step 2 item 16).
8. **ARA assert policy (final review):** headless (`--autorender`) keeps `ARA::ARAInterfaceAssert`, so any ARA API validation failure (the host's `ARA_VALIDATE_*` checks or the plug-in's, reported through the assert function passed to `initializeARA`) aborts and the crash fallback writes an error `result.json`, which is what a script wants. In window mode an abort would lose the user's editing session, so `main.mm` installs `logAraAssertAndContinue` instead: it logs to stderr and the unified log (`ARA API violation #N (...) (continuing)`; the first 20, then every 100th) and the call goes on. A plug-in built without NDEBUG may replace the shared assert function during `initializeARA` (ARAPlug.cpp); window mode then sets its own again and logs that (neither Melodyne nor VocAlign does it). `ARA_INTERNAL_ASSERT` (the SDK's internal checks, `ARAHandleAssert`) still aborts in both modes. Test hook `ARABRIDGE_TEST_ARA_ASSERT=1`: window (Melodyne and VocAlign) -> logged, job goes on (cancelled, exit 1); headless -> SIGABRT, `result.json` error "BridgeHost crashed (SIGABRT) ...", exit 134.
9. **Final review fixes** (the host/device contract is in `docs/superpowers/specs/2026-10-23-host-device-contract.md`):
   1. UI text is UTF-8: `common/NSText.h` (`ns()`, `utf8()`); never `stringWithFormat: @"%s"` (it reads Mac Roman). The window title is logged.
   2. The plug-in's transport requests may come from any non-render thread (Task 11 Step 2 item 10).
   3. A relative clip path is a bad job (exit 2).
   4. `BridgeHost --version` ("BridgeHost <git describe> job-protocol 1"), `BridgeHost --find-plugins` (JSON), `tools/install_host.sh` (to `~/Library/Application Support/ARABridge/bin/BridgeHost`). settings.json may carry `hostPath` for the device; the host ignores it.
   5. ok results carry `realign.reason` (`applied`, `nothing-to-do`, `no-confident-match`, `not-requested`); spec section 7, step 5.
   6. Patch identifiers renamed from the spike's `Spike*` to `Bridge*`.
   7. **Known limitation, not fixed:** the realignment runs on the main thread inside Apply, after the render (about 4-6 s per 4 minutes of audio). The window does not respond meanwhile (Cancel, Quit and a first SIGTERM take effect after it, when the ok result is written), and no watchdog covers it in window mode (the Apply budget is checked in the render's idle function only). Headless, the SIGALRM watchdog covers it. Moving realign to a worker thread is left for later.
   8. Left for the device plan: a SIGUSR1 handler that brings the window to the front and `host.json` {pid, startedAt} in the job folder (contract, "Concurrency and focus").

## File Structure

As built after the final review:

```
.gitignore
host/
  CMakeLists.txt                 # standalone libs, tests and tools
  common/Wav.h, Wav.cpp          # planar float Audio, WAV read/write, crop
  common/NSText.h                # std::string <-> NSString as UTF-8 (Objective-C++, header only)
  realign/Realign.h, Realign.cpp # shift detection + realignment
  jobio/Job.h, Job.mm            # job.json / result.json / settings.json
  audio/AudioDecode.h, .mm       # any audio file -> planar float (ExtAudioFile)
  plugins/PlugInFinder.h, .cpp   # locate Melodyne / VocAlign VST3 bundles
  hostcore/                      # SDK-free host logic, unit tested
    JobLayout.h, .cpp            #   regions on the sample grid, render span
    ApplyJob.h, .cpp             #   render callback -> realign -> result.wav + result.json
    RunGuard.h, .cpp             #   signal handlers, fallback result.json, watchdog, exit fallback
    Options.h, .cpp              #   command line, exit codes
    RenderRepair.h, .cpp         #   Melodyne doubled-sample repair
    TransportKey.h, .cpp         #   Space as Play/Stop vs. the plug-in's transport requests
    Commands.h, .cpp             #   --version and --find-plugins output
  tools/wavdiff.cpp, realign_tool.cpp
  tests/check.h, test_main.cpp, testutil.h
  tests/test_wav.cpp, test_realign.cpp, test_job.cpp, test_decode.cpp, test_finder.cpp,
        test_layout.cpp, test_apply.cpp, test_runguard.cpp, test_repair.cpp,
        test_transportkey.cpp, test_commands.cpp, test_text.mm
  tests/fixtures/spike_original_2_8s.wav, spike_edited_2_8s.wav
  tests/headless_roundtrip.sh, headless_failures.sh
  patches/ara-examples-bridgehost.patch   # our changes to the SDK's example code
  app/                            # BridgeHost target (built via the SDK CMake project)
    BridgeHost.cmake
    BuildInfo.cpp.in              # the build --version names (configure_file)
    MemoryAudioFile.h
    BridgeDocument.h, BridgeDocument.cpp
    OfflineRenderer.h, OfflineRenderer.cpp
    JobRender.h, JobRender.cpp    # one or two renders + doubled-sample repair (headless and Apply)
    Playback.h, Playback.mm
    HostApp.h, HostApp.mm
    main.mm
tools/
  setup_sdk.sh, build_host.sh, build_tests.sh, install_host.sh
  make_test_job.py, make_realign_fixtures.py, make_dub.py
  check_edit.py, measure_alignment.py
```

Each file has one job. `app/` files depend on the SDK; everything else builds without it.

---

## Task 1: Repository setup

**Files:**
- Create: `.gitignore`

- [ ] **Step 1: Initialise git and ignore generated and third-party files**

```bash
cd <repo>
git init
cat > .gitignore <<'EOF'
third_party/
third_party_spike_backup/
build/
*.xcodeproj/
.DS_Store
# job outputs from manual tests
spike/out*/
EOF
```

- [ ] **Step 2: Commit the existing design documents and spike sources**

```bash
git add .gitignore docs spike/EditHost
git commit -m "chore: initial commit with design spec, plan and spike host sources"
```

Expected: a commit listing `docs/...`, `spike/EditHost/EditHost.mm`, `spike/EditHost/EditHost.cmake`.

---

## Part A: Realignment module (pure C++, standalone)

## Task 2: Test harness, WAV I/O and crop

**Files:**
- Create: `host/CMakeLists.txt`
- Create: `host/tests/check.h`, `host/tests/test_main.cpp`, `host/tests/testutil.h`
- Create: `host/common/Wav.h`, `host/common/Wav.cpp`
- Test: `host/tests/test_wav.cpp`

- [ ] **Step 1: Create the test harness**

`host/tests/check.h`:

```cpp
#pragma once

#include <cmath>
#include <cstdio>
#include <functional>
#include <utility>
#include <vector>

struct TestCase
{
    const char* name;
    std::function<void ()> run;
};

std::vector<TestCase>& allTests ();
extern int gFailures;

struct TestRegistrar
{
    TestRegistrar (const char* name, std::function<void ()> run) { allTests ().push_back ({ name, std::move (run) }); }
};

#define TEST(name)                                          \
    static void name ();                                    \
    static TestRegistrar registrar_##name (#name, name);    \
    static void name ()

#define CHECK(cond)                                                                              \
    do                                                                                           \
    {                                                                                            \
        if (! (cond))                                                                            \
        {                                                                                        \
            std::printf ("    CHECK failed %s:%d: %s\n", __FILE__, __LINE__, #cond);             \
            ++gFailures;                                                                         \
        }                                                                                        \
    } while (0)

#define CHECK_NEAR(a, b, eps)                                                                    \
    do                                                                                           \
    {                                                                                            \
        const double va_ = (a), vb_ = (b);                                                       \
        if (! (std::fabs (va_ - vb_) <= (eps)))                                                  \
        {                                                                                        \
            std::printf ("    CHECK_NEAR failed %s:%d: %s=%g vs %s=%g\n", __FILE__, __LINE__, #a, va_, #b, vb_); \
            ++gFailures;                                                                         \
        }                                                                                        \
    } while (0)
```

`host/tests/test_main.cpp`:

```cpp
#include "check.h"

#include <cstring>

std::vector<TestCase>& allTests ()
{
    static std::vector<TestCase> tests;
    return tests;
}

int gFailures = 0;

int main (int argc, char** argv)
{
    const char* filter { argc > 1 ? argv[1] : nullptr };
    int ran { 0 };
    for (auto& test : allTests ())
    {
        if (filter && ! std::strstr (test.name, filter))
            continue;
        std::printf ("[ RUN  ] %s\n", test.name);
        const int before { gFailures };
        test.run ();
        std::printf (gFailures == before ? "[  OK  ] %s\n" : "[ FAIL ] %s\n", test.name);
        ++ran;
    }
    std::printf ("%d test(s), %d failure(s)\n", ran, gFailures);
    return gFailures == 0 ? 0 : 1;
}
```

`host/tests/testutil.h`:

```cpp
#pragma once

#include <filesystem>
#include <fstream>
#include <string>
#include <unistd.h>

// A fresh, empty temporary directory, removed and recreated if it already exists.
inline std::string makeTempDir (const std::string& tag)
{
    const auto path = std::filesystem::temp_directory_path () / ("bridge_test_" + tag + "_" + std::to_string (getpid ()));
    std::filesystem::remove_all (path);
    std::filesystem::create_directories (path);
    return path.string ();
}

inline void writeTextFile (const std::string& path, const std::string& text)
{
    std::ofstream file (path, std::ios::binary);
    file << text;
}
```

- [ ] **Step 2: Create the top-level CMake project**

`host/CMakeLists.txt`:

```cmake
cmake_minimum_required(VERSION 3.19)
project(BridgeHostLibs LANGUAGES C CXX OBJCXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

add_library(bridge_core STATIC
    common/Wav.cpp
)
target_include_directories(bridge_core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")

add_executable(bridge_tests
    tests/test_main.cpp
    tests/test_wav.cpp
)
target_link_libraries(bridge_tests PRIVATE bridge_core)
target_compile_definitions(bridge_tests PRIVATE BRIDGE_TEST_DIR="${CMAKE_CURRENT_SOURCE_DIR}/tests")

enable_testing()
add_test(NAME bridge_tests COMMAND bridge_tests)
```

(Later tasks add sources to `bridge_core` and `bridge_tests` and add the tool executables.)

- [ ] **Step 3: Write the failing WAV tests**

`host/tests/test_wav.cpp`:

```cpp
#include "check.h"
#include "testutil.h"

#include "common/Wav.h"

#include <cstdint>
#include <string>
#include <vector>

namespace
{
    bridge::Audio makeStereoRamp (int frames)
    {
        bridge::Audio audio;
        audio.sampleRate = 48000;
        audio.channels.assign (2, std::vector<float> (static_cast<size_t> (frames)));
        for (int i = 0; i < frames; ++i)
        {
            audio.channels[0][static_cast<size_t> (i)] = static_cast<float> (i) / static_cast<float> (frames);
            audio.channels[1][static_cast<size_t> (i)] = -static_cast<float> (i) / static_cast<float> (frames);
        }
        return audio;
    }

    void put16 (std::string& s, uint16_t v) { s.push_back (static_cast<char> (v & 0xFF)); s.push_back (static_cast<char> (v >> 8)); }
    void put32 (std::string& s, uint32_t v) { put16 (s, static_cast<uint16_t> (v & 0xFFFF)); put16 (s, static_cast<uint16_t> (v >> 16)); }
}

TEST (wav_float32_roundtrip_is_exact)
{
    const std::string dir { makeTempDir ("wav") };
    const bridge::Audio original { makeStereoRamp (1000) };
    std::string error;

    CHECK (bridge::writeWavFloat32 (dir + "/a.wav", original, error));

    bridge::Audio loaded;
    CHECK (bridge::readWav (dir + "/a.wav", loaded, error));
    CHECK (loaded.sampleRate == 48000);
    CHECK (loaded.channelCount () == 2);
    CHECK (loaded.frames () == 1000);
    CHECK (loaded.channels == original.channels);
}

TEST (wav_reads_16_bit_pcm)
{
    const std::string dir { makeTempDir ("wav16") };

    // mono, 44100 Hz, 3 samples: 0, 16384, -32768
    std::string bytes;
    bytes += "RIFF";
    put32 (bytes, 36 + 6);
    bytes += "WAVEfmt ";
    put32 (bytes, 16);
    put16 (bytes, 1);        // PCM
    put16 (bytes, 1);        // channels
    put32 (bytes, 44100);
    put32 (bytes, 44100 * 2);
    put16 (bytes, 2);
    put16 (bytes, 16);
    bytes += "data";
    put32 (bytes, 6);
    put16 (bytes, 0);
    put16 (bytes, 16384);
    put16 (bytes, 0x8000);
    writeTextFile (dir + "/pcm16.wav", bytes);

    bridge::Audio audio;
    std::string error;
    CHECK (bridge::readWav (dir + "/pcm16.wav", audio, error));
    CHECK (audio.sampleRate == 44100);
    CHECK (audio.frames () == 3);
    CHECK_NEAR (audio.channels[0][0], 0.0, 1e-9);
    CHECK_NEAR (audio.channels[0][1], 0.5, 1e-9);
    CHECK_NEAR (audio.channels[0][2], -1.0, 1e-9);
}

TEST (wav_rejects_garbage)
{
    const std::string dir { makeTempDir ("wavbad") };
    writeTextFile (dir + "/bad.wav", "this is not a wav file at all");

    bridge::Audio audio;
    std::string error;
    CHECK (! bridge::readWav (dir + "/bad.wav", audio, error));
    CHECK (! error.empty ());
    CHECK (! bridge::readWav (dir + "/missing.wav", audio, error));
}

TEST (wav_crop_copies_a_range_and_zero_pads)
{
    const bridge::Audio ramp { makeStereoRamp (10) };

    const bridge::Audio inside { bridge::cropAudio (ramp, 2, 3) };
    CHECK (inside.frames () == 3);
    CHECK (inside.sampleRate == 48000);
    CHECK_NEAR (inside.channels[0][0], 0.2, 1e-6);
    CHECK_NEAR (inside.channels[1][2], -0.4, 1e-6);

    const bridge::Audio padded { bridge::cropAudio (ramp, 8, 5) };
    CHECK (padded.frames () == 5);
    CHECK_NEAR (padded.channels[0][1], 0.9, 1e-6);
    CHECK_NEAR (padded.channels[0][2], 0.0, 1e-9);
    CHECK_NEAR (padded.channels[0][4], 0.0, 1e-9);
}
```

- [ ] **Step 4: Run the tests to verify they fail**

```bash
cd <repo>
cmake -S host -B build/host-tests -DCMAKE_BUILD_TYPE=Release
cmake --build build/host-tests -j 2>&1 | tail -5
```

Expected: build FAILS with `fatal error: 'common/Wav.h' file not found`.

- [ ] **Step 5: Implement the WAV module**

`host/common/Wav.h`:

```cpp
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace bridge
{
    // Planar float audio: channels[c][frame].
    struct Audio
    {
        int sampleRate { 44100 };
        std::vector<std::vector<float>> channels;

        int channelCount () const { return static_cast<int> (channels.size ()); }
        size_t frames () const { return channels.empty () ? 0 : channels[0].size (); }
    };

    // Reads 16/24/32-bit integer PCM and 32-bit float WAV files.
    bool readWav (const std::string& path, Audio& out, std::string& error);

    // Writes a 32-bit float WAV file.
    bool writeWavFloat32 (const std::string& path, const Audio& audio, std::string& error);

    // Copies frameCount frames starting at startFrame; anything outside the source is zero.
    Audio cropAudio (const Audio& audio, int64_t startFrame, int64_t frameCount);
}
```

`host/common/Wav.cpp`:

```cpp
#include "common/Wav.h"

#include <cstring>
#include <fstream>
#include <iterator>

namespace bridge
{
    namespace
    {
        uint16_t rd16 (const uint8_t* p) { return static_cast<uint16_t> (p[0] | (p[1] << 8)); }

        uint32_t rd32 (const uint8_t* p)
        {
            return static_cast<uint32_t> (p[0]) | (static_cast<uint32_t> (p[1]) << 8) | (static_cast<uint32_t> (p[2]) << 16) | (static_cast<uint32_t> (p[3]) << 24);
        }

        void wr16 (std::ostream& s, uint16_t v)
        {
            const char b[2] { static_cast<char> (v & 0xFF), static_cast<char> ((v >> 8) & 0xFF) };
            s.write (b, 2);
        }

        void wr32 (std::ostream& s, uint32_t v)
        {
            const char b[4] { static_cast<char> (v & 0xFF), static_cast<char> ((v >> 8) & 0xFF), static_cast<char> ((v >> 16) & 0xFF), static_cast<char> ((v >> 24) & 0xFF) };
            s.write (b, 4);
        }
    }

    bool readWav (const std::string& path, Audio& out, std::string& error)
    {
        std::ifstream file (path, std::ios::binary);
        if (! file)
        {
            error = "cannot open " + path;
            return false;
        }
        const std::vector<uint8_t> d { std::istreambuf_iterator<char> (file), std::istreambuf_iterator<char> () };
        if (d.size () < 12 || std::memcmp (d.data (), "RIFF", 4) != 0 || std::memcmp (d.data () + 8, "WAVE", 4) != 0)
        {
            error = path + " is not a RIFF/WAVE file";
            return false;
        }

        uint16_t format { 0 }, channels { 0 }, bits { 0 };
        uint32_t rate { 0 };
        const uint8_t* data { nullptr };
        size_t dataSize { 0 };

        size_t pos { 12 };
        while (pos + 8 <= d.size ())
        {
            const uint32_t size { rd32 (&d[pos + 4]) };
            const uint8_t* body { &d[pos + 8] };
            if (std::memcmp (&d[pos], "fmt ", 4) == 0 && size >= 16 && pos + 8 + 16 <= d.size ())
            {
                format = rd16 (body);
                channels = rd16 (body + 2);
                rate = rd32 (body + 4);
                bits = rd16 (body + 14);
                if (format == 0xFFFE && size >= 26 && pos + 8 + 26 <= d.size ())
                    format = rd16 (body + 24);      // WAVE_FORMAT_EXTENSIBLE: real format is the sub-format
            }
            else if (std::memcmp (&d[pos], "data", 4) == 0)
            {
                data = body;
                dataSize = std::min<size_t> (size, d.size () - pos - 8);
                break;
            }
            pos += 8 + static_cast<size_t> (size) + (size & 1U);
        }

        const bool supported { (format == 3 && bits == 32) || (format == 1 && (bits == 16 || bits == 24 || bits == 32)) };
        if (data == nullptr || channels == 0 || ! supported)
        {
            error = path + ": unsupported or incomplete WAV (format " + std::to_string (format) + ", " + std::to_string (bits) + " bits)";
            return false;
        }

        const size_t bytesPerSample { bits / 8U };
        const size_t frames { dataSize / (bytesPerSample * channels) };
        out.sampleRate = static_cast<int> (rate);
        out.channels.assign (channels, std::vector<float> (frames));
        for (size_t f { 0 }; f < frames; ++f)
        {
            for (size_t c { 0 }; c < channels; ++c)
            {
                const uint8_t* p { data + (f * channels + c) * bytesPerSample };
                float v { 0.0f };
                if (format == 3)
                {
                    std::memcpy (&v, p, 4);
                }
                else if (bits == 16)
                {
                    v = static_cast<float> (static_cast<int16_t> (rd16 (p))) / 32768.0f;
                }
                else if (bits == 24)
                {
                    int32_t s { p[0] | (p[1] << 8) | (p[2] << 16) };
                    if ((s & 0x800000) != 0)
                        s -= 0x1000000;
                    v = static_cast<float> (s) / 8388608.0f;
                }
                else
                {
                    v = static_cast<float> (static_cast<int32_t> (rd32 (p))) / 2147483648.0f;
                }
                out.channels[c][f] = v;
            }
        }
        return true;
    }

    bool writeWavFloat32 (const std::string& path, const Audio& audio, std::string& error)
    {
        std::ofstream file (path, std::ios::binary);
        if (! file)
        {
            error = "cannot write " + path;
            return false;
        }
        const uint32_t channels { static_cast<uint32_t> (audio.channelCount ()) };
        const uint32_t frames { static_cast<uint32_t> (audio.frames ()) };
        const uint32_t rate { static_cast<uint32_t> (audio.sampleRate) };
        const uint32_t dataBytes { frames * channels * 4U };

        file.write ("RIFF", 4);
        wr32 (file, 36U + dataBytes);
        file.write ("WAVEfmt ", 8);
        wr32 (file, 16U);
        wr16 (file, 3U);                                // IEEE float
        wr16 (file, static_cast<uint16_t> (channels));
        wr32 (file, rate);
        wr32 (file, rate * channels * 4U);
        wr16 (file, static_cast<uint16_t> (channels * 4U));
        wr16 (file, 32U);
        file.write ("data", 4);
        wr32 (file, dataBytes);

        std::vector<float> block (channels);
        for (uint32_t f { 0 }; f < frames; ++f)
        {
            for (uint32_t c { 0 }; c < channels; ++c)
                block[c] = audio.channels[c][f];
            file.write (reinterpret_cast<const char*> (block.data ()), static_cast<std::streamsize> (channels * 4U));
        }
        if (! file)
        {
            error = "write failed for " + path;
            return false;
        }
        return true;
    }

    Audio cropAudio (const Audio& audio, int64_t startFrame, int64_t frameCount)
    {
        Audio result;
        result.sampleRate = audio.sampleRate;
        result.channels.assign (audio.channels.size (), std::vector<float> (static_cast<size_t> (frameCount), 0.0f));
        for (size_t c { 0 }; c < audio.channels.size (); ++c)
        {
            for (int64_t i { 0 }; i < frameCount; ++i)
            {
                const int64_t source { startFrame + i };
                if (source >= 0 && source < static_cast<int64_t> (audio.channels[c].size ()))
                    result.channels[c][static_cast<size_t> (i)] = audio.channels[c][static_cast<size_t> (source)];
            }
        }
        return result;
    }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cmake --build build/host-tests -j 2>&1 | tail -3 && build/host-tests/bridge_tests
```

Expected output ends with: `4 test(s), 0 failure(s)` and every test shows `[  OK  ]`.

- [ ] **Step 7: Commit**

```bash
git add host/CMakeLists.txt host/common host/tests
git commit -m "feat: add WAV I/O, crop and test harness"
```

---

## Task 3: Realign — shift detection

**Files:**
- Create: `host/realign/Realign.h`, `host/realign/Realign.cpp`
- Modify: `host/CMakeLists.txt` (add `realign/Realign.cpp` to `bridge_core`, `tests/test_realign.cpp` to `bridge_tests`)
- Test: `host/tests/test_realign.cpp`

- [ ] **Step 1: Write the failing tests for `detectShifts`**

`host/tests/test_realign.cpp` (the helper functions here are reused by Task 4's tests, so keep them at the top):

```cpp
#include "check.h"

#include "realign/Realign.h"

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <string>
#include <vector>

namespace
{
    const double kPi { 3.14159265358979323846 };

    // A gliding two-tone signal with a slow envelope and a little deterministic noise,
    // so correlation has one sharp peak (no periodic ambiguity).
    bridge::Audio makeSignal (int sampleRate, double seconds, int channels, uint32_t seed)
    {
        bridge::Audio audio;
        audio.sampleRate = sampleRate;
        const size_t frames { static_cast<size_t> (seconds * sampleRate) };
        audio.channels.assign (static_cast<size_t> (channels), std::vector<float> (frames));
        for (int c { 0 }; c < channels; ++c)
        {
            uint32_t state { seed + static_cast<uint32_t> (c) * 7919U };
            for (size_t i { 0 }; i < frames; ++i)
            {
                state = state * 1664525U + 1013904223U;
                const double noise { static_cast<double> (state >> 8) / 8388608.0 - 1.0 };
                const double t { static_cast<double> (i) / sampleRate };
                const double envelope { 0.6 + 0.4 * std::sin (2.0 * kPi * 1.7 * t) };
                const double tone { 0.3 * std::sin (2.0 * kPi * (200.0 * t + 30.0 * t * t)) + 0.2 * std::sin (2.0 * kPi * (400.0 * t + 60.0 * t * t)) };
                audio.channels[static_cast<size_t> (c)][i] = static_cast<float> (envelope * tone + 0.05 * noise);
            }
        }
        return audio;
    }

    // Mimics what Melodyne did in the spike: [editStart, editEnd) is a different (edited) tone and
    // everything after it is the original moved 'early' samples EARLIER (negative: later).
    bridge::Audio makeRender (const bridge::Audio& original, int64_t editStart, int64_t editEnd, int early)
    {
        bridge::Audio render { original };
        const int64_t frames { static_cast<int64_t> (original.frames ()) };
        for (size_t c { 0 }; c < render.channels.size (); ++c)
        {
            for (int64_t i { 0 }; i < frames; ++i)
            {
                if (i >= editEnd)
                {
                    const int64_t source { i + early };
                    render.channels[c][static_cast<size_t> (i)] = (source >= 0 && source < frames) ? original.channels[c][static_cast<size_t> (source)] : 0.0f;
                }
                else if (i >= editStart)
                {
                    render.channels[c][static_cast<size_t> (i)] = static_cast<float> (0.4 * std::sin (2.0 * kPi * 330.0 * static_cast<double> (i) / original.sampleRate));
                }
            }
        }
        return render;
    }

    // Audio with nothing in common with makeSignal(): a steady 517 Hz tone plus noise.
    bridge::Audio makeUnrelated (int sampleRate, double seconds, uint32_t seed)
    {
        bridge::Audio audio;
        audio.sampleRate = sampleRate;
        const size_t frames { static_cast<size_t> (seconds * sampleRate) };
        audio.channels.assign (1, std::vector<float> (frames));
        uint32_t state { seed };
        for (size_t i { 0 }; i < frames; ++i)
        {
            state = state * 1664525U + 1013904223U;
            const double noise { static_cast<double> (state >> 8) / 8388608.0 - 1.0 };
            audio.channels[0][i] = static_cast<float> (0.3 * std::sin (2.0 * kPi * 517.0 * static_cast<double> (i) / sampleRate) + 0.1 * noise);
        }
        return audio;
    }
}

TEST (detectShifts_reports_zero_for_identical_audio)
{
    const bridge::Audio signal { makeSignal (44100, 3.0, 1, 1) };
    const bridge::RealignParams params;

    const auto segments = bridge::detectShifts (signal.channels[0], signal.channels[0], signal.sampleRate, params);

    CHECK (segments.size () == 1);
    if (! segments.empty ())
    {
        CHECK (segments[0].shift == 0);
        CHECK (segments[0].start == 0);
        CHECK (segments[0].end >= static_cast<int64_t> (signal.frames ()) - 2 * 1102);   // within two hops of the end
        CHECK (segments[0].correlation > 0.999);
    }
}

TEST (detectShifts_finds_early_tail_after_an_edit)
{
    const bridge::Audio original { makeSignal (44100, 3.0, 1, 1) };
    const int64_t editStart { 44100 };           // 1.0 s
    const int64_t editEnd { 61740 };             // 1.4 s
    const bridge::Audio render { makeRender (original, editStart, editEnd, 30) };

    const auto segments = bridge::detectShifts (original.channels[0], render.channels[0], 44100, bridge::RealignParams {});

    CHECK (segments.size () == 2);
    if (segments.size () == 2)
    {
        CHECK (segments[0].shift == 0);
        CHECK (segments[0].end <= editStart + 2205);        // ends before the edit (one window of slack)
        CHECK (segments[1].shift == 30);                    // render is early by 30: it must move LATER by 30
        CHECK (segments[1].start >= editEnd - 2205);
    }
}

TEST (detectShifts_ignores_unrelated_audio)
{
    const bridge::Audio a { makeSignal (44100, 2.0, 1, 1) };
    const bridge::Audio b { makeUnrelated (44100, 2.0, 99) };

    const auto segments = bridge::detectShifts (a.channels[0], b.channels[0], 44100, bridge::RealignParams {});

    CHECK (segments.empty ());
}

TEST (detectShifts_skips_silence_without_breaking_a_run)
{
    bridge::Audio a { makeSignal (44100, 3.0, 1, 1) };
    for (size_t i { 44100 }; i < 66150; ++i)      // 0.5 s of digital silence in the middle
        a.channels[0][i] = 0.0f;

    const auto segments = bridge::detectShifts (a.channels[0], a.channels[0], 44100, bridge::RealignParams {});

    CHECK (segments.size () == 1);
    if (! segments.empty ())
        CHECK (segments[0].shift == 0);
}
```

- [ ] **Step 2: Register the new sources in CMake**

In `host/CMakeLists.txt` change the two source lists to:

```cmake
add_library(bridge_core STATIC
    common/Wav.cpp
    realign/Realign.cpp
)
```

```cmake
add_executable(bridge_tests
    tests/test_main.cpp
    tests/test_wav.cpp
    tests/test_realign.cpp
)
```

- [ ] **Step 3: Run to verify it fails**

```bash
cmake --build build/host-tests -j 2>&1 | tail -5
```

Expected: FAIL with `'realign/Realign.h' file not found`.

- [ ] **Step 4: Implement shift detection**

`host/realign/Realign.h`:

```cpp
#pragma once

#include "common/Wav.h"

#include <cstdint>
#include <string>
#include <vector>

namespace bridge
{
    struct RealignParams
    {
        double windowSec { 0.050 };
        double hopSec { 0.025 };
        int maxShift { 400 };                   // samples searched in both directions
        double minCorrelation { 0.98 };         // windows below this are treated as edited
        double earlyAcceptCorrelation { 0.9995 };   // speed-up: accept the previous shift (or 0) without a full search
        double silenceRms { 1e-4 };             // windows quieter than this carry no information
        double crossfadeSec { 0.003 };
    };

    // A stretch of the render that is an exact copy of the original, moved by 'shift' samples.
    // shift > 0: the render is EARLY and has to be moved LATER by that many samples.
    struct ShiftSegment
    {
        int64_t start { 0 };            // sample range [start, end) on the original's timeline
        int64_t end { 0 };
        int shift { 0 };
        double correlation { 0.0 };     // lowest window correlation inside the segment
    };

    struct RealignResult
    {
        bool applied { false };
        std::vector<ShiftSegment> segments;
        std::string note;
    };

    // Mono analysis: finds runs of windows where render[n - shift] matches original[n] with
    // correlation >= params.minCorrelation. Silent windows are skipped; edited windows end a run.
    std::vector<ShiftSegment> detectShifts (const std::vector<float>& original, const std::vector<float>& render,
                                            int sampleRate, const RealignParams& params);

    // Defined in Task 4.
    RealignResult realign (const Audio& original, const Audio& render, const RealignParams& params, Audio& out);
}
```

`host/realign/Realign.cpp` (Task 4 appends `realign()` to this file):

```cpp
#include "realign/Realign.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <initializer_list>

namespace bridge
{
    namespace
    {
        float sampleAt (const std::vector<float>& x, int64_t index)
        {
            return (index < 0 || index >= static_cast<int64_t> (x.size ())) ? 0.0f : x[static_cast<size_t> (index)];
        }

        // Normalised correlation of a[start, start+window) with b[start-shift, start-shift+window).
        double correlationAt (const std::vector<float>& a, const std::vector<float>& b, int64_t start, int64_t window, int shift, double energyA)
        {
            double dot { 0.0 }, energyB { 0.0 };
            const int64_t from { start - shift };
            if (from >= 0 && from + window <= static_cast<int64_t> (b.size ()))
            {
                const float* pa { a.data () + start };
                const float* pb { b.data () + from };
                for (int64_t i { 0 }; i < window; ++i)
                {
                    dot += static_cast<double> (pa[i]) * pb[i];
                    energyB += static_cast<double> (pb[i]) * pb[i];
                }
            }
            else
            {
                for (int64_t i { 0 }; i < window; ++i)
                {
                    const double bv { sampleAt (b, from + i) };
                    dot += static_cast<double> (a[static_cast<size_t> (start + i)]) * bv;
                    energyB += bv * bv;
                }
            }
            const double denominator { std::sqrt (energyA * energyB) };
            return denominator > 0.0 ? dot / denominator : 0.0;
        }
    }

    std::vector<ShiftSegment> detectShifts (const std::vector<float>& a, const std::vector<float>& b, int sampleRate, const RealignParams& params)
    {
        std::vector<ShiftSegment> segments;
        const int64_t n { static_cast<int64_t> (a.size ()) };
        const int64_t window { std::max<int64_t> (16, std::llround (params.windowSec * sampleRate)) };
        const int64_t hop { std::max<int64_t> (1, std::llround (params.hopSec * sampleRate)) };

        bool haveRun { false };
        ShiftSegment run;
        int lastShift { 0 };

        for (int64_t start { 0 }; start + window <= n; start += hop)
        {
            double energyA { 0.0 };
            for (int64_t i { 0 }; i < window; ++i)
            {
                const double v { a[static_cast<size_t> (start + i)] };
                energyA += v * v;
            }
            if (std::sqrt (energyA / static_cast<double> (window)) < params.silenceRms)
                continue;       // silence: neither extends nor breaks a run

            int bestShift { 0 };
            double bestCorrelation { -2.0 };
            bool settled { false };

            // cheap check first: most windows keep the previous shift (or are unshifted)
            for (const int candidate : { lastShift, 0 })
            {
                const double corr { correlationAt (a, b, start, window, candidate, energyA) };
                if (corr >= params.earlyAcceptCorrelation)
                {
                    bestShift = candidate;
                    bestCorrelation = corr;
                    settled = true;
                    break;
                }
            }

            if (! settled)
            {
                for (int shift { -params.maxShift }; shift <= params.maxShift; ++shift)
                {
                    const double corr { correlationAt (a, b, start, window, shift, energyA) };
                    const bool better { corr > bestCorrelation + 1e-9 || (corr > bestCorrelation - 1e-9 && std::abs (shift) < std::abs (bestShift)) };
                    if (better)
                    {
                        bestCorrelation = corr;
                        bestShift = shift;
                    }
                }
            }

            if (bestCorrelation < params.minCorrelation)
            {
                if (haveRun)
                {
                    segments.push_back (run);       // an edited stretch ends the run
                    haveRun = false;
                }
                continue;
            }

            lastShift = bestShift;
            if (haveRun && run.shift == bestShift)
            {
                run.end = start + window;
                run.correlation = std::min (run.correlation, bestCorrelation);
            }
            else
            {
                if (haveRun)
                    segments.push_back (run);
                run.start = start;
                run.end = start + window;
                run.shift = bestShift;
                run.correlation = bestCorrelation;
                haveRun = true;
            }
        }
        if (haveRun)
            segments.push_back (run);
        return segments;
    }
}
```

- [ ] **Step 5: Add a temporary stub so the tests link**

`realign()` is declared in the header but defined in Task 4. Append this temporary stub to `host/realign/Realign.cpp` inside `namespace bridge` (Task 4 replaces it):

```cpp
    RealignResult realign (const Audio&, const Audio&, const RealignParams&, Audio&)
    {
        return {};      // replaced in Task 4
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cmake --build build/host-tests -j 2>&1 | tail -3 && build/host-tests/bridge_tests detectShifts
```

Expected: 4 `detectShifts_*` tests `[  OK  ]`, final line `4 test(s), 0 failure(s)`.

- [ ] **Step 7: Commit**

```bash
git add host/realign host/tests/test_realign.cpp host/CMakeLists.txt
git commit -m "feat: detect constant shifts between a render and its original"
```

---

## Task 4: Realign — applying the shifts

**Revised after the Task 3 review.** The real Melodyne tail is shifted by a *fractional* number of samples and some quiet stretches inside the tail stay unshifted, so `realign()` merges neighbouring segments with the same shift into pieces and moves each piece with a fractional delay. Whole-sample shifts stay exact copies.

**Files:**
- Modify: `host/realign/Realign.cpp` (replace the temporary `realign()` stub)
- Modify: `host/tests/test_realign.cpp` (append tests; it already has the helpers `makeSignal(sampleRate, seconds, channels, seed, offsetSamples)`, `makeRender(sampleRate, seconds, channels, seed, editStart, editEnd, early)` and `makeUnrelated(sampleRate, seconds, seed)` from Task 3)

- [ ] **Step 1: Append the failing tests for `realign`**

Append to `host/tests/test_realign.cpp`:

```cpp
namespace
{
    double maxAbsDiff (const bridge::Audio& a, const bridge::Audio& b, int64_t from, int64_t to)
    {
        double worst { 0.0 };
        for (size_t c { 0 }; c < a.channels.size (); ++c)
            for (int64_t i { from }; i < to; ++i)
                worst = std::max (worst, static_cast<double> (std::fabs (a.channels[c][static_cast<size_t> (i)] - b.channels[c][static_cast<size_t> (i)])));
        return worst;
    }
}

TEST (realign_recovers_a_whole_sample_early_tail_exactly)
{
    const bridge::Audio original { makeSignal (44100, 3.0, 1, 1) };
    const bridge::Audio render { makeRender (44100, 3.0, 1, 1, 44100, 61740, 30.0) };

    bridge::Audio out;
    const auto result = bridge::realign (original, render, bridge::RealignParams {}, out);

    REQUIRE (result.applied);
    REQUIRE (out.frames () == original.frames ());
    CHECK (out.sampleRate == 44100);
    CHECK (maxAbsDiff (out, original, 0, 40000) < 1e-9);                       // before the edit: untouched
    CHECK (maxAbsDiff (out, render, 46000, 50000) < 1e-9);                     // inside the edited note, before the junction: as rendered
    CHECK (maxAbsDiff (out, original, 66150, static_cast<int64_t> (original.frames ())) < 1e-6);   // after the edit: back on the original timeline
}

TEST (realign_recovers_a_fractionally_early_tail)
{
    const bridge::Audio original { makeSignal (44100, 3.0, 1, 1) };
    const bridge::Audio render { makeRender (44100, 3.0, 1, 1, 44100, 61740, 30.75) };

    bridge::Audio out;
    const auto result = bridge::realign (original, render, bridge::RealignParams {}, out);

    REQUIRE (result.applied);
    const int64_t end { static_cast<int64_t> (original.frames ()) };
    const double before { maxAbsDiff (render, original, 66150, end) };
    const double after { maxAbsDiff (out, original, 66150, end) };
    std::printf ("    tail peak error: %g before, %g after\n", before, after);
    CHECK (after < 3e-3);                   // windowed-sinc interpolation error
    CHECK (after * 10.0 < before);          // and clearly better than doing nothing
    CHECK (maxAbsDiff (out, original, 0, 40000) < 1e-9);
}

TEST (realign_recovers_a_late_tail_on_stereo_audio)
{
    const bridge::Audio original { makeSignal (44100, 3.0, 2, 5) };
    const bridge::Audio render { makeRender (44100, 3.0, 2, 5, 44100, 61740, -20.0) };

    bridge::Audio out;
    const auto result = bridge::realign (original, render, bridge::RealignParams {}, out);

    REQUIRE (result.applied);
    REQUIRE (out.channelCount () == 2);
    CHECK (maxAbsDiff (out, original, 66150, static_cast<int64_t> (original.frames ())) < 1e-6);
    bool sawNegativeShift { false };
    for (const auto& segment : result.segments)
        sawNegativeShift = sawNegativeShift || std::fabs (segment.shift + 20.0) < 0.1;
    CHECK (sawNegativeShift);
}

TEST (realign_handles_unshifted_stretches_inside_the_tail)
{
    // Real Melodyne renders leave some stretches of the tail unshifted (pauses, unpitched sounds).
    // 0-1.0 s as is; 1.0-1.4 s edited; 1.4-2.5 s early by 30; 2.5-2.9 s unshifted; 2.9-4.0 s early by 30 again.
    const int rate { 44100 };
    const bridge::Audio original { makeSignal (rate, 4.0, 1, 3) };
    const bridge::Audio early { makeSignal (rate, 4.0, 1, 3, 30.0) };
    bridge::Audio render { original };
    for (int64_t i { rate }; i < static_cast<int64_t> (original.frames ()); ++i)
    {
        const double t { static_cast<double> (i) / rate };
        float value { early.channels[0][static_cast<size_t> (i)] };
        if (t < 1.4)
            value = static_cast<float> (0.4 * std::sin (2.0 * kPi * 330.0 * static_cast<double> (i) / rate));
        else if (t >= 2.5 && t < 2.9)
            value = original.channels[0][static_cast<size_t> (i)];
        render.channels[0][static_cast<size_t> (i)] = value;
    }

    bridge::Audio out;
    const auto result = bridge::realign (original, render, bridge::RealignParams {}, out);

    REQUIRE (result.applied);
    CHECK (maxAbsDiff (out, original, 0, 40000) < 1e-9);
    CHECK (maxAbsDiff (out, original, static_cast<int64_t> (1.5 * rate), static_cast<int64_t> (2.45 * rate)) < 1e-6);
    CHECK (maxAbsDiff (out, original, static_cast<int64_t> (2.55 * rate), static_cast<int64_t> (2.85 * rate)) < 1e-9);   // snapped to shift 0: exact copy
    CHECK (maxAbsDiff (out, original, static_cast<int64_t> (3.0 * rate), static_cast<int64_t> (4.0 * rate)) < 1e-6);
}

TEST (realign_leaves_an_aligned_render_alone)
{
    const bridge::Audio original { makeSignal (44100, 2.0, 1, 1) };

    bridge::Audio out;
    const auto result = bridge::realign (original, original, bridge::RealignParams {}, out);

    CHECK (! result.applied);
    CHECK (! result.note.empty ());
    CHECK (out.channels == original.channels);
}

TEST (realign_gives_up_on_unrelated_audio)
{
    const bridge::Audio original { makeSignal (44100, 2.0, 1, 1) };
    const bridge::Audio render { makeUnrelated (44100, 2.0, 99) };

    bridge::Audio out;
    const auto result = bridge::realign (original, render, bridge::RealignParams {}, out);

    CHECK (! result.applied);
    CHECK (! result.note.empty ());
    CHECK (out.channels == render.channels);        // nothing is changed silently
}

TEST (realign_pads_or_trims_the_render_to_the_original_length)
{
    const bridge::Audio original { makeSignal (44100, 2.0, 1, 1) };
    bridge::Audio shortRender { original };
    shortRender.channels[0].resize (original.frames () - 1000);

    bridge::Audio out;
    bridge::realign (original, shortRender, bridge::RealignParams {}, out);

    CHECK (out.frames () == original.frames ());
}
```

- [ ] **Step 2: Run to verify the new tests fail**

```bash
cmake --build build/host-tests -j 2>&1 | tail -3 && build/host-tests/bridge_tests realign_
```

Expected: the tests that need an applied realignment (`realign_recovers_*`, `realign_handles_unshifted_*`) FAIL (the stub returns `applied == false` and an empty `out`, so a `REQUIRE` fails or the exit status is nonzero).

- [ ] **Step 3: Replace the stub with the real implementation**

In `host/realign/Realign.cpp`, delete the temporary `realign` stub and append this inside `namespace bridge`. If `Realign.cpp` has no `kPi` and `<array>` is needed, add them to the includes/anonymous namespace exactly as shown. The helper `sampleAt` already exists from Task 3; if it has a different name or signature there, adapt the calls below to it (it returns 0 outside the vector).

```cpp
    namespace
    {
        const double kPi { 3.14159265358979323846 };

        std::vector<float> mixToMono (const Audio& audio)
        {
            std::vector<float> mono (audio.frames (), 0.0f);
            for (const auto& channel : audio.channels)
                for (size_t i { 0 }; i < channel.size () && i < mono.size (); ++i)
                    mono[i] += channel[i];
            if (audio.channelCount () > 1)
                for (auto& value : mono)
                    value /= static_cast<float> (audio.channelCount ());
            return mono;
        }

        // Moves audio LATER by 'shift' samples: out[i] = x[i - shift]. Whole-sample shifts are exact copies;
        // fractional ones use a Hann-windowed sinc with 32 taps whose weights are computed once.
        class Delay
        {
        public:
            explicit Delay (double shift)
            {
                const double position { -shift };                             // out[i] = x(i + position)
                _whole = static_cast<int64_t> (std::floor (position));
                const double fraction { position - static_cast<double> (_whole) };
                _exact = fraction < 1e-9;
                if (_exact)
                    return;

                double sum { 0.0 };
                for (int k { 0 }; k < kTaps; ++k)
                {
                    const double t { static_cast<double> (k - kHalf + 1) - fraction };    // distance of tap k from the wanted point
                    const double x { kPi * t };
                    const double sinc { std::fabs (x) < 1e-12 ? 1.0 : std::sin (x) / x };
                    const double window { 0.5 * (1.0 + std::cos (kPi * t / kHalf)) };
                    _weights[k] = sinc * window;
                    sum += _weights[k];
                }
                for (double& weight : _weights)
                    weight /= sum;
            }

            float at (const std::vector<float>& x, int64_t i) const
            {
                if (_exact)
                    return sampleAt (x, i + _whole);
                double acc { 0.0 };
                for (int k { 0 }; k < kTaps; ++k)
                    acc += _weights[k] * static_cast<double> (sampleAt (x, i + _whole + (k - kHalf + 1)));
                return static_cast<float> (acc);
            }

        private:
            static constexpr int kHalf { 16 };
            static constexpr int kTaps { 2 * kHalf };
            int64_t _whole { 0 };
            bool _exact { true };
            double _weights[kTaps] {};
        };

        struct Piece
        {
            int64_t start;      // first sample this piece applies to
            double shift;
        };
    }

    RealignResult realign (const Audio& original, const Audio& render, const RealignParams& params, Audio& out)
    {
        RealignResult result;
        const int64_t n { static_cast<int64_t> (original.frames ()) };

        // Start from the render, trimmed or zero-padded to the original length.
        out.sampleRate = render.sampleRate;
        out.channels.assign (render.channels.size (), std::vector<float> (static_cast<size_t> (n), 0.0f));
        for (size_t c { 0 }; c < render.channels.size (); ++c)
            for (int64_t i { 0 }; i < n; ++i)
                out.channels[c][static_cast<size_t> (i)] = sampleAt (render.channels[c], i);

        if (original.channelCount () < 1 || render.channelCount () < 1 || original.sampleRate != render.sampleRate)
        {
            result.note = "original and render differ in format; audio left as rendered";
            return result;
        }

        result.segments = detectShifts (mixToMono (original), mixToMono (render), original.sampleRate, params);
        if (result.segments.empty ())
        {
            result.note = "no confident match between render and original; audio left as rendered";
            return result;
        }

        // Merge neighbouring segments with (nearly) the same shift into pieces. Gaps between them inherit the
        // shift; a junction between pieces with different shifts sits halfway between the two segments, which is
        // inside the stretch that could not be matched (an edited note, or a pause).
        std::vector<Piece> pieces;
        double sum { 0.0 }, weight { 0.0 };
        for (size_t k { 0 }; k < result.segments.size (); ++k)
        {
            const ShiftSegment& segment { result.segments[k] };
            const double length { static_cast<double> (segment.end - segment.start) };
            if (pieces.empty ())
            {
                pieces.push_back (Piece { 0, segment.shift });
            }
            else if (std::fabs (segment.shift - sum / weight) > 0.5)
            {
                pieces.back ().shift = sum / weight;
                // a segment's end can lie past the end of a short render: keep the junction inside [previous junction, n]
                const int64_t junction { std::min<int64_t> (n, std::max<int64_t> (pieces.back ().start, (result.segments[k - 1].end + segment.start) / 2)) };
                pieces.push_back (Piece { junction, segment.shift });
                sum = 0.0;
                weight = 0.0;
            }
            sum += segment.shift * length;
            weight += length;
        }
        pieces.back ().shift = sum / weight;

        // Snap: a shift of ~0 is no shift at all (exact copy); a shift within 0.01 of a whole number is that number.
        bool anyShift { false };
        for (Piece& piece : pieces)
        {
            if (std::fabs (piece.shift) < 0.05)
                piece.shift = 0.0;
            else if (std::fabs (piece.shift - std::round (piece.shift)) < 0.01)
                piece.shift = std::round (piece.shift);
            anyShift = anyShift || piece.shift != 0.0;
        }
        if (! anyShift)
        {
            result.note = "render already aligned; nothing to do";
            return result;
        }

        std::vector<Delay> delays;
        for (const Piece& piece : pieces)
            delays.emplace_back (piece.shift);

        const int64_t fade { std::max<int64_t> (2, std::llround (params.crossfadeSec * original.sampleRate)) };
        const int64_t half { fade / 2 };

        for (size_t c { 0 }; c < render.channels.size (); ++c)
        {
            const std::vector<float>& src { render.channels[c] };
            std::vector<float>& dst { out.channels[c] };

            for (size_t k { 0 }; k < pieces.size (); ++k)
            {
                const int64_t from { pieces[k].start };
                const int64_t to { (k + 1 < pieces.size ()) ? pieces[k + 1].start : n };
                for (int64_t i { from }; i < to; ++i)
                    dst[static_cast<size_t> (i)] = delays[k].at (src, i);
            }

            for (size_t k { 1 }; k < pieces.size (); ++k)
            {
                const int64_t junction { pieces[k].start };
                for (int64_t i { std::max<int64_t> (0, junction - half) }; i < std::min<int64_t> (n, junction + half); ++i)
                {
                    const double t { static_cast<double> (i - (junction - half)) / static_cast<double> (2 * half) };
                    dst[static_cast<size_t> (i)] = static_cast<float> ((1.0 - t) * static_cast<double> (delays[k - 1].at (src, i)) + t * static_cast<double> (delays[k].at (src, i)));
                }
            }
        }

        size_t movedPieces { 0 };
        for (const Piece& piece : pieces)
            movedPieces += piece.shift != 0.0 ? 1U : 0U;
        result.applied = true;
        result.note = "moved " + std::to_string (movedPieces) + " stretch(es) back onto the original timeline";
        return result;
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cmake --build build/host-tests -j 2>&1 | tail -3 && build/host-tests/bridge_tests
```

Expected: every test `[  OK  ]`, final line `0 failure(s)`. The fractional test prints a line like `tail peak error: 0.3 before, 0.0004 after`. If `after` exceeds the 3e-3 limit, report the printed value; do not raise the limit without reporting.

- [ ] **Step 5: Commit**

```bash
git add host/realign host/tests/test_realign.cpp
git commit -m "feat: realign an edited render back onto the original timeline"
```

---

## Task 5: Acceptance test on the spike's real captures, plus CLI tools

**Files:**
- Create: `tools/make_realign_fixtures.py`
- Create: `host/tests/fixtures/spike_original_2_8s.wav`, `host/tests/fixtures/spike_edited_2_8s.wav` (generated)
- Create: `host/tools/wavdiff.cpp`, `host/tools/realign_tool.cpp`
- Modify: `host/CMakeLists.txt`, `host/tests/test_realign.cpp`

- [ ] **Step 1: Write the fixture generator**

`tools/make_realign_fixtures.py`:

```python
#!/usr/bin/env python3
"""Cuts 2.0-8.0 s out of the spike's session-2 renders into small test fixtures.

render_1.wav is the unedited render (bit-identical to the input), render_2.wav the render after
moving one note up 3 semitones (the tail after the note is ~31 samples early).
Needs numpy and the (git-ignored) spike/out_session2 folder.
"""
import os
import struct
import sys

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "spike", "out_session2")
DST = os.path.join(ROOT, "host", "tests", "fixtures")
START_SEC, END_SEC = 2.0, 8.0


def read_float32_wav(path):
    d = open(path, "rb").read()
    channels = struct.unpack("<H", d[22:24])[0]
    rate = struct.unpack("<I", d[24:28])[0]
    assert d[36:40] == b"data", "expected the 44-byte header written by the spike host"
    return np.frombuffer(d[44:], dtype="<f4").reshape(-1, channels), rate


def write_float32_wav(path, samples, rate):
    channels = samples.shape[1]
    data = samples.astype("<f4").tobytes()
    header = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, 3, channels, rate, rate * channels * 4, channels * 4, 32) + b"data" + struct.pack("<I", len(data))
    open(path, "wb").write(header + data)


def main():
    os.makedirs(DST, exist_ok=True)
    for name, out in (("render_1.wav", "spike_original_2_8s.wav"), ("render_2.wav", "spike_edited_2_8s.wav")):
        samples, rate = read_float32_wav(os.path.join(SRC, name))
        cut = samples[int(START_SEC * rate):int(END_SEC * rate)]
        write_float32_wav(os.path.join(DST, out), cut, rate)
        print("wrote", out, cut.shape)


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Generate the fixtures**

```bash
python3 tools/make_realign_fixtures.py
ls -la host/tests/fixtures
```

Expected: two lines `wrote spike_original_2_8s.wav (264600, 2)` and `wrote spike_edited_2_8s.wav (264600, 2)`; both files are about 2.1 MB.

- [ ] **Step 3: Write the acceptance test**

The real tail is a *fractional* shift (about 30.75 samples) with some stretches that Melodyne leaves unshifted, so the check is on measured error, not on exact equality. Append to `host/tests/test_realign.cpp` (it needs `<cstdio>`, which `check.h` already includes):

```cpp
namespace
{
    double rmsOf (const bridge::Audio& a, int64_t from, int64_t to)
    {
        double sum { 0.0 };
        size_t count { 0 };
        for (const auto& channel : a.channels)
            for (int64_t i { from }; i < to; ++i, ++count)
                sum += static_cast<double> (channel[static_cast<size_t> (i)]) * channel[static_cast<size_t> (i)];
        return count ? std::sqrt (sum / static_cast<double> (count)) : 0.0;
    }

    double rmsDiff (const bridge::Audio& a, const bridge::Audio& b, int64_t from, int64_t to)
    {
        double sum { 0.0 };
        size_t count { 0 };
        for (size_t c { 0 }; c < a.channels.size (); ++c)
            for (int64_t i { from }; i < to; ++i, ++count)
            {
                const double d { static_cast<double> (a.channels[c][static_cast<size_t> (i)]) - b.channels[c][static_cast<size_t> (i)] };
                sum += d * d;
            }
        return count ? std::sqrt (sum / static_cast<double> (count)) : 0.0;
    }
}

TEST (realign_acceptance_on_the_spike_captures)
{
    // The spike's Melodyne render after a +3 semitone edit (6 s excerpt). The edited note sits at about
    // 2.07-2.43 s; after it the audio is the original moved about 30.75 samples EARLY, except for a few
    // quiet or unpitched stretches that stay unshifted.
    const std::string dir { std::string { BRIDGE_TEST_DIR } + "/fixtures" };
    bridge::Audio original, edited;
    std::string error;
    REQUIRE (bridge::readWav (dir + "/spike_original_2_8s.wav", original, error));
    REQUIRE (bridge::readWav (dir + "/spike_edited_2_8s.wav", edited, error));

    bridge::Audio out;
    const auto result = bridge::realign (original, edited, bridge::RealignParams {}, out);

    REQUIRE (result.applied);
    bool foundTheShift { false };
    for (const auto& segment : result.segments)
        foundTheShift = foundTheShift || std::fabs (segment.shift - 30.75) < 0.3;
    CHECK (foundTheShift);

    const int64_t rate { original.sampleRate };
    const int64_t from { 2 * rate + 600 * rate / 1000 };                  // 2.6 s into the excerpt: after the edited note
    const int64_t end { static_cast<int64_t> (original.frames ()) };
    const double signal { rmsOf (original, from, end) };
    const double before { rmsDiff (edited, original, from, end) };
    const double after { rmsDiff (out, original, from, end) };
    std::printf ("    tail RMS error vs original: %.4f before, %.4f after (signal RMS %.4f, relative %.1f%% -> %.1f%%)\n",
                 before, after, signal, 100.0 * before / signal, 100.0 * after / signal);
    CHECK (after < 0.1 * before);                                          // at least 20 dB better than doing nothing
    CHECK (rmsDiff (out, original, 0, 2 * rate) == 0.0);                   // before the edit: bit-identical
}
```

- [ ] **Step 4: Run the test and record the measurement**

```bash
cmake --build build/host-tests -j 2>&1 | tail -3 && build/host-tests/bridge_tests acceptance
```

Expected: `realign_acceptance_on_the_spike_captures` `[  OK  ]` and a printed line like `tail RMS error vs original: 0.15 before, 0.01 after (...)`.

The design target (spec section 7) is a relative RMS error of at most 1% after realignment. If the printed relative error after realignment is above 1%, the test still has to pass (at least 20 dB better than before), but report the exact numbers in your report and print the `result.segments` (start, end, shift, correlation) so the coordinator can decide whether the unshifted stretches or the junction placement need work. Do not tune thresholds to hit 1%.

- [ ] **Step 5: Add the two CLI tools**

`host/tools/wavdiff.cpp`:

```cpp
// wavdiff reference.wav candidate.wav [--a-start SECONDS] [--tol X]
// Compares the whole candidate with the reference starting at --a-start. Exit codes:
//   0  the largest absolute sample difference is <= tol (default 0)
//   1  it is larger, or any difference is not finite (NaN/inf samples never pass)
//   2  usage, argument or file format errors (unknown flag, flag without value, unparseable or
//      non-finite --a-start/--tol, negative --tol, candidate does not fit in the reference)
#include "common/Wav.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>

namespace
{
    int usage ()
    {
        std::printf ("usage: wavdiff reference.wav candidate.wav [--a-start SECONDS] [--tol X]\n");
        return 2;
    }

    bool parseNumber (const char* text, double& value)
    {
        char* end { nullptr };
        value = std::strtod (text, &end);
        return end != text && *end == '\0' && std::isfinite (value);
    }
}

int main (int argc, char** argv)
{
    if (argc < 3)
        return usage ();
    double aStart { 0.0 }, tolerance { 0.0 };
    for (int i { 3 }; i < argc; i += 2)
    {
        double* target { std::strcmp (argv[i], "--a-start") == 0 ? &aStart : std::strcmp (argv[i], "--tol") == 0 ? &tolerance : nullptr };
        if (target == nullptr || i + 1 >= argc || ! parseNumber (argv[i + 1], *target))
            return usage ();
    }
    if (tolerance < 0.0)
        return usage ();

    bridge::Audio a, b;
    std::string error;
    if (! bridge::readWav (argv[1], a, error) || ! bridge::readWav (argv[2], b, error))
    {
        std::printf ("%s\n", error.c_str ());
        return 2;
    }
    if (a.channelCount () != b.channelCount () || a.sampleRate != b.sampleRate)
    {
        std::printf ("format differs: %d ch @ %d Hz vs %d ch @ %d Hz\n", a.channelCount (), a.sampleRate, b.channelCount (), b.sampleRate);
        return 2;
    }
    // Check the start in seconds before converting it to samples, so llround never sees an out-of-range value.
    const double offsetSamples { aStart * a.sampleRate };
    if (! (offsetSamples >= 0.0 && offsetSamples <= static_cast<double> (a.frames ())))
    {
        std::printf ("--a-start %g s is outside the reference (%zu frames)\n", aStart, a.frames ());
        return 2;
    }
    const size_t offset { static_cast<size_t> (std::llround (offsetSamples)) };
    if (offset > a.frames () || b.frames () > a.frames () - offset)
    {
        std::printf ("candidate (%zu frames) does not fit in the reference from %.3f s\n", b.frames (), aStart);
        return 2;
    }
    double worst { 0.0 };
    for (int c { 0 }; c < a.channelCount (); ++c)
        for (size_t i { 0 }; i < b.frames (); ++i)
        {
            const double d { std::fabs (static_cast<double> (a.channels[static_cast<size_t> (c)][offset + i]) - b.channels[static_cast<size_t> (c)][i]) };
            worst = std::isfinite (d) ? std::max (worst, d) : std::numeric_limits<double>::infinity ();
            if (std::isinf (worst))
                break;
        }
    std::printf ("frames %zu, max abs diff %.9g\n", b.frames (), worst);
    return worst <= tolerance ? 0 : 1;
}
```

`host/tools/realign_tool.cpp`:

```cpp
// realign_tool original.wav render.wav out.wav
// Runs the realignment on two WAV files and prints what it found.
#include "realign/Realign.h"

#include <cstdio>

int main (int argc, char** argv)
{
    if (argc < 4)
    {
        std::printf ("usage: realign_tool original.wav render.wav out.wav\n");
        return 2;
    }
    bridge::Audio original, render, out;
    std::string error;
    if (! bridge::readWav (argv[1], original, error) || ! bridge::readWav (argv[2], render, error))
    {
        std::printf ("%s\n", error.c_str ());
        return 2;
    }
    const auto result = bridge::realign (original, render, bridge::RealignParams {}, out);
    std::printf ("applied: %s (%s)\n", result.applied ? "yes" : "no", result.note.c_str ());
    for (const auto& segment : result.segments)
        std::printf ("  segment %.3f s .. %.3f s  shift %+.2f  min correlation %.4f\n",
                     static_cast<double> (segment.start) / original.sampleRate, static_cast<double> (segment.end) / original.sampleRate, segment.shift, segment.correlation);
    if (! bridge::writeWavFloat32 (argv[3], out, error))
    {
        std::printf ("%s\n", error.c_str ());
        return 2;
    }
    return 0;
}
```

Append to `host/CMakeLists.txt`:

```cmake
add_executable(wavdiff tools/wavdiff.cpp)
target_link_libraries(wavdiff PRIVATE bridge_core)

add_executable(realign_tool tools/realign_tool.cpp)
target_link_libraries(realign_tool PRIVATE bridge_core)
```

- [ ] **Step 6: Build and try the tools on the fixtures**

```bash
cmake -S host -B build/host-tests && cmake --build build/host-tests -j 2>&1 | tail -3
build/host-tests/realign_tool host/tests/fixtures/spike_original_2_8s.wav host/tests/fixtures/spike_edited_2_8s.wav build/host-tests/realigned.wav
build/host-tests/wavdiff host/tests/fixtures/spike_original_2_8s.wav build/host-tests/realigned.wav --tol 1
```

Expected from `realign_tool`: `applied: yes (...)` and `segment` lines with `shift +30.7x` for the tail pieces after the edit (and `+0.0` for the prefix). `wavdiff` prints `frames 264600, max abs diff ...` (nonzero is fine here; the edited note differs) and exits 0 because of `--tol 1`.

- [ ] **Step 7: Commit**

```bash
git add tools/make_realign_fixtures.py host/tests host/tools host/CMakeLists.txt
git commit -m "test: realignment acceptance on the spike captures; add wavdiff and realign_tool"
```

---

## Part B: Host core (headless job in, result out)

## Task 6: Job, result and settings files

**Files:**
- Create: `host/jobio/Job.h`, `host/jobio/Job.mm`
- Modify: `host/CMakeLists.txt`
- Test: `host/tests/test_job.cpp`

- [ ] **Step 1: Write the failing tests**

`host/tests/test_job.cpp`:

```cpp
#include "check.h"
#include "testutil.h"

#include "jobio/Job.h"

#include <string>

namespace
{
    const char* kMelodyneJob = R"({
      "version": 1, "id": "job-1", "plugin": "melodyne", "placement": "newTrack", "realign": false,
      "song": { "tempo": 100.0 },
      "live": { "trackIndex": 3 },
      "clips": [ { "role": "source", "path": "/tmp/vocal.wav", "startSec": 1.5, "endSec": 4.0,
                   "startBeats": 8.0, "name": "Lead", "sampleRate": 44100, "channels": 2 } ]
    })";

    const char* kVocAlignJob = R"({
      "version": 1, "id": "job-2", "plugin": "vocalign",
      "song": { "tempo": 120.0 },
      "clips": [ { "role": "guide", "path": "/tmp/guide.wav", "startSec": 0, "endSec": 2, "startBeats": 0, "name": "G" },
                 { "role": "dub",   "path": "/tmp/dub.wav",   "startSec": 0, "endSec": 2, "startBeats": 4, "name": "D" } ]
    })";

    bool loads (const std::string& tag, const std::string& json, bridge::Job& job, std::string& error)
    {
        const std::string dir { makeTempDir (tag) };
        writeTextFile (dir + "/job.json", json);
        return bridge::loadJob (dir, job, error);
    }
}

TEST (job_loads_a_melodyne_job)
{
    bridge::Job job;
    std::string error;
    CHECK (loads ("jm", kMelodyneJob, job, error));
    CHECK (job.id == "job-1");
    CHECK (job.plugin == "melodyne");
    CHECK (job.placement == "newTrack");
    CHECK (! job.realign);
    CHECK_NEAR (job.tempo, 100.0, 1e-9);
    CHECK (job.clips.size () == 1);
    if (job.clips.size () == 1)
    {
        CHECK (job.clips[0].role == "source");
        CHECK (job.clips[0].path == "/tmp/vocal.wav");
        CHECK_NEAR (job.clips[0].startSec, 1.5, 1e-9);
        CHECK_NEAR (job.clips[0].endSec, 4.0, 1e-9);
        CHECK_NEAR (job.clips[0].startBeats, 8.0, 1e-9);
        CHECK (job.clips[0].name == "Lead");
    }
}

TEST (job_applies_defaults)
{
    bridge::Job job;
    std::string error;
    CHECK (loads ("jd", kVocAlignJob, job, error));
    CHECK (job.placement == "takeLane");
    CHECK (job.realign);
    CHECK (job.clips.size () == 2);
}

TEST (job_rejects_bad_input)
{
    bridge::Job job;
    std::string error;

    CHECK (! loads ("b1", "not json", job, error));
    CHECK (! loads ("b2", R"({"version": 2, "id": "x", "plugin": "melodyne", "clips": []})", job, error));
    CHECK (! loads ("b3", R"({"version": 1, "id": "x", "plugin": "autotune", "clips": [{"role":"source","path":"/a.wav","startSec":0,"endSec":1}]})", job, error));
    CHECK (error.find ("autotune") != std::string::npos);
    CHECK (! loads ("b4", R"({"version": 1, "id": "x", "plugin": "melodyne", "clips": []})", job, error));
    CHECK (! loads ("b5", R"({"version": 1, "id": "x", "plugin": "melodyne", "clips": [{"role":"source","path":"/a.wav","startSec":2,"endSec":1}]})", job, error));
    CHECK (! loads ("b6", R"({"version": 1, "id": "x", "plugin": "vocalign", "clips": [{"role":"guide","path":"/a.wav","startSec":0,"endSec":1}]})", job, error));
    CHECK (! loads ("b7", R"({"version": 1, "id": "x", "plugin": "melodyne", "placement": "sideways", "clips": [{"role":"source","path":"/a.wav","startSec":0,"endSec":1}]})", job, error));

    bridge::Job missing;
    CHECK (! bridge::loadJob (makeTempDir ("nofile"), missing, error));
}

TEST (result_roundtrip_and_atomic_write)
{
    const std::string dir { makeTempDir ("res") };
    bridge::ResultInfo info;
    info.status = "ok";
    info.message = "moved 1 stretch(es)";
    info.resultPath = dir + "/result.wav";
    info.realignApplied = true;
    bridge::ShiftSegment segment;
    segment.start = 100;
    segment.end = 900;
    segment.shift = 31;
    segment.correlation = 0.9999;
    info.shifts.push_back (segment);

    std::string error;
    CHECK (bridge::writeResult (dir, "job-9", info, error));
    CHECK (! std::filesystem::exists (dir + "/result.json.tmp"));

    bridge::ResultInfo back;
    CHECK (bridge::readResult (dir, back, error));
    CHECK (back.status == "ok");
    CHECK (back.message == info.message);
    CHECK (back.resultPath == info.resultPath);
    CHECK (back.realignApplied);
    CHECK (back.shifts.size () == 1);
    if (back.shifts.size () == 1)
    {
        CHECK (back.shifts[0].start == 100);
        CHECK (back.shifts[0].end == 900);
        CHECK (back.shifts[0].shift == 31);
    }
}

TEST (settings_overrides_are_read)
{
    const std::string dir { makeTempDir ("set") };
    writeTextFile (dir + "/settings.json", R"({"pluginPaths": {"melodyne": "/custom/Melodyne.vst3"}})");

    const auto overrides = bridge::loadPlugInOverrides (dir + "/settings.json");
    CHECK (overrides.size () == 1);
    CHECK (overrides.count ("melodyne") == 1 && overrides.at ("melodyne") == "/custom/Melodyne.vst3");

    CHECK (bridge::loadPlugInOverrides (dir + "/missing.json").empty ());
}
```

- [ ] **Step 2: Register sources in CMake**

In `host/CMakeLists.txt`: add `jobio/Job.mm` to `bridge_core`, add `tests/test_job.cpp` to `bridge_tests`, and link Foundation. The relevant parts become:

```cmake
add_library(bridge_core STATIC
    common/Wav.cpp
    realign/Realign.cpp
    jobio/Job.mm
)
target_include_directories(bridge_core PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_options(bridge_core PRIVATE $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
target_link_libraries(bridge_core PUBLIC "-framework Foundation")
```

and `tests/test_job.cpp` added to `bridge_tests`.

- [ ] **Step 3: Run to verify it fails**

```bash
cmake -S host -B build/host-tests && cmake --build build/host-tests -j 2>&1 | tail -5
```

Expected: FAIL with `'jobio/Job.h' file not found`.

- [ ] **Step 4: Implement**

`host/jobio/Job.h`:

```cpp
#pragma once

#include "realign/Realign.h"

#include <map>
#include <string>
#include <vector>

namespace bridge
{
    struct JobClip
    {
        std::string role;           // "source" (melodyne), "guide" or "dub" (vocalign)
        std::string path;           // absolute path of the audio file
        double startSec { 0.0 };    // region inside the file
        double endSec { 0.0 };
        double startBeats { 0.0 };  // position in the Arrangement
        std::string name;
    };

    struct Job
    {
        int version { 1 };
        std::string id;
        std::string plugin;                     // "melodyne" | "vocalign"
        std::string placement { "takeLane" };   // "takeLane" | "newTrack" | "replace" (used by the device only)
        bool realign { true };
        double tempo { 120.0 };
        std::vector<JobClip> clips;
        std::string dir;                        // the job folder
    };

    struct ResultInfo
    {
        std::string status;         // "ok" | "cancelled" | "error"
        std::string message;
        std::string resultPath;
        bool realignApplied { false };
        std::vector<ShiftSegment> shifts;
    };

    // Reads and validates <jobDir>/job.json. Unknown keys are ignored.
    bool loadJob (const std::string& jobDir, Job& job, std::string& error);

    // Writes <jobDir>/result.json atomically (temp file + rename): its existence means "done".
    bool writeResult (const std::string& jobDir, const std::string& jobId, const ResultInfo& info, std::string& error);
    bool readResult (const std::string& jobDir, ResultInfo& info, std::string& error);

    // ~/Library/Application Support/ARABridge/settings.json
    std::string defaultSettingsPath ();

    // {"pluginPaths": {"melodyne": "...", "vocalign": "..."}}; a missing file gives an empty map.
    std::map<std::string, std::string> loadPlugInOverrides (const std::string& settingsPath);
}
```

`host/jobio/Job.mm`:

```objc
#include "jobio/Job.h"

#import <Foundation/Foundation.h>

#include <algorithm>
#include <cstdio>

namespace bridge
{
    namespace
    {
        std::string toString (id value)
        {
            return [value isKindOfClass: [NSString class]] ? std::string { [(NSString*) value UTF8String] } : std::string {};
        }

        double toNumber (id value, double fallback)
        {
            return [value isKindOfClass: [NSNumber class]] ? [(NSNumber*) value doubleValue] : fallback;
        }

        bool fail (std::string& error, const std::string& message)
        {
            error = message;
            return false;
        }

        NSDictionary* readJsonFile (const std::string& path, std::string& error)
        {
            NSData* data = [NSData dataWithContentsOfFile: [NSString stringWithUTF8String: path.c_str ()]];
            if (data == nil)
            {
                error = "cannot read " + path;
                return nil;
            }
            NSError* nsError = nil;
            id root = [NSJSONSerialization JSONObjectWithData: data options: 0 error: &nsError];
            if (! [root isKindOfClass: [NSDictionary class]])
            {
                error = path + " is not a valid JSON object";
                return nil;
            }
            return root;
        }

        int countRole (const std::vector<JobClip>& clips, const char* role)
        {
            return static_cast<int> (std::count_if (clips.begin (), clips.end (), [role] (const JobClip& c) { return c.role == role; }));
        }
    }

    bool loadJob (const std::string& jobDir, Job& job, std::string& error)
    {
        @autoreleasepool
        {
            NSDictionary* root = readJsonFile (jobDir + "/job.json", error);
            if (root == nil)
                return false;

            Job parsed;
            parsed.dir = jobDir;
            parsed.version = static_cast<int> (toNumber (root[@"version"], 0));
            if (parsed.version != 1)
                return fail (error, "unsupported job version " + std::to_string (parsed.version));

            parsed.id = toString (root[@"id"]);
            parsed.plugin = toString (root[@"plugin"]);
            const std::string placement { toString (root[@"placement"]) };
            if (! placement.empty ())
                parsed.placement = placement;
            if ([root[@"realign"] isKindOfClass: [NSNumber class]])
                parsed.realign = [root[@"realign"] boolValue];
            if ([root[@"song"] isKindOfClass: [NSDictionary class]])
                parsed.tempo = toNumber (root[@"song"][@"tempo"], 120.0);

            if (parsed.id.empty ())
                return fail (error, "job has no id");
            if (parsed.plugin != "melodyne" && parsed.plugin != "vocalign")
                return fail (error, "unknown plug-in '" + parsed.plugin + "'");
            if (parsed.placement != "takeLane" && parsed.placement != "newTrack" && parsed.placement != "replace")
                return fail (error, "unknown placement '" + parsed.placement + "'");
            if (parsed.tempo <= 0.0)
                return fail (error, "tempo must be positive");

            NSArray* clips = root[@"clips"];
            if (! [clips isKindOfClass: [NSArray class]] || clips.count == 0)
                return fail (error, "job has no clips");
            for (id item in clips)
            {
                if (! [item isKindOfClass: [NSDictionary class]])
                    return fail (error, "a clip entry is not an object");
                JobClip clip;
                clip.role = toString (item[@"role"]);
                clip.path = toString (item[@"path"]);
                clip.startSec = toNumber (item[@"startSec"], 0.0);
                clip.endSec = toNumber (item[@"endSec"], 0.0);
                clip.startBeats = toNumber (item[@"startBeats"], 0.0);
                clip.name = toString (item[@"name"]);
                if (clip.name.empty ())
                    clip.name = clip.role;
                if (clip.path.empty ())
                    return fail (error, "a clip has no path");
                if (clip.startSec < 0.0 || ! (clip.endSec > clip.startSec))
                    return fail (error, "clip '" + clip.name + "' has an invalid time range");
                parsed.clips.push_back (clip);
            }

            if (parsed.plugin == "melodyne")
            {
                if (parsed.clips.size () != 1 || countRole (parsed.clips, "source") != 1)
                    return fail (error, "a melodyne job needs exactly one 'source' clip");
            }
            else if (parsed.clips.size () != 2 || countRole (parsed.clips, "guide") != 1 || countRole (parsed.clips, "dub") != 1)
            {
                return fail (error, "a vocalign job needs one 'guide' and one 'dub' clip");
            }

            job = parsed;
            return true;
        }
    }

    bool writeResult (const std::string& jobDir, const std::string& jobId, const ResultInfo& info, std::string& error)
    {
        @autoreleasepool
        {
            NSMutableArray* shifts = [NSMutableArray array];
            for (const auto& s : info.shifts)
                [shifts addObject: @{ @"start": @(s.start), @"end": @(s.end), @"shift": @(s.shift), @"correlation": @(s.correlation) }];

            NSDictionary* root = @{ @"version": @1,
                                    @"id": [NSString stringWithUTF8String: jobId.c_str ()],
                                    @"status": [NSString stringWithUTF8String: info.status.c_str ()],
                                    @"message": [NSString stringWithUTF8String: info.message.c_str ()],
                                    @"resultPath": [NSString stringWithUTF8String: info.resultPath.c_str ()],
                                    @"realign": @{ @"applied": @(info.realignApplied), @"shifts": shifts } };

            NSError* nsError = nil;
            NSData* data = [NSJSONSerialization dataWithJSONObject: root options: NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys error: &nsError];
            if (data == nil)
                return fail (error, "cannot encode result.json");

            const std::string tmp { jobDir + "/result.json.tmp" };
            const std::string finalPath { jobDir + "/result.json" };
            if (! [data writeToFile: [NSString stringWithUTF8String: tmp.c_str ()] atomically: NO])
                return fail (error, "cannot write " + tmp);
            if (std::rename (tmp.c_str (), finalPath.c_str ()) != 0)
                return fail (error, "cannot rename " + tmp);
            return true;
        }
    }

    bool readResult (const std::string& jobDir, ResultInfo& info, std::string& error)
    {
        @autoreleasepool
        {
            NSDictionary* root = readJsonFile (jobDir + "/result.json", error);
            if (root == nil)
                return false;

            ResultInfo parsed;
            parsed.status = toString (root[@"status"]);
            parsed.message = toString (root[@"message"]);
            parsed.resultPath = toString (root[@"resultPath"]);
            NSDictionary* realign = root[@"realign"];
            if ([realign isKindOfClass: [NSDictionary class]])
            {
                parsed.realignApplied = [realign[@"applied"] isKindOfClass: [NSNumber class]] && [realign[@"applied"] boolValue];
                NSArray* shifts = realign[@"shifts"];
                if ([shifts isKindOfClass: [NSArray class]])
                {
                    for (id item in shifts)
                    {
                        if (! [item isKindOfClass: [NSDictionary class]])
                            continue;
                        ShiftSegment s;
                        s.start = static_cast<int64_t> (toNumber (item[@"start"], 0.0));
                        s.end = static_cast<int64_t> (toNumber (item[@"end"], 0.0));
                        s.shift = toNumber (item[@"shift"], 0.0);       // fractional samples
                        s.correlation = toNumber (item[@"correlation"], 0.0);
                        parsed.shifts.push_back (s);
                    }
                }
            }
            info = parsed;
            return true;
        }
    }

    std::string defaultSettingsPath ()
    {
        @autoreleasepool
        {
            NSString* path = [NSHomeDirectory () stringByAppendingPathComponent: @"Library/Application Support/ARABridge/settings.json"];
            return std::string { path.UTF8String };
        }
    }

    std::map<std::string, std::string> loadPlugInOverrides (const std::string& settingsPath)
    {
        std::map<std::string, std::string> overrides;
        @autoreleasepool
        {
            std::string ignored;
            NSDictionary* root = readJsonFile (settingsPath, ignored);
            NSDictionary* paths = root[@"pluginPaths"];
            if ([paths isKindOfClass: [NSDictionary class]])
                for (id key in paths)
                    if ([key isKindOfClass: [NSString class]] && [paths[key] isKindOfClass: [NSString class]])
                        overrides[toString (key)] = toString (paths[key]);
        }
        return overrides;
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cmake --build build/host-tests -j 2>&1 | tail -3 && build/host-tests/bridge_tests job
build/host-tests/bridge_tests result_
build/host-tests/bridge_tests settings_
```

Expected: `job_loads_a_melodyne_job`, `job_applies_defaults`, `job_rejects_bad_input`, `result_roundtrip_and_atomic_write` and `settings_overrides_are_read` all `[  OK  ]`.

- [ ] **Step 6: Commit**

```bash
git add host/jobio host/tests/test_job.cpp host/CMakeLists.txt
git commit -m "feat: job.json, result.json and settings files"
```

---

## Task 7: Audio decoding

**Files:**
- Create: `host/audio/AudioDecode.h`, `host/audio/AudioDecode.mm`
- Modify: `host/CMakeLists.txt`
- Test: `host/tests/test_decode.cpp`

- [ ] **Step 1: Write the failing tests**

`host/tests/test_decode.cpp`:

```cpp
#include "check.h"
#include "testutil.h"

#include "audio/AudioDecode.h"
#include "common/Wav.h"

#include <cmath>
#include <string>

TEST (decode_float_wav_is_exact)
{
    const std::string dir { makeTempDir ("dec1") };
    bridge::Audio original;
    original.sampleRate = 44100;
    original.channels.assign (2, std::vector<float> (4000));
    for (size_t i { 0 }; i < 4000; ++i)
    {
        original.channels[0][i] = static_cast<float> (std::sin (0.01 * static_cast<double> (i)));
        original.channels[1][i] = static_cast<float> (0.5 * std::cos (0.02 * static_cast<double> (i)));
    }
    std::string error;
    CHECK (bridge::writeWavFloat32 (dir + "/f.wav", original, error));

    bridge::Audio decoded;
    CHECK (bridge::decodeAudioFile (dir + "/f.wav", decoded, error));
    CHECK (decoded.sampleRate == 44100);
    CHECK (decoded.channelCount () == 2);
    CHECK (decoded.frames () == 4000);
    CHECK (decoded.channels == original.channels);
}

TEST (decode_reports_errors)
{
    const std::string dir { makeTempDir ("dec2") };
    bridge::Audio decoded;
    std::string error;
    CHECK (! bridge::decodeAudioFile (dir + "/nothing.wav", decoded, error));
    CHECK (! error.empty ());

    writeTextFile (dir + "/junk.wav", "definitely not audio");
    error.clear ();
    CHECK (! bridge::decodeAudioFile (dir + "/junk.wav", decoded, error));
    CHECK (! error.empty ());
}
```

- [ ] **Step 2: Register in CMake**

In `host/CMakeLists.txt`: add `audio/AudioDecode.mm` to `bridge_core`, add `tests/test_decode.cpp` to `bridge_tests`, and extend the link line:

```cmake
target_link_libraries(bridge_core PUBLIC "-framework Foundation" "-framework AudioToolbox" "-framework CoreFoundation")
```

- [ ] **Step 3: Run to verify it fails**

```bash
cmake -S host -B build/host-tests && cmake --build build/host-tests -j 2>&1 | tail -5
```

Expected: FAIL with `'audio/AudioDecode.h' file not found`.

- [ ] **Step 4: Implement**

`host/audio/AudioDecode.h`:

```cpp
#pragma once

#include "common/Wav.h"

#include <string>

namespace bridge
{
    // Decodes any audio file CoreAudio understands (WAV, AIFF, MP3, FLAC, ...) to planar float at
    // the file's own sample rate and channel count.
    bool decodeAudioFile (const std::string& path, Audio& out, std::string& error);
}
```

`host/audio/AudioDecode.mm`:

```objc
#include "audio/AudioDecode.h"

#import <AudioToolbox/AudioToolbox.h>
#import <Foundation/Foundation.h>

#include <cmath>
#include <cstddef>
#include <cstdint>

namespace bridge
{
    bool decodeAudioFile (const std::string& path, Audio& out, std::string& error)
    {
        @autoreleasepool
        {
            NSURL* url = [NSURL fileURLWithPath: [NSString stringWithUTF8String: path.c_str ()]];
            ExtAudioFileRef file = nullptr;
            OSStatus status = ExtAudioFileOpenURL ((__bridge CFURLRef) url, &file);
            if (status != noErr)
            {
                error = "cannot open audio file " + path + " (OSStatus " + std::to_string (status) + ")";
                return false;
            }

            AudioStreamBasicDescription fileFormat {};
            UInt32 size = sizeof (fileFormat);
            status = ExtAudioFileGetProperty (file, kExtAudioFileProperty_FileDataFormat, &size, &fileFormat);
            const UInt32 channels = fileFormat.mChannelsPerFrame;
            if (status != noErr || channels == 0 || channels > 16)
            {
                ExtAudioFileDispose (file);
                error = "unsupported audio format in " + path;
                return false;
            }

            AudioStreamBasicDescription client {};
            client.mSampleRate = fileFormat.mSampleRate;
            client.mFormatID = kAudioFormatLinearPCM;
            client.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved;
            client.mBitsPerChannel = 32;
            client.mChannelsPerFrame = channels;
            client.mFramesPerPacket = 1;
            client.mBytesPerFrame = 4;
            client.mBytesPerPacket = 4;
            status = ExtAudioFileSetProperty (file, kExtAudioFileProperty_ClientDataFormat, sizeof (client), &client);
            if (status != noErr)
            {
                ExtAudioFileDispose (file);
                error = "cannot convert " + path + " to float (OSStatus " + std::to_string (status) + ")";
                return false;
            }

            Audio decoded;
            decoded.sampleRate = static_cast<int> (std::lround (fileFormat.mSampleRate));
            decoded.channels.assign (channels, std::vector<float> ());

            constexpr UInt32 chunk = 16384;
            std::vector<std::vector<float>> block (channels, std::vector<float> (chunk));
            std::vector<uint8_t> storage (offsetof (AudioBufferList, mBuffers) + sizeof (AudioBuffer) * channels);
            auto* list = reinterpret_cast<AudioBufferList*> (storage.data ());

            for (;;)
            {
                list->mNumberBuffers = channels;
                for (UInt32 c = 0; c < channels; ++c)
                {
                    list->mBuffers[c].mNumberChannels = 1;
                    list->mBuffers[c].mDataByteSize = chunk * sizeof (float);
                    list->mBuffers[c].mData = block[c].data ();
                }
                UInt32 frames = chunk;
                status = ExtAudioFileRead (file, &frames, list);
                if (status != noErr)
                {
                    ExtAudioFileDispose (file);
                    error = "error while reading " + path + " (OSStatus " + std::to_string (status) + ")";
                    return false;
                }
                if (frames == 0)
                    break;
                for (UInt32 c = 0; c < channels; ++c)
                    decoded.channels[c].insert (decoded.channels[c].end (), block[c].begin (), block[c].begin () + frames);
            }

            ExtAudioFileDispose (file);
            out = std::move (decoded);
            return true;
        }
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cmake --build build/host-tests -j 2>&1 | tail -3 && build/host-tests/bridge_tests decode_
```

Expected: every `decode_*` test `[  OK  ]` and `0 failure(s)`. The implementation shipped with 23 `decode_*` tests (the two above plus robustness, format and priming tests; the MP3 and AIFF/FLAC/CAF/M4A fixtures need `lame` and `afconvert` and are skipped with a printed note when those are missing), so expect `23 test(s), 0 failure(s)` for this filter.

> **Note: encoder padding.** CoreAudio removes the encoder delay when the file says how large it is: M4A/MP4 AAC edit lists and the LAME/Xing tag in MP3 (tests `decode_codec_priming_is_removed`: same length as the source, lag 0). A tagless MP3 and raw ADTS AAC carry no such information, so their encoder padding stays in the decoded audio: the leading part (about 576 samples for MP3, 2112 for AAC) makes the clip that much late against the original. Measured with a 2.8 s clip: a tagless MP3 (`lame -t`) decodes 1512 frames too long and a raw ADTS AAC file (`afconvert -f adts`) 2664 frames too long. How Live handles those files is unknown. The device should warn about such source files, or the tool should document the limitation. Do not rely on sample accuracy for them.

- [ ] **Step 6: Commit**

```bash
git add host/audio host/tests/test_decode.cpp host/CMakeLists.txt
git commit -m "feat: decode any audio file to planar float with ExtAudioFile"
```

---

## Task 8: Plug-in discovery

**Files:**
- Create: `host/plugins/PlugInFinder.h`, `host/plugins/PlugInFinder.cpp`
- Modify: `host/CMakeLists.txt`
- Test: `host/tests/test_finder.cpp`

- [ ] **Step 1: Write the failing tests**

`host/tests/test_finder.cpp`:

```cpp
#include "check.h"
#include "testutil.h"

#include "plugins/PlugInFinder.h"

#include <filesystem>

TEST (finder_locates_bundles_in_search_dirs)
{
    const std::string a { makeTempDir ("fa") };
    const std::string b { makeTempDir ("fb") };
    std::filesystem::create_directories (b + "/Melodyne.vst3");
    std::filesystem::create_directories (a + "/VocAlign6Pro.vst3");

    const std::vector<std::string> dirs { a, b };
    CHECK (bridge::findPlugIn ("melodyne", {}, dirs) == b + "/Melodyne.vst3");
    CHECK (bridge::findPlugIn ("vocalign", {}, dirs) == a + "/VocAlign6Pro.vst3");
}

TEST (finder_returns_empty_when_missing_or_unknown)
{
    const std::string dir { makeTempDir ("fm") };
    CHECK (bridge::findPlugIn ("melodyne", {}, { dir }).empty ());
    CHECK (bridge::findPlugIn ("autotune", {}, { dir }).empty ());
}

TEST (finder_prefers_an_existing_override)
{
    const std::string dir { makeTempDir ("fo") };
    std::filesystem::create_directories (dir + "/Melodyne.vst3");
    std::filesystem::create_directories (dir + "/Custom.vst3");

    const std::map<std::string, std::string> good { { "melodyne", dir + "/Custom.vst3" } };
    CHECK (bridge::findPlugIn ("melodyne", good, { dir }) == dir + "/Custom.vst3");

    const std::map<std::string, std::string> stale { { "melodyne", dir + "/Gone.vst3" } };
    CHECK (bridge::findPlugIn ("melodyne", stale, { dir }) == dir + "/Melodyne.vst3");     // a stale override falls back to discovery
}

TEST (finder_default_dirs_include_system_and_user_folders)
{
    const auto dirs = bridge::defaultPlugInDirs ();
    CHECK (dirs.size () == 2);
    CHECK (dirs[0] == "/Library/Audio/Plug-Ins/VST3");
    CHECK (dirs[1].find ("/Library/Audio/Plug-Ins/VST3") != std::string::npos && dirs[1] != dirs[0]);
}
```

- [ ] **Step 2: Register in CMake**

In `host/CMakeLists.txt`: add `plugins/PlugInFinder.cpp` to `bridge_core` and `tests/test_finder.cpp` to `bridge_tests`.

- [ ] **Step 3: Run to verify it fails**

```bash
cmake -S host -B build/host-tests && cmake --build build/host-tests -j 2>&1 | tail -5
```

Expected: FAIL with `'plugins/PlugInFinder.h' file not found`.

- [ ] **Step 4: Implement**

`host/plugins/PlugInFinder.h`:

```cpp
#pragma once

#include <map>
#include <string>
#include <vector>

namespace bridge
{
    // "/Library/Audio/Plug-Ins/VST3" and "~/Library/Audio/Plug-Ins/VST3"
    std::vector<std::string> defaultPlugInDirs ();

    // plugin is "melodyne" or "vocalign". An override (from settings.json) wins when it exists on disk;
    // otherwise the first matching bundle in dirs. Returns an empty string when nothing is found.
    std::string findPlugIn (const std::string& plugin, const std::map<std::string, std::string>& overrides,
                            const std::vector<std::string>& dirs);
}
```

`host/plugins/PlugInFinder.cpp`:

```cpp
#include "plugins/PlugInFinder.h"

#include <cstdlib>
#include <sys/stat.h>

namespace bridge
{
    namespace
    {
        bool exists (const std::string& path)
        {
            struct stat info;
            return ::stat (path.c_str (), &info) == 0;
        }

        std::vector<std::string> bundleNames (const std::string& plugin)
        {
            if (plugin == "melodyne")
                return { "Melodyne.vst3" };
            if (plugin == "vocalign")
                return { "VocAlign6Pro.vst3" };
            return {};
        }
    }

    std::vector<std::string> defaultPlugInDirs ()
    {
        const char* home { std::getenv ("HOME") };
        return { "/Library/Audio/Plug-Ins/VST3", std::string { home != nullptr ? home : "" } + "/Library/Audio/Plug-Ins/VST3" };
    }

    std::string findPlugIn (const std::string& plugin, const std::map<std::string, std::string>& overrides,
                            const std::vector<std::string>& dirs)
    {
        const auto names = bundleNames (plugin);
        if (names.empty ())
            return {};

        const auto override = overrides.find (plugin);
        if (override != overrides.end () && exists (override->second))
            return override->second;

        for (const auto& dir : dirs)
            for (const auto& name : names)
                if (exists (dir + "/" + name))
                    return dir + "/" + name;
        return {};
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cmake --build build/host-tests -j 2>&1 | tail -3 && build/host-tests/bridge_tests
```

Expected: every test `[  OK  ]` and `25 test(s), 0 failure(s)` (4 wav, 10 realign, 5 job/result/settings, 2 decode, 4 finder).

- [ ] **Step 6: Commit**

```bash
git add host/plugins host/tests/test_finder.cpp host/CMakeLists.txt
git commit -m "feat: locate Melodyne and VocAlign bundles"
```

---

## Task 9: SDK setup script, patch set and build scripts

The host app is built inside Celemony's ARA SDK CMake project. This task makes that reproducible: a pinned clone, the companion SDKs, our small patch to the SDK's example code (extracted from the spike), and a hook for our `BridgeHost` target.

**Files:**
- Create: `host/patches/ara-examples-bridgehost.patch`
- Create: `tools/setup_sdk.sh`, `tools/build_host.sh`, `tools/build_tests.sh`

- [ ] **Step 1: Extract the patch from the spike's modified SDK clone**

The spike changed four SDK files (`VST3Loader.cpp/.h`, `CompanionAPIs.cpp/.h`). The spike's CMake hook and the ICST audio-file loader fix are NOT part of the patch (BridgeHost decodes audio itself).

```bash
cd <repo>
mkdir -p host/patches
git -C third_party/ARA_SDK/ARA_Examples diff -- ExamplesCommon TestHost > host/patches/ara-examples-bridgehost.patch
grep -c "^diff --git" host/patches/ara-examples-bridgehost.patch
grep "^diff --git" host/patches/ara-examples-bridgehost.patch
```

Expected: `4` and the four file names `ExamplesCommon/PlugInHosting/VST3Loader.cpp`, `.../VST3Loader.h`, `TestHost/CompanionAPIs.cpp`, `TestHost/CompanionAPIs.h`.

- [ ] **Step 2: Write the setup script**

`tools/setup_sdk.sh`:

```bash
#!/usr/bin/env bash
# Prepares Celemony's ARA SDK for building BridgeHost: pinned clone, VST3/AudioUnit SDKs,
# our patch to the SDK's example code, and the BridgeHost target hook. Safe to run repeatedly.
# ARABRIDGE_THIRD_PARTY overrides the install folder (default: <repo>/third_party).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TP="${ARABRIDGE_THIRD_PARTY:-$ROOT/third_party}"
SDK="$TP/ARA_SDK"
EX="$SDK/ARA_Examples"

ARA_SDK_URL="https://github.com/Celemony/ARA_SDK.git"
ARA_SDK_COMMIT="a2b1aac1d1d5c4eed387db85a9c0cdb7d460254c"
ARA_EXAMPLES_COMMIT="abd7c8aa5854591995e1fbf16f854c65b0998e8d"

mkdir -p "$TP"
if [ ! -d "$SDK/.git" ]; then
    git clone "$ARA_SDK_URL" "$SDK"
fi
git -C "$SDK" checkout --quiet "$ARA_SDK_COMMIT"
git -C "$SDK" submodule update --init --recursive

actual="$(git -C "$EX" rev-parse HEAD)"
if [ "$actual" != "$ARA_EXAMPLES_COMMIT" ]; then
    echo "unexpected ARA_Examples commit $actual (wanted $ARA_EXAMPLES_COMMIT)" >&2
    exit 1
fi

# companion SDKs, installed next to the ARA SDK by Celemony's own scripts. The guards are ours:
# install_AudioUnitSDK.cmake checks for a file its own pinned release no longer contains
# and fails on every rerun.
[ -f "$SDK/vst3sdk/cmake/modules/SMTG_VST3_SDK.cmake" ] || cmake -P "$SDK/install_vst3sdk.cmake"
[ -f "$SDK/AudioUnitSDK/Source/AUBase.cpp" ] || cmake -P "$SDK/install_AudioUnitSDK.cmake"

# our changes to the SDK's example code (a half-applied patch is reported, not guessed at)
PATCH="$ROOT/host/patches/ara-examples-bridgehost.patch"
if git -C "$EX" apply --reverse --check "$PATCH" 2>/dev/null; then
    echo "patch already applied"
elif git -C "$EX" apply --check "$PATCH" 2>/dev/null; then
    git -C "$EX" apply "$PATCH"
    echo "patch applied"
else
    echo "setup_sdk: the patch neither applies nor is it fully applied in $EX" >&2
    exit 1
fi

# the BridgeHost target: a symlink to host/ (the SDK's CMake helpers want sources under its own
# tree) and one include line at the end of the SDK's CMakeLists.txt
ln -sfn "$ROOT/host" "$EX/BridgeHost"
HOOK='include("${CMAKE_CURRENT_SOURCE_DIR}/BridgeHost/app/BridgeHost.cmake")'
if ! grep -qF "$HOOK" "$EX/CMakeLists.txt"; then
    printf '\n# BridgeHost hook (tools/setup_sdk.sh)\n%s\n' "$HOOK" >> "$EX/CMakeLists.txt"
fi

echo "SDK ready: $EX"
```

`tools/build_host.sh`:

```bash
#!/usr/bin/env bash
# Builds BridgeHost (Release, arm64) inside the SDK's CMake project and prints its path.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TP="${ARABRIDGE_THIRD_PARTY:-$ROOT/third_party}"
EX="$TP/ARA_SDK/ARA_Examples"
SYSROOT="$(ls -d /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX[0-9]*.[0-9]*.sdk | sort -V | tail -1)"

cmake -S "$EX" -B "$EX/build" -G Xcode \
    -DCMAKE_OSX_SYSROOT="$SYSROOT" -DCMAKE_OSX_ARCHITECTURES=arm64 -DSMTG_CREATE_PLUGIN_LINK=OFF >/dev/null
xcodebuild -project "$EX/build/ARA_Examples.xcodeproj" -configuration Release -target BridgeHost \
    ARCHS=arm64 ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO 2>&1 | tail -n "${BUILD_TAIL:-5}"

echo "$EX/build/bin/Release/BridgeHost"
```

`tools/build_tests.sh`:

```bash
#!/usr/bin/env bash
# Builds and runs the standalone unit tests.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cmake -S "$ROOT/host" -B "$ROOT/build/host-tests" -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build "$ROOT/build/host-tests" -j 2>&1 | tail -3
"$ROOT/build/host-tests/bridge_tests" "$@"
```

```bash
chmod +x tools/*.sh
```

- [ ] **Step 3: Verify the patch applies to a pristine SDK (fresh clone in a scratch folder)**

```bash
SCRATCH=/private/tmp/claude-501/arabridge-setup-check
rm -rf "$SCRATCH" && mkdir -p "$SCRATCH"
ARABRIDGE_THIRD_PARTY="$SCRATCH" tools/setup_sdk.sh 2>&1 | tail -6
git -C "$SCRATCH/ARA_SDK/ARA_Examples" diff --stat -- ExamplesCommon TestHost | tail -5
```

Expected: the last script lines are `patch applied` and `SDK ready: .../ARA_Examples`, and the diff stat lists the same four files (`171 insertions(+), 12 deletions(-)`, 156 changed lines in `VST3Loader.cpp`).

Note: the patched stock `ARATestHost` target no longer links (it lacks the VST3 `sdk_hosting`/`base` libraries the patched loader needs); the patched sources compile, and BridgeHost's own target links those libraries (Task 10). Don't use `ARATestHost` to check the SDK build.

(The `app/BridgeHost.cmake` the hook includes does not exist yet. That is fine until Task 10: CMake is only configured then.)

- [ ] **Step 4: Switch the project to the freshly set-up SDK**

The old `third_party` carries the spike's extra hacks. Keep it as a backup (it is git-ignored) and set up cleanly:

```bash
mv third_party third_party_spike_backup
tools/setup_sdk.sh 2>&1 | tail -4
```

Expected: `patch applied`, `SDK ready: <repo>/third_party/ARA_SDK/ARA_Examples`.

- [ ] **Step 5: Commit**

```bash
git add host/patches tools
git commit -m "build: reproducible ARA SDK setup with our patch set and BridgeHost hook"
```

---

## Task 10: BridgeHost core (headless) and the round-trip test

This is spec milestone 1. At the end, `BridgeHost --job <dir> --autorender` turns a job into `result.wav` + `result.json`, and with no edits the result is bit-identical to the source region.

**Files:**
- Create: `host/app/BridgeHost.cmake`
- Create: `host/app/MemoryAudioFile.h`
- Create: `host/app/BridgeDocument.h`, `host/app/BridgeDocument.cpp`
- Create: `host/app/OfflineRenderer.h`, `host/app/OfflineRenderer.cpp`
- Create: `host/app/ApplyJob.h`, `host/app/ApplyJob.cpp`
- Create: `host/app/HostApp.h`, `host/app/HostApp.mm` (stub for now)
- Create: `host/app/main.mm`
- Create: `tools/make_test_job.py`, `host/tests/headless_roundtrip.sh`

- [ ] **Step 1: Write the round-trip test first (it fails until the host exists)**

`tools/make_test_job.py`:

```python
#!/usr/bin/env python3
"""Creates a job folder for BridgeHost.

  make_test_job.py JOB_DIR --plugin melodyne [--source file.wav] [--start 1.0] [--end 3.0]
  make_test_job.py JOB_DIR --plugin vocalign [--guide guide.wav --dub dub.wav] [--start 1.0] [--end 3.0]

Without --source/--guide/--dub, 5 s test files are generated (a gliding tone with light noise).
Also writes compare.txt: "<file>\t<start seconds>" naming the file region the result must equal
when nothing is edited (used by host/tests/headless_roundtrip.sh).
"""
import argparse
import json
import math
import os
import random
import struct
import wave

SR = 44100


def write_test_wav(path, seconds, seed):
    rng = random.Random(seed)
    frames = int(seconds * SR)
    data = bytearray()
    for i in range(frames):
        t = i / SR
        env = 0.6 + 0.4 * math.sin(2 * math.pi * 1.7 * t)
        tone = 0.3 * math.sin(2 * math.pi * (200 * t + 30 * t * t)) + 0.2 * math.sin(2 * math.pi * (400 * t + 60 * t * t))
        for _ in range(2):
            v = env * tone + 0.03 * (rng.random() * 2 - 1)
            data += struct.pack("<h", int(max(-1.0, min(1.0, v)) * 32767))
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(bytes(data))


def clip(role, path, start, end, name):
    return {"role": role, "path": os.path.abspath(path), "startSec": start, "endSec": end, "startBeats": 0.0, "name": name}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("job_dir")
    ap.add_argument("--plugin", choices=["melodyne", "vocalign"], required=True)
    ap.add_argument("--source")
    ap.add_argument("--guide")
    ap.add_argument("--dub")
    ap.add_argument("--start", type=float, default=1.0)
    ap.add_argument("--end", type=float, default=3.0)
    ap.add_argument("--no-realign", action="store_true")
    args = ap.parse_args()

    job_dir = os.path.abspath(args.job_dir)
    os.makedirs(job_dir, exist_ok=True)

    def generated(name, seed):
        path = os.path.join(job_dir, name)
        write_test_wav(path, 5.0, seed)
        return path

    if args.plugin == "melodyne":
        source = args.source or generated("source.wav", 1)
        clips = [clip("source", source, args.start, args.end, "source")]
        compared = source
    else:
        guide = args.guide or generated("guide.wav", 1)
        dub = args.dub or generated("dub.wav", 2)
        clips = [clip("guide", guide, args.start, args.end, "guide"), clip("dub", dub, args.start, args.end, "dub")]
        compared = dub

    job = {"version": 1, "id": "test-" + args.plugin, "plugin": args.plugin, "placement": "takeLane",
           "realign": not args.no_realign, "song": {"tempo": 120.0}, "clips": clips}
    with open(os.path.join(job_dir, "job.json"), "w") as f:
        json.dump(job, f, indent=2)
    with open(os.path.join(job_dir, "compare.txt"), "w") as f:
        f.write("%s\t%s\n" % (os.path.abspath(compared), args.start))
    print("job written to", job_dir)


if __name__ == "__main__":
    main()
```

`host/tests/headless_roundtrip.sh`:

```bash
#!/usr/bin/env bash
# Headless round trip for both plug-ins: with no edits, BridgeHost's result must equal the source
# region bit for bit. Needs the plug-ins installed and BridgeHost + wavdiff built
# (tools/build_host.sh, tools/build_tests.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOST="$ROOT/third_party/ARA_SDK/ARA_Examples/build/bin/Release/BridgeHost"
WAVDIFF="$ROOT/build/host-tests/wavdiff"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for plugin in melodyne vocalign; do
    echo "== $plugin"
    python3 "$ROOT/tools/make_test_job.py" "$WORK/$plugin" --plugin "$plugin" >/dev/null
    perl -e 'alarm 180; exec @ARGV' "$HOST" --job "$WORK/$plugin" --autorender
    test -f "$WORK/$plugin/result.json"
    grep -Eq '"status" *: *"ok"' "$WORK/$plugin/result.json"
    IFS=$'\t' read -r compared start < "$WORK/$plugin/compare.txt"
    "$WAVDIFF" "$compared" "$WORK/$plugin/result.wav" --a-start "$start" --tol 0
done
echo "headless round trip OK"
```

```bash
chmod +x tools/make_test_job.py host/tests/headless_roundtrip.sh
```

- [ ] **Step 2: Run it to verify it fails**

```bash
tools/build_tests.sh >/dev/null && host/tests/headless_roundtrip.sh
```

Expected: FAIL with `.../build/bin/Release/BridgeHost: No such file or directory` (it exits nonzero; `set -e` stops at the first failure).

- [ ] **Step 3: Write the BridgeHost CMake target**

`host/app/BridgeHost.cmake` (included by the SDK's `ARA_Examples/CMakeLists.txt`, see `tools/setup_sdk.sh`; `CMAKE_CURRENT_SOURCE_DIR` is the SDK's `ARA_Examples` folder):

```cmake
# BridgeHost target. Reuses the SDK's TestHost classes (ARA document model + host interfaces)
# and adds the bridge code from host/ (reached through the BridgeHost symlink).

enable_language(OBJCXX)

set(BH "${CMAKE_CURRENT_SOURCE_DIR}/BridgeHost")

add_executable(BridgeHost
    # SDK TestHost: ARA host interfaces and model
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/ARAHostInterfaces/ARAArchivingController.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/ARAHostInterfaces/ARAAudioAccessController.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/ARAHostInterfaces/ARAContentAccessController.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/ARAHostInterfaces/ARAModelUpdateController.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/ARAHostInterfaces/ARAPlaybackController.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/ARADocumentController.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/CompanionAPIs.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/ModelObjects.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost/TestHost.cpp"
    # bridge code
    "${BH}/common/Wav.cpp"
    "${BH}/realign/Realign.cpp"
    "${BH}/plugins/PlugInFinder.cpp"
    "${BH}/jobio/Job.mm"
    "${BH}/audio/AudioDecode.mm"
    "${BH}/app/BridgeDocument.cpp"
    "${BH}/app/OfflineRenderer.cpp"
    "${BH}/app/ApplyJob.cpp"
    "${BH}/app/Playback.mm"
    "${BH}/app/HostApp.mm"
    "${BH}/app/main.mm"
)

target_include_directories(BridgeHost PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/TestHost"
    "${CMAKE_CURRENT_SOURCE_DIR}"
    "${BH}"
)

target_compile_definitions(BridgeHost PRIVATE
    -DARA_ENABLE_VST3=1
    -DARA_ENABLE_CLAP=0
)

target_compile_features(BridgeHost PRIVATE cxx_std_17)

target_compile_options(BridgeHost PRIVATE
    $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>
)

target_link_libraries(BridgeHost PRIVATE
    ARAExamplesCommon
    ARA_Host_Library
    pluginterfaces
    sdk_hosting
    sdk_common
    base
    "-framework ApplicationServices"
    "-framework Cocoa"
    "-framework AVFoundation"
    "-framework AudioToolbox"
    "-framework CoreAudio"
)

configure_ARA_Examples_target(BridgeHost)
```

(`Playback.mm` and `HostApp.mm` are in the list from the start; this task adds working stubs and Task 11 replaces them.)

- [ ] **Step 4: Write `MemoryAudioFile`**

`host/app/MemoryAudioFile.h`:

```cpp
#pragma once

// SDK headers first: the SDK's audio file header defines a constant that clashes with a macro from Cocoa.
#include "ExamplesCommon/AudioFiles/AudioFiles.h"

#include "common/Wav.h"

#include <utility>

// An ARA audio source backed by audio already decoded into memory.
class MemoryAudioFile : public AudioFileBase
{
public:
    MemoryAudioFile (const std::string& name, bridge::Audio audio)
    : AudioFileBase { name }, _audio { std::move (audio) }
    {}

    const bridge::Audio& audio () const { return _audio; }

    int64_t getSampleCount () const noexcept override { return static_cast<int64_t> (_audio.frames ()); }
    double getSampleRate () const noexcept override { return static_cast<double> (_audio.sampleRate); }
    int getChannelCount () const noexcept override { return _audio.channelCount (); }
    bool merits64BitSamples () const noexcept override { return false; }

    bool readSamples (int64_t samplePosition, int64_t samplesPerChannel, void* const buffers[], bool use64BitSamples) noexcept override
    {
        const int64_t frames { static_cast<int64_t> (_audio.frames ()) };
        for (int c { 0 }; c < _audio.channelCount (); ++c)
        {
            for (int64_t i { 0 }; i < samplesPerChannel; ++i)
            {
                const int64_t position { samplePosition + i };
                const float value { (position >= 0 && position < frames) ? _audio.channels[static_cast<size_t> (c)][static_cast<size_t> (position)] : 0.0f };
                if (use64BitSamples)
                    static_cast<double*> (buffers[c])[i] = static_cast<double> (value);
                else
                    static_cast<float*> (buffers[c])[i] = value;
            }
        }
        return true;
    }

    bool saveToFile (const std::string&) override { return false; }

private:
    bridge::Audio _audio;
};
```

- [ ] **Step 5: Write `BridgeDocument`**

`host/app/BridgeDocument.h`:

```cpp
#pragma once

#include "TestHost.h"
#include "app/MemoryAudioFile.h"
#include "jobio/Job.h"

#include <memory>
#include <vector>

// Builds the ARA document for a job: one track per clip, each with one region covering
// [startSec, endSec] of its source file. Track i belongs to job.clips[i].
class BridgeDocument
{
public:
    BridgeDocument (PlugInEntry* entry, const bridge::Job& job, std::vector<std::shared_ptr<MemoryAudioFile>> files);

    ARADocumentController* controller () const { return _controller; }
    Document* document () const { return _document; }

    size_t trackCount () const { return _files.size (); }
    size_t renderTrack () const { return _renderTrack; }            // melodyne: the source, vocalign: the dub
    std::vector<PlaybackRegion*> regions (size_t track) const;
    std::vector<ARA::ARAPlaybackRegionRef> regionRefs (size_t track) const;

    const bridge::Audio& sourceAudio (size_t track) const { return _files[track]->audio (); }
    double sampleRate (size_t track) const { return _files[track]->getSampleRate (); }
    int channelCount (size_t track) const { return _files[track]->getChannelCount (); }

private:
    std::unique_ptr<TestHost> _host;
    std::vector<std::shared_ptr<MemoryAudioFile>> _files;
    Document* _document {};
    ARADocumentController* _controller {};
    size_t _renderTrack {};
};
```

`host/app/BridgeDocument.cpp`:

```cpp
#include "app/BridgeDocument.h"

#include <algorithm>

BridgeDocument::BridgeDocument (PlugInEntry* entry, const bridge::Job& job, std::vector<std::shared_ptr<MemoryAudioFile>> files)
: _host { std::make_unique<TestHost> () },
  _files { std::move (files) }
{
    _document = _host->addDocument ("ARABridge " + job.id, entry);
    _controller = _host->getDocumentController (_document);

    double firstBeat { job.clips.front ().startBeats };
    for (const auto& clip : job.clips)
        firstBeat = std::min (firstBeat, clip.startBeats);

    _controller->beginEditing ();
    auto musicalContext { _host->addMusicalContext (_document, "Musical Context", { 1.0f, 0.0f, 0.0f }) };
    for (size_t i { 0 }; i < job.clips.size (); ++i)
    {
        const auto& clip { job.clips[i] };
        auto regionSequence { _host->addRegionSequence (_document, clip.role + " track", musicalContext, { 0.0f, 1.0f, 0.0f }) };
        auto audioSource { _host->addAudioSource (_document, _files[i].get (), "audioSource " + std::to_string (i)) };
        auto audioModification { _host->addAudioModification (_document, audioSource, clip.name, "audioModification " + std::to_string (i)) };

        const double duration { clip.endSec - clip.startSec };
        const double playbackStart { (clip.startBeats - firstBeat) * 60.0 / job.tempo };     // keeps the clips' real relative timing
        _host->addPlaybackRegion (_document, audioModification, ARA::kARAPlaybackTransformationNoChanges,
                                  clip.startSec, duration, playbackStart, duration, regionSequence, clip.role, { 0.0f, 0.0f, 1.0f });
        if (clip.role == "source" || clip.role == "dub")
            _renderTrack = i;
    }
    _controller->endEditing ();

    const auto factory { entry->getARAFactory () };
    for (auto& audioSource : _document->getAudioSources ())
    {
        _controller->enableAudioSourceSamplesAccess (audioSource.get (), true);
        if (factory->analyzeableContentTypesCount > 0)
            _controller->requestAudioSourceContentAnalysis (audioSource.get (), factory->analyzeableContentTypesCount, factory->analyzeableContentTypes, false);
    }
}

std::vector<PlaybackRegion*> BridgeDocument::regions (size_t track) const
{
    std::vector<PlaybackRegion*> result;
    if (track < _document->getRegionSequences ().size ())
        for (const auto& region : _document->getRegionSequences ()[track]->getPlaybackRegions ())
            result.push_back (region);
    return result;
}

std::vector<ARA::ARAPlaybackRegionRef> BridgeDocument::regionRefs (size_t track) const
{
    std::vector<ARA::ARAPlaybackRegionRef> refs;
    for (auto* region : regions (track))
        refs.push_back (_controller->getRef (region));
    return refs;
}
```

- [ ] **Step 6: Write the offline renderer**

`host/app/OfflineRenderer.h`:

```cpp
#pragma once

#include "app/BridgeDocument.h"
#include "common/Wav.h"

#include <functional>
#include <string>

// Renders one track's regions offline through a fresh playback-renderer instance of the plug-in.
// The render runs on a worker thread; the calling thread keeps calling idle() (pump the run loop in the
// UI, sleep in headless mode) until it finishes. The output covers exactly the region(s) of the track.
bool renderTrack (PlugInEntry& entry, BridgeDocument& document, size_t track, const std::function<void ()>& idle,
                  bridge::Audio& out, std::string& error);
```

`host/app/OfflineRenderer.cpp`:

```cpp
#include "app/OfflineRenderer.h"

#include "ExamplesCommon/PlugInHosting/VST3Loader.h"
#include "ARA_Library/Utilities/ARASamplePositionConversion.h"

#include <algorithm>
#include <atomic>
#include <limits>
#include <thread>

namespace
{
    constexpr int kRenderBlockSize { 2048 };

    // switches the loader to offline processing for the lifetime of the object
    struct OfflineMode
    {
        OfflineMode () { VST3SetOfflineRendering (1); }
        ~OfflineMode () { VST3SetOfflineRendering (0); }
    };
}

bool renderTrack (PlugInEntry& entry, BridgeDocument& document, size_t track, const std::function<void ()>& idle,
                  bridge::Audio& out, std::string& error)
{
    const auto regions { document.regions (track) };
    if (regions.empty ())
    {
        error = "the track has no regions to render";
        return false;
    }

    OfflineMode offline;
    auto instance { entry.createPlugInInstance () };
    instance->bindToDocumentControllerWithRoles (document.controller ()->getDocumentController ()->getRef (), ARA::kARAPlaybackRendererRole);
    auto renderer { instance->getPlaybackRenderer () };

    // The output covers the region(s); head and tail time (plug-in reverb tails etc.) are rendered but cropped.
    double regionStart { std::numeric_limits<double>::max () }, regionEnd { std::numeric_limits<double>::lowest () };
    double renderStart { regionStart }, renderEnd { regionEnd };
    for (auto* region : regions)
    {
        renderer.addPlaybackRegion (document.controller ()->getRef (region));
        double head { 0.0 }, tail { 0.0 };
        document.controller ()->getPlaybackRegionHeadAndTailTime (region, &head, &tail);
        regionStart = std::min (regionStart, region->getStartInPlaybackTime ());
        regionEnd = std::max (regionEnd, region->getEndInPlaybackTime ());
        renderStart = std::min (renderStart, region->getStartInPlaybackTime () - head);
        renderEnd = std::max (renderEnd, region->getEndInPlaybackTime () + tail);
    }

    const double sampleRate { document.sampleRate (track) };
    const size_t channelCount { static_cast<size_t> (document.channelCount (track)) };
    const auto firstSample { ARA::samplePositionAtTime (renderStart, sampleRate) };
    const auto endSample { ARA::samplePositionAtTime (renderEnd, sampleRate) };
    if (endSample <= firstSample)
    {
        error = "empty render range";
        return false;
    }

    std::vector<std::vector<float>> buffer (channelCount, std::vector<float> (static_cast<size_t> (endSample - firstSample), 0.0f));

    instance->startRendering (static_cast<int> (channelCount), kRenderBlockSize, sampleRate);
    std::atomic<bool> finished { false };
    std::thread worker ([&] {
        std::vector<float*> pointers (channelCount);
        for (auto position { firstSample }; position < endSample; position += kRenderBlockSize)
        {
            const int count { std::min (kRenderBlockSize, static_cast<int> (endSample - position)) };
            for (size_t c { 0 }; c < channelCount; ++c)
                pointers[c] = buffer[c].data () + (position - firstSample);
            instance->renderSamples (count, position, pointers.data ());
        }
        finished = true;
    });
    while (! finished)
        idle ();
    worker.join ();
    instance->stopRendering ();

    // crop to the region(s)
    const auto cropFrom { ARA::samplePositionAtTime (regionStart, sampleRate) - firstSample };
    const auto cropEnd { ARA::samplePositionAtTime (regionEnd, sampleRate) - firstSample };
    out.sampleRate = static_cast<int> (sampleRate);
    out.channels.assign (channelCount, std::vector<float> ());
    for (size_t c { 0 }; c < channelCount; ++c)
        out.channels[c].assign (buffer[c].begin () + cropFrom, buffer[c].begin () + cropEnd);
    return true;
}
```

- [ ] **Step 7: Write `ApplyJob`**

`host/app/ApplyJob.h`:

```cpp
#pragma once

#include "app/BridgeDocument.h"
#include "jobio/Job.h"

#include <functional>

// Renders the job's track offline, realigns it when requested (Melodyne only), writes <job>/result.wav
// and <job>/result.json. On failure result.json is written only when writeResultOnError is true
// (headless mode; in the UI the user can simply retry).
bridge::ResultInfo applyJob (PlugInEntry& entry, BridgeDocument& document, const bridge::Job& job,
                             const std::function<void ()>& idle, bool writeResultOnError);
```

`host/app/ApplyJob.cpp`:

```cpp
#include "app/ApplyJob.h"

#include "app/OfflineRenderer.h"
#include "realign/Realign.h"

#include <cmath>

namespace
{
    bridge::ResultInfo failed (const bridge::Job& job, const std::string& message, bool writeResultOnError)
    {
        bridge::ResultInfo info;
        info.status = "error";
        info.message = message;
        std::string ignored;
        if (writeResultOnError)
            bridge::writeResult (job.dir, job.id, info, ignored);
        return info;
    }
}

bridge::ResultInfo applyJob (PlugInEntry& entry, BridgeDocument& document, const bridge::Job& job,
                             const std::function<void ()>& idle, bool writeResultOnError)
{
    std::string error;
    bridge::Audio rendered;
    if (! renderTrack (entry, document, document.renderTrack (), idle, rendered, error))
        return failed (job, error, writeResultOnError);

    bridge::ResultInfo info;
    bridge::Audio finalAudio { rendered };
    if (job.plugin == "melodyne" && job.realign)
    {
        const auto& clip { job.clips[document.renderTrack ()] };
        const auto startFrame { static_cast<int64_t> (std::llround (clip.startSec * document.sampleRate (document.renderTrack ()))) };
        const bridge::Audio original { bridge::cropAudio (document.sourceAudio (document.renderTrack ()), startFrame, static_cast<int64_t> (rendered.frames ())) };

        const auto realigned = bridge::realign (original, rendered, bridge::RealignParams {}, finalAudio);
        info.realignApplied = realigned.applied;
        info.shifts = realigned.segments;
        info.message = realigned.note;
    }

    const std::string resultPath { job.dir + "/result.wav" };
    if (! bridge::writeWavFloat32 (resultPath, finalAudio, error))
        return failed (job, error, writeResultOnError);

    info.status = "ok";
    info.resultPath = resultPath;
    if (! bridge::writeResult (job.dir, job.id, info, error))
        return failed (job, error, false);
    return info;
}
```

- [ ] **Step 8: Write the UI stubs (replaced in Task 11)**

`host/app/HostApp.h`:

```cpp
#pragma once

#include "app/BridgeDocument.h"
#include "jobio/Job.h"

struct AppContext
{
    PlugInEntry* entry {};
    BridgeDocument* document {};
    bridge::Job job;
};

// Runs the Cocoa UI until the window closes; returns the process exit code.
int runHostApp (AppContext& context);
```

`host/app/HostApp.mm` (stub):

```objc
#include "app/HostApp.h"

#include <cstdio>

int runHostApp (AppContext&)
{
    std::printf ("BridgeHost: the UI is not implemented yet (use --autorender)\n");
    return 1;
}
```

`host/app/Playback.h` (final interface, used in Task 11):

```cpp
#pragma once

#include "CompanionAPIs.h"

#include <cstdint>
#include <memory>

// Real-time playback of an ARA plug-in instance (editor renderer) through the default output device.
// The instance must already have been startRendering()-ed with the same channel count and sample rate.
class Playback
{
public:
    static constexpr int kMaxBlock { 4096 };      // pass this to PlugInInstance::startRendering

    Playback (PlugInInstance* instance, int channelCount, double sampleRate);
    ~Playback ();

    void play (int64_t fromSample);
    void stop ();
    bool isPlaying () const;
    int64_t positionSamples () const;

private:
    struct Impl;
    std::unique_ptr<Impl> _impl;
};
```

`host/app/Playback.mm` (stub):

```objc
#include "app/Playback.h"

struct Playback::Impl {};

Playback::Playback (PlugInInstance*, int, double) : _impl { new Impl } {}
Playback::~Playback () = default;
void Playback::play (int64_t) {}
void Playback::stop () {}
bool Playback::isPlaying () const { return false; }
int64_t Playback::positionSamples () const { return 0; }
```

- [ ] **Step 9: Write `main.mm`**

`host/app/main.mm`:

```objc
// BridgeHost --job <job folder> [--autorender]
//
// Loads the job, hosts the plug-in as an ARA plug-in and either renders the job headlessly
// (--autorender: no edits, so the result equals the source) or opens the editor window.

// SDK headers first (see MemoryAudioFile.h)
#include "TestHost.h"
#include "app/ApplyJob.h"
#include "app/BridgeDocument.h"
#include "app/HostApp.h"
#include "app/MemoryAudioFile.h"

#include "audio/AudioDecode.h"
#include "jobio/Job.h"
#include "plugins/PlugInFinder.h"

#import <Foundation/Foundation.h>

#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <unistd.h>
#include <vector>

ARA::ARAAssertFunction assertFunction { &ARA::ARAInterfaceAssert };
ARA::ARAAssertFunction* assertFunctionReference { &assertFunction };

ARA_SETUP_DEBUG_MESSAGE_PREFIX ("BridgeHost");

namespace
{
    int fail (const std::string& jobDir, const std::string& jobId, const std::string& message, int exitCode)
    {
        std::fprintf (stderr, "BridgeHost: %s\n", message.c_str ());
        bridge::ResultInfo info;
        info.status = "error";
        info.message = message;
        std::string ignored;
        if (! jobDir.empty ())
            bridge::writeResult (jobDir, jobId.empty () ? "unknown" : jobId, info, ignored);
        return exitCode;
    }
}

int main (int argc, const char* argv[])
{
    @autoreleasepool
    {
        std::string jobDir;
        bool autorender { false };
        for (int i { 1 }; i < argc; ++i)
        {
            if (std::strcmp (argv[i], "--job") == 0 && i + 1 < argc)
                jobDir = argv[++i];
            else if (std::strcmp (argv[i], "--autorender") == 0)
                autorender = true;
        }
        if (jobDir.empty ())
        {
            std::fprintf (stderr, "usage: BridgeHost --job <job folder> [--autorender]\n");
            return 2;
        }

        bridge::Job job;
        std::string error;
        if (! bridge::loadJob (jobDir, job, error))
            return fail (jobDir, "", error, 2);

        const auto pluginPath { bridge::findPlugIn (job.plugin, bridge::loadPlugInOverrides (bridge::defaultSettingsPath ()), bridge::defaultPlugInDirs ()) };
        if (pluginPath.empty ())
            return fail (jobDir, job.id, "the " + job.plugin + " plug-in was not found", 3);

        ARA::ARASetExternalAssertReference (assertFunctionReference);
        auto entry { PlugInEntry::parsePlugInEntry ({ "BridgeHost", "-vst3", pluginPath }) };
        if (! entry || ! entry->getARAFactory ())
            return fail (jobDir, job.id, pluginPath + " could not be loaded as an ARA plug-in", 3);

        std::vector<std::shared_ptr<MemoryAudioFile>> files;
        for (const auto& clip : job.clips)
        {
            bridge::Audio audio;
            if (! bridge::decodeAudioFile (clip.path, audio, error))
                return fail (jobDir, job.id, error, 4);
            const double seconds { static_cast<double> (audio.frames ()) / audio.sampleRate };
            if (clip.endSec > seconds + 0.001)
                return fail (jobDir, job.id, "clip '" + clip.name + "' ends after the end of its audio file", 4);
            files.push_back (std::make_shared<MemoryAudioFile> (clip.name, std::move (audio)));
        }

        entry->initializeARA (assertFunctionReference);
        int exitCode { 0 };
        {
            BridgeDocument document { entry.get (), job, files };
            if (autorender)
            {
                const auto info { applyJob (*entry, document, job, [] { usleep (10000); }, true) };
                std::printf ("BridgeHost: %s%s%s\n", info.status.c_str (), info.message.empty () ? "" : " - ", info.message.c_str ());
                exitCode = info.status == "ok" ? 0 : 5;
            }
            else
            {
                AppContext context;
                context.entry = entry.get ();
                context.document = &document;
                context.job = job;
                exitCode = runHostApp (context);
            }
        }
        entry->uninitializeARA ();
        return exitCode;
    }
}
```

- [ ] **Step 10: Build BridgeHost**

```bash
tools/build_host.sh
```

Expected: ends with `** BUILD SUCCEEDED **` and the printed path `.../ARA_Examples/build/bin/Release/BridgeHost`. If compilation fails, fix the reported error in the file named (the code above is adapted from the verified spike; likely candidates are include order and a missing header).

- [ ] **Step 11: Run the round-trip test**

```bash
host/tests/headless_roundtrip.sh
```

Expected output:

```
== melodyne
BridgeHost: ok - render already aligned; nothing to do
frames 88200, max abs diff 0
== vocalign
BridgeHost: ok
frames 88200, max abs diff 0
headless round trip OK
```

(`frames 88200` is 2 s at 44.1 kHz. The Melodyne message text may differ slightly; `max abs diff 0` and the final line are what matters.)

If VocAlign fails headless but Melodyne passes, run `build/.../BridgeHost --job <dir> --autorender` by hand and read `~/Library/Logs/DiagnosticReports/BridgeHost*.ips`; the spike showed VocAlign needs the controller connected and a real host context, both of which the patched loader provides.

- [ ] **Step 12: Commit**

```bash
git add host/app host/tests/headless_roundtrip.sh tools/make_test_job.py
git commit -m "feat: BridgeHost headless mode renders a job to result.wav and result.json"
```

---

## Part C: Window, playback, Apply

## Task 11: Playback and the editor window

This is spec milestone 2. **As built** (deviation 7): the code lives in `host/app/Playback.mm` and `host/app/HostApp.mm`; the first draft of this task's snippets started Apply inside a main-queue block and quit through `terminate:`, both of which are wrong (see below), so the snippets were replaced by this description. The real files win.

**Files:**
- Modify: `host/app/Playback.h`, `host/app/Playback.mm` (replace the stub)
- Modify: `host/app/HostApp.h`, `host/app/HostApp.mm` (replace the stub)
- Modify: `host/app/main.mm` (activation policy, Apply budget, teardown alarm, environment notes)
- Modify: `host/hostcore/ApplyJob.cpp` (result.json published exclusively; realign notes go to diagnostics)
- Modify: `host/hostcore/RunGuard.*` (exit fallback), `host/app/BridgeDocument.h` (`notifyModelUpdates`)
- Modify: SDK patch (`TestHost/ARADocumentController.*`, `ARAHostInterfaces/ARAPlaybackController.cpp`), `tools/setup_sdk.sh` (the expected patched files come from the patch)
- Create (Output menu, item 16): `host/hostcore/AudioOutput.h/.cpp` (device list model, choice, titles, status text), `host/audio/OutputDevices.h/.mm` (CoreAudio list, default device, IO running, change listener), `host/tests/test_audiooutput.cpp`; `host/jobio/Job.*` (`loadAudioSettings` / `saveAudioSettings`)

- [x] **Step 1: Playback** (`Playback.h/.mm`)

`AVAudioEngine` with an `AVAudioSourceNode` (the clip's channel count and rate; the main mixer converts to the device) whose render block calls the editor instance's `renderSamples` in chunks of at most `kMaxBlock` (4096), over the render track's region on the playback timeline (`[playbackStart, playbackStart + frames)`), and stops by itself at the region end. Lock-free atomics only on the audio thread. `stats()` (render callbacks, frames, peak) and `deviceDescription()` (default output device, running state, nominal rate) go to the log, so playback can be verified without listening. The destructor stops the engine, after which the plug-in is no longer called from the audio thread. Uses `connect:to:format:error:` on macOS 27 (the old call is deprecated there). Since the Output menu (item 16): the engine is built for a given device (`kAudioOutputUnitProperty_CurrentDevice` on `outputNode.audioUnit`, set before `mainMixerNode` is touched; 0 = the system default, resolved at build time), mixer -> output connected explicitly with min(2, device channels) at the device's nominal rate (the device's rate is never changed; the output unit maps to the device's first channels, a mono device gets a mono mix). `setOutputDevice` builds a new engine and source node (also while playing; play state, position and cycle stay; the old engine is stopped first, so the plug-in is never called from two IO threads), with up to 6 attempts 100 ms apart (P1 refused itself with `'nope'` right after a virtual device's engine stopped). `deviceDescription()` reads the device back from the output unit.

- [x] **Step 2: The window** (`HostApp.mm`)

1. The editor instance is created and bound with all three roles for the render track's regions and started (`startRendering`, max block 4096) **before** any offline render, so it keeps the realtime process mode (the loader fixes the mode per effect at `VST3StartRendering`; Apply's render instances run offline).
2. Window: editor view above a bar with **Play**, **Apply to Live**, **Cancel** and a status line (`x += 88;` after Cancel is where Task 13 adds the track buttons). The window is clamped to the screen's visible area (92% x 85%), `IPlugView::onSize` follows resizes, `releasedWhenClosed = NO` (ARC owns it; it must outlive the editor view). The activation policy is set to Regular in `main.mm` before the licence check (the plug-in may show its activation dialog), the window is ordered front with `[NSApp activate]` plus `orderFrontRegardless` (activation is only a request since macOS 14).
3. **Apply** stops playback, shows a sheet (status text + Cancel) that blocks the editor while rendering, and starts the work from a run loop timer (`performSelector:afterDelay:0 inModes:NSRunLoopCommonModes`), never from a `dispatch_async` main-queue block: a nested run loop inside a main-queue block does not drain other main-queue blocks the plug-in may post. It first waits for the analysis (`waitForAnalysis`), then `renderJobClip` + `applyJob` (writes nothing on failure, so the user can retry). The idle function pumps one event (`nextEventMatchingMask` + `sendEvent`, which also runs timers, sources and main-queue blocks) and returns false from the first stop request on: Cancel, window close, Quit, a stop signal, or the Apply budget (`ARABRIDGE_TIMEOUT_SEC`, default 300 s + 4 s per second of audio). A render that does not end within the grace time after that is given up: `result.json` is written (cancelled, or the timeout fallback) and the process exits.
4. **Leaving**: closing the window (close button, Cancel, Quit menu item, a quit Apple event, a stop signal) writes `result.json` with status `cancelled` unless a result is already there (exclusive publish + `markResultWritten`), then `[NSApp stop:]` plus a posted application-defined event, so `[NSApp run]` returns and everything is torn down in order: playback (engine stop), editor `stopRendering`, regions removed from both renderers, editor instance (and its view), window; then `main.mm` destroys the document and calls `uninitializeARA` and logs `torn down, exit code N`. `applicationShouldTerminateAfterLastWindowClosed` is not used (it leads to `terminate:`, which calls `exit()`). AppKit's `terminate:` does nothing while a sheet is shown, so the Quit menu item and the quit Apple event go straight to the delegate (`quitClicked:`); `applicationShouldTerminate:` does the same and returns `NSTerminateCancel`. During Apply, all of these only request the stop; the window closes once the render has ended.
5. **Stop signals**: a 100 ms timer polls `stopRequested()`. While editing it closes the job with status `cancelled`, message `stopped by SIGTERM before Apply`, exit code 6; during Apply the idle function stops the render first (message `... while rendering`). A second signal still writes the error fallback at once (RunGuard).
6. Exit codes: 0 after Apply, 1 closed by the user, 6 stopped by a signal or given up after a timeout. The 30 s teardown alarm now covers the window mode too.
7. `applyJob` publishes `result.json` exclusively (never over one written meanwhile); ok results carry `sourceStartFrame`, `frames`, `sampleRate`; render diagnostics go to `diagnostics`, not `message`.
8. Test hooks (environment, seconds after the editor opened, same code as the buttons): `ARABRIDGE_TEST_AUTOPLAY`, `ARABRIDGE_TEST_AUTOAPPLY`, `ARABRIDGE_TEST_AUTOCANCEL`; `ARABRIDGE_TEST_HANG=render|render-soft` and `ARABRIDGE_TIMEOUT_SEC` work for Apply too. Added after the review: `ARABRIDGE_TEST_TRANSPORT` (the plug-in's transport requests), `ARABRIDGE_TEST_AUDIO_RESTART` (simulated output device change), `ARABRIDGE_TEST_KEYS` (`seconds:space|escape,...` posted to the window), `ARABRIDGE_TEST_STARTUP_DELAY` (modal wait before the licence check) with `ARABRIDGE_TEST_STARTUP_TERMINATE` (`[NSApp terminate:]`, or `exit()` if `exit`).
9. **Model updates** (SDK patch `ARADocumentController::notifyModelUpdates`, which sets the polling flag the SDK's validation checks and skips open edit cycles): ARA hosts must call `notifyModelUpdates` periodically when not editing; TestHost only did it inside its own analysis wait, which BridgeHost bypasses. Called from the window's 100 ms timer, Apply's idle and the headless idle (`BridgeDocument::notifyModelUpdates`).
10. **The plug-in's transport** (SDK patch: `ARADocumentController::setPlaybackRequestHandler`; `ARAPlaybackController` forwards to it): start/stop drive the window's playback (only while editing), a position request seeks within the region (also while playing), cycle range + enable loop that range (played on past it if the play position is after the cycle end, as DAWs do). After the final review: the ARA API allows these calls from any thread except render threads, so the patch no longer checks the thread in the five forwards and the handler pointer is atomic; `TransportRequests` posts a call from another thread to the main queue (all state stays on the main thread; the Space dedup uses the call time), and the handler object lives for the rest of the process (`detach()` at teardown drops requests still queued). Test hook `bg-start` / `bg-stop` in `ARABRIDGE_TEST_KEYS` (through `getPlaybackControllerForTests`, from a background queue): played from sample 0, stopped at 44288, no ARA violation. The Play button follows the playback state on every timer tick. The plug-in's editor gets keyboard focus when the window opens (first view under the editor holder that accepts it).
11. **Quit before the window opens** (e.g. while a licence dialog is up): `installEarlyQuitHandler()` (main.mm, window mode, before the licence check) handles the quit Apple event and is the app delegate (so `terminate:` asks it): it only marks the job, and `runHostApp` then writes `cancelled` ("quit before the window opened") without opening the window. Net for any `exit()` from then on: `bridge::armExitFallback()` (RunGuard) publishes a prepared `cancelled` result.json at exit unless a result was written, with the same async-signal-safe writer as the fallbacks. It is armed after the plug-in is loaded, so it runs before the plug-in's own exit-time destructors (Melodyne aborts in them when the process calls `exit()` with it loaded).
12. **Output device changes**: on `AVAudioEngineConfigurationChangeNotification` the engine is restarted on the main thread; if that fails, playback stops and the Play button is disabled.
13. **Escape** in the main window cancels the job through the responder chain (`cancelOperation:` in the window delegate), so it only fires when the plug-in's editor does not use Escape itself (a key equivalent on the button would take Escape away from the editor). The Apply sheet's Cancel has Escape as key equivalent.
14. `result.json` `message` no longer carries realign jargon: it says "Melodyne's timing shift after the edit was corrected." when the realignment moved audio, else nothing; realign's note goes to `diagnostics` ("realign: ...").
15. **Space** (found in the first manual test: nothing happened): Melodyne's root view overrides `keyDown:` but passes Space up unused, and issues no transport request (measured with posted events: the key reaches `BridgeWindow keyDown:` and ends in `noResponderFor:`). `BridgeWindow.keyDown:` hands unused keys to the delegate: plain Space (no modifiers, not a repeat, editing phase, no sheet, first responder not text) toggles playback like the Play button. A plug-in start/stop request less than 150 ms before the key reached the window, or less than 150 ms after the host toggled, never causes a second toggle (decision in `hostcore/TransportKey`, unit-tested). Also found: with the window key, `NSWindow`'s own `cancelOperation:` answered Escape without asking the delegate, so `BridgeWindow` forwards it to Cancel. Test hooks: `request-start` / `request-stop` in `ARABRIDGE_TEST_KEYS`. A Space the plug-in uses itself without a request and without passing it on cannot be seen by the host.
16. **Output menu** (found in the first test from Live: no sound, no way to choose the output; the host played to the system default while Live and the user's monitors use the interface P1, and an ARA plug-in has no audio device settings of its own). `Output:` pop-up at the right of the bar: "System default (<name>)", then every CoreAudio device with output channels that is not hidden and has a UID, titled "<name> (<transport>)" (e.g. "P1 (USB)"; items added directly so two devices with one name both appear). The pop-up refuses first responder (Space stays Play/Stop), gives the editor its focus back after a choice and is disabled during Apply. A choice switches at once (also while playing) and is saved to `~/Library/Application Support/ARABridge/audio.json` (`{"outputUID": ..., "outputName": ...}`; System default writes `{}`); `ARABRIDGE_AUDIO_SETTINGS` names another file. Start: `ARABRIDGE_AUDIO_OUTPUT_UID` (a UID, or `default`; never saved), else audio.json, else the system default; a UID that is not connected falls back to the system default with the status `Output: System default (saved device not available)` and is used again when it comes back; a corrupt audio.json is a warning (system default) and is replaced by the next choice. A CoreAudio listener (device list, default output) refreshes the menu: the chosen device going away stops playback (never goes on loudly elsewhere) and falls back to the default; with System default selected, a new default is followed (also while playing, as before). The configuration-change restart (item 12) now builds the engine again for the same selection (connections may be stale after a rate change, e.g. when Live changes P1's rate), and ignores a notification while the engine still runs (no loop). Log: `audio devices: [117] MacBook Pro Speakers (Built-in, 2 ch, 48000 Hz, default, selected), [152] P1 (USB, 4 ch, 88200 Hz), ...`, `audio output UIDs: ...` (for the override), `audio output: P1 (device 152), 2 ch, rate 88200 Hz, running, device IO running` after every switch or restart. Status while editing: `Edit, then press Apply to Live.   Output: P1`. **Output check**: 500 ms after Play, no render callbacks or a stopped engine sets the status to `No audio from the output device - choose another output`; the log line `output check: N render callbacks in 500 ms, engine running, device D IO running here, running somewhere; peak so far P` says what happened. Test hook `ARABRIDGE_TEST_SELECT_OUTPUT="seconds:UID;seconds:default"` (same path as the menu; saved only with `ARABRIDGE_AUDIO_SETTINGS` set). A host launched from Max inherits the system default output, which may differ from Live's interface: the menu (and audio.json) is how the user picks Live's interface.

- [x] **Step 3: Build**

```bash
tools/build_host.sh
```

Expected: `** BUILD SUCCEEDED **` and no warnings from `BridgeHost/` files.

- [x] **Step 4: Automated checks in window mode** (run from a shell; the window appears on screen)

```bash
H=third_party/ARA_SDK/ARA_Examples/build/bin/Release/BridgeHost
python3 tools/make_test_job.py /tmp/bj-m --plugin melodyne --source spike/out_session2/render_1.wav --start 0.25 --end 19.5
ARABRIDGE_TEST_AUTOPLAY=1 ARABRIDGE_TEST_AUTOAPPLY=4 perl -e 'alarm 180; exec @ARGV' $H --job /tmp/bj-m; echo "exit $?"
IFS=$'\t' read -r f s n < /tmp/bj-m/compare.txt; build/host-tests/wavdiff "$f" /tmp/bj-m/result.wav --a-start $s --tol 1e-7
python3 tools/make_test_job.py /tmp/bj-v --plugin vocalign
ARABRIDGE_TEST_AUTOPLAY=1 ARABRIDGE_TEST_AUTOAPPLY=3 perl -e 'alarm 180; exec @ARGV' $H --job /tmp/bj-v; echo "exit $?"
IFS=$'\t' read -r f s n < /tmp/bj-v/compare.txt; build/host-tests/wavdiff "$f" /tmp/bj-v/result.wav --a-start $s --tol 0
```

Results (2026-10-22, Melodyne 5.4.2, VocAlign 6 Pro, output to a 48 kHz device):
- Melodyne, 20 s vocal: log `audio output started`, `editor attached: wants 2355x1154, shown at 2355x1154; screen area 2560x1410`, playback ran (`peak 0.59`, stopped by Apply at sample 132183), result within 1e-7 (max 3.0e-8), exit 0, `frames`/`sourceStartFrame`/`sampleRate` in `result.json`. Region 5..9 s: one doubled sample repaired (frame 167936), max 3.0e-8.
- VocAlign (generated guide/dub): editor reports no size (host uses 1100x640), playback peak 0.46, result bit-identical, exit 0.
- Cancel paths (generated 2 s Melodyne job): Cancel while editing -> cancelled, exit 1; SIGTERM while editing -> cancelled, exit 6; quit Apple event while editing and during Apply -> cancelled, exit 1; Cancel / SIGTERM during Apply (`render-soft`) -> cancelled `... while rendering`, no `result.wav`, exit 1 / 6; render ignoring stop (`render`) + Cancel / SIGTERM -> given up after the grace time, cancelled, exit 1 / 6; Apply timeout (`render-soft`, budget 3 s) -> "Apply failed: timed out", window stays, a later Cancel -> cancelled, exit 1; timeout with a render ignoring stop -> timeout fallback (error), exit 6. No temp files left in any case.
- Main-queue blocks during Apply (temporary probe, not committed: a thread posting a main-queue block every 200 ms while a `render-soft` Apply ran): with Apply started from the run loop timer the blocks ran during the render; with Apply started from `dispatch_async(main_queue)` (the old draft) they all waited until the render had ended.
- Apply pressed at once (`ARABRIDGE_TEST_AUTOAPPLY=0`) on a new 4-minute clip: waited 2.87 s for the analysis, then rendered; result within 1e-7 (max 4.5e-8, 10,517,850 frames). (On the 20 s vocal the analysis is done before the window opens.)
- Playback after a failed (timed-out) Apply still renders audio (173 callbacks, peak 0.46): the editor instance keeps its realtime mode.
- After the review: no `ARA_ASSERT`/`ARA_WARN` in the unified log with `notifyModelUpdates` polling (`/usr/bin/log show --predicate 'process == "BridgeHost"'`), and the model update controller's content logs (notes, tempo) now appear, so the plug-in's updates arrive; no-edit results unchanged (within 1e-7 / bit-identical). Transport test: position 1 s + start played from sample 44100, stop after 1 s at 88132; cycle 0.5..1 s from 0.6 s for 2 s stopped at 26324 (inside the cycle). Simulated device change: engine restarted (1 restart), playback continued (173 more callbacks). Escape posted to the window -> cancelled, exit 1. A posted Space did not reach Melodyne's transport (Melodyne takes keyboard focus, but its transport key needs a check by hand). Quit Apple event and `[NSApp terminate:]` during a 5 s startup delay -> cancelled "quit before the window opened", exit 1, no window; `exit()` during the delay -> cancelled (exit fallback), then Melodyne's exit-time destructors abort (SIGABRT, result.json stays cancelled).
- Output menu (2026-10-23; devices: MacBook Pro Speakers, P1 4 ch 88.2 kHz, Microsoft Teams Audio 1 ch, LEN monitor HDMI 44.1 kHz, JLab headset): 16 new unit tests (205 in total, Release and ASan/UBSan). Switching while stopped (no playback): system default -> P1 -> Teams Audio -> speakers -> default -> P1, also 0.1-0.5 s apart: the output unit reads back the chosen device each time, P1 at 2 ch / 88200 Hz, Teams Audio at 1 ch / 48000 Hz, `kAudioDevicePropertyDeviceIsRunning` true on the chosen device; P1 right after Teams Audio failed once with `'nope'` before the retry was added, works with it. audio.json written to a test file only (`ARABRIDGE_AUDIO_SETTINGS`), the UID with ':' and ',' round-trips. Saved UID not connected -> `Output: System default (saved device not available)`; corrupt audio.json -> warning, system default; `ARABRIDGE_AUDIO_OUTPUT_UID=default` overrides a saved device; an unknown override UID -> "(requested device not available)". Playback (about 1 s of the vocal on the built-in speakers via `ARABRIDGE_AUDIO_OUTPUT_UID=BuiltInSpeakerDevice`): menu choice while playing at sample 22109 -> engine rebuilt, playback went on; simulated configuration change -> engine built again (1 restart); output check `40 render callbacks in 500 ms, engine running, device 118 IO running here, running somewhere; peak so far 0.5824`; stopped by Space at sample 45159. Apply in window mode unchanged (bit-identical on the generated 2 s job, exit 0). Not automated: the device list listener (needs plugging a device or changing the system default) and hearing P1.
- Not automatable here: pressing the window's close button (no accessibility permission for the test shell; the close button goes through the same `windowShouldClose:`/`windowWillClose:` as Cancel) and hearing the audio.

- [x] **Step 5: Manual check at the keyboard** (Task 12 starts with it)

```bash
python3 tools/make_test_job.py /tmp/bridge-job-1 --plugin melodyne --source /absolute/path/to/your_vocal.wav --start 0 --end 10
third_party/ARA_SDK/ARA_Examples/build/bin/Release/BridgeHost --job /tmp/bridge-job-1
```

1. The window comes to the front, fits the screen, shows Melodyne's note editor with the vocal (Melodyne may show its "What you need to know now" tips panel inside the editor first; close it).
2. **Play** plays the vocal through the default output; the button changes to **Stop**; **Stop** silences it; playback ends by itself at the clip end and the button returns to **Play**. Melodyne's playhead follows. Then use Melodyne's own transport: press Space with the mouse over the editor (click an empty spot of the editor first if nothing happens), click in Melodyne's time ruler to move the play position; the Play/Stop button follows. Plug or unplug headphones while playing: playback continues on the new device.
3. Press **Apply to Live**: a sheet "Rendering..." appears, the editor cannot be clicked meanwhile, then the window closes after about a second; `result.json` says `"status" : "ok"`.
4. Cancel during Apply (the real render takes well under a second, so use the test hang): run with `ARABRIDGE_TEST_HANG=render-soft` in front of the command, press **Apply**, then **Cancel** in the sheet -> the window closes, `result.json` says `cancelled`, no `result.wav`, no stray `.tmp` files. (Also covered by the automated checks above.)
5. Run again: close the window with its red close button -> `result.json` `cancelled`, exit code 1 (`echo $?`). Run again and press Cmd-Q -> the same. Run again and press Escape (outside a Melodyne text field) -> the same; if Escape does something in Melodyne instead, that is fine (Melodyne keeps it).
6. Repeat 1-2 with VocAlign (`--plugin vocalign`): the VocAlign Pro window (GUIDE / DUB / OUTPUT) opens and plays. (Selecting guide and dub: Task 13.)

Manual check result (the user, Melodyne 5.4.2 and VocAlign 6 Pro): Space (Play/Stop), Escape, Cmd-Q and the red close button all work as described.

If playback is silent: choose the interface your monitors are on in the window's **Output** menu (the choice is remembered in audio.json); the log line `audio output: <device> ...` names the device, `output check: ...` says whether the device asked for audio, and `playback stopped ...: N render callbacks, peak P` shows whether the plug-in produced audio.

- [x] **Step 6: Commit**

```bash
git add host/app/Playback.h host/app/Playback.mm host/app/HostApp.h host/app/HostApp.mm host/app/main.mm host/hostcore/ApplyJob.cpp host/hostcore/ApplyJob.h
git commit -m "feat: BridgeHost editor window with playback, Apply and Cancel"
```

---

## Task 12: Melodyne end to end (edit, Apply, realign)

This verifies the whole Melodyne path with a real edit, and that editing still works with the editor instance bound with all three roles (deviation 4).

**Files:**
- Create: `tools/check_edit.py`

- [x] **Step 1: Write the checker** (as built: `tools/check_edit.py`; the real file wins)

`check_edit.py JOB_DIR [--blocks]` compares `result.wav` with the source region and reports, in seconds from the region start: (a) the prefix: the first frame where a channel differs by more than 1e-5, and the largest difference before it; (b) the edited stretch: windows of 50 ms right after the first difference whose error relative to the source is above 0.5 (gaps of one window are bridged), with start and end; (c) the tail after the edited stretch (+0.25 s margin): relative RMS error, peak error and a per-second relative-error profile; (d) a verdict. With realign ON (job.json `realign`) it is PASS if the prefix is identical (the first difference lies at most 0.5 s before the edited stretch), an edit was found and the tail relative RMS is <= 0.15, else FAIL with the reason; with realign OFF it prints the same numbers and a note that a large tail error (about 1.4) is expected. It then prints what `result.json` says about the realignment (applied, each shift segment with its time range, shift and correlation) and its diagnostics. `--blocks` also lists the blocks of frames that differ at all (blocks closer than 20 ms merged); this is informative only, because Melodyne's shifted audio is itself only about 95% similar to the original (spec section 7), so the tail differs by more than 1e-5 almost everywhere (73% of the frames in the first run) even when the realignment worked. The first draft assumed an exact copy and expected ONE block; that expectation was wrong. The checker reads job.json's real fields (`clips[].role/path/startSec`; the source for melodyne, the dub for vocalign), takes the region from `result.json`'s `sourceStartFrame` and `frames` (falling back to `startSec` rounded half away from zero), parses WAV chunks properly (16/24/32-bit PCM, 32/64-bit float, WAVE_FORMAT_EXTENSIBLE, extra chunks, mono or stereo) and refuses a result that is not "ok". `check_edit.py --self-test` checks the block detection, the WAV reader, a whole synthetic job and the new metrics (no edit, edit + exact tail, edit + noisy tail, unaligned tail, stray early difference). It needs numpy (`python3 -m pip install numpy`, or a Python that has it).

- [x] **Step 2: Manual end-to-end check with realignment ON**

```bash
rm -rf /tmp/bridge-job-3
python3 tools/make_test_job.py /tmp/bridge-job-3 --plugin melodyne --source /absolute/path/to/your_vocal.wav --start 0 --end 20
third_party/ARA_SDK/ARA_Examples/build/bin/Release/BridgeHost --job /tmp/bridge-job-3
```

In the window: let Melodyne analyse, press **Play** to confirm you hear the vocal, then move **one** note up about 3 semitones (drag it straight up), and press **Apply to Live**. The window closes by itself after about a second. Then:

```bash
cat /tmp/bridge-job-3/result.json
python3 tools/check_edit.py /tmp/bridge-job-3
```

Expected:
- `result.json` has `"status" : "ok"`, `"applied" : true` and `shifts` entries with a nonzero `shift` after the edit (the value depends on the edit: 30.75, 118.66 and 100.44 samples were seen; measure it, do not assume it).
- `check_edit.py` reports (a) a prefix that stays within 1e-5 of the source up to the edit, (b) **one** edited stretch of about 0.3 to 0.6 s at the position of the note you moved, (c) a tail whose relative RMS error is <= 0.15 (about 0.1 expected), and (d) `PASS`.

- [x] **Step 3: Control run with realignment OFF**

```bash
rm -rf /tmp/bridge-job-4
python3 tools/make_test_job.py /tmp/bridge-job-4 --plugin melodyne --source /absolute/path/to/your_vocal.wav --start 0 --end 20 --no-realign
third_party/ARA_SDK/ARA_Examples/build/bin/Release/BridgeHost --job /tmp/bridge-job-4
# make the same edit, press Apply, then:
python3 tools/check_edit.py /tmp/bridge-job-4
```

Expected: same prefix and edit start, but a tail relative RMS error of about 1.4 (the shifted audio no longer lines up with the source) and no verdict (a note says a large tail error is expected with realign OFF). Compared with the realign ON run (about 0.1) this confirms that the realignment is what removes the drift.

Result (the user, same source and edit): tail relative RMS error 1.49 with realign OFF, against 0.102 with realign ON (Step 2): the realignment removes the drift.

- [x] **Step 4: Record the outcome and commit**

If the ON check fails (FAIL line, for example a tail relative RMS above 0.15), keep `result.json` and `result.wav`, run:

```bash
build/host-tests/realign_tool <source region wav> /tmp/bridge-job-3/result.wav /tmp/out.wav
```

(extract the region first if `startSec` was not 0) and compare the segments with the `shifts` in `result.json` before changing any thresholds.

```bash
git add tools/check_edit.py
git commit -m "test: end-to-end Melodyne edit check (prefix, edited stretch, tail error, verdict)"
```

**Task 12 result (realign ON run, `/tmp/bridge-job-3`).** Source `spike/out_session2/render_1.wav`, 19.9 s, one note near 3.62 to 3.93 s moved up about 3 semitones, Apply pressed, realign ON. `result.json`: status ok, realign applied with 31 segments, shifts about +100.44 samples after the note (about 0 in a few unshifted stretches). Prefix bit-identical up to 3.6 s (max difference 1.5e-8); first difference at 3.623 s; edited stretch 3.70 to 3.95 s (the edited note differs, as intended). Tail from 4.2 s: relative RMS error 0.102 against the source (peak error 0.38), per-second profile 0.004 to 0.23 (the highest values in the last two seconds). `check_edit.py` verdict: PASS. Realign OFF control run (Step 3): tail relative RMS error 1.49.

---

## Task 13: VocAlign flow (track selection and alignment measurement)

**Files:**
- Modify: `host/app/HostApp.mm`
- Create: `tools/make_dub.py`, `tools/measure_alignment.py`

The helper scripts need numpy; plain `python3` on this Mac does not have it. Use `PY=/opt/homebrew/Caskroom/miniforge/base/bin/python3` below.

- [x] **Step 1: Add the guide/dub selection buttons** (done; Task 11 had not added them)

In `host/app/HostApp.mm`, `applicationDidFinishLaunching:`, right after the Cancel button (`x += 88;`), a VocAlign job gets one **Select guide** / **Select dub** button per clip (`select.tag` = clip index, 110 pt wide, 116 pt apart), and the status text starts after them. The action `selectTrackClicked:` (before `editorHolderResized:`) calls `selectTrack (track)` (the existing helper that notifies the editor view of the track's playback regions) and sets the status "Selected the guide in the editor." / "Selected the dub in the editor." The initial `selectTrack (track)` (the track that gets rendered, the dub) still runs at start-up.

- [x] **Step 2: Rebuild**

```bash
tools/build_host.sh
```

Result: `** BUILD SUCCEEDED **`.

- [x] **Step 3: The two helper scripts** (in the repository, each with `--self-test`)

`tools/make_dub.py guide.wav dub.wav`: delays the guide by `0.04 + 0.05 * sin(2 pi t / 6 s)` seconds (between -10 and +90 ms, mean absolute about 40 ms). Reads 16/24/32-bit integer and 32/64-bit float WAV (also WAVE_FORMAT_EXTENSIBLE, extra chunks), mono or stereo; writes a 32-bit float WAV with the same rate and channels (the format the host's `result.wav` has). It also holds `read_wav`, `write_wav` and `warp`, which `measure_alignment.py` imports.

`tools/measure_alignment.py guide.wav signal.wav [signal_start_sec [guide_start_sec]]`: for every 1 s window it finds the lag (+-150 ms, sub-millisecond) that best matches the 10 ms smoothed magnitude envelope of the signal to the guide's, and prints the offset per window (positive = signal late), then the mean absolute offset, the mean signed offset and the largest one. Silent windows and windows with a correlation below 0.3 are listed but not counted. Files may differ in length (the overlap is compared) and channel count (channels are averaged); the sample rates must match. `signal_start_sec` / `guide_start_sec` are the seconds into each file where the compared region begins (default 0): the host's `result.wav` holds only the job's region, so for a job with `--start 2 --end 15` use `measure_alignment.py guide.wav result.wav 0 2`, and for the matching unaligned region `measure_alignment.py guide.wav dub.wav 2 2`.

```bash
$PY tools/make_dub.py --self-test
$PY tools/measure_alignment.py --self-test
```

Both print `... self-test OK`.

- [x] **Step 3b: Measure the unaligned baseline** (done with `spike/out_session2/render_1.wav`, 32-bit float, 44.1 kHz stereo, 20 s)

```bash
$PY tools/make_dub.py /absolute/path/to/spike/out_session2/render_1.wav /tmp/dub.wav
$PY tools/measure_alignment.py /absolute/path/to/spike/out_session2/render_1.wav /tmp/dub.wav
```

Result: mean absolute offset 44.6 ms over the 20 s (mean signed +42.2 ms, largest 88.6 ms; per second from -9.5 to +88.6 ms; correlation 0.73 to 1.00). For the first 15 s only (the region the job uses): 46.8 ms. The spike measured 44.3 ms on the same material.

- [x] **Step 3c: Headless pipeline check, no capture** (done)

```bash
python3 tools/make_test_job.py /tmp/bridge-job-vocalign --plugin vocalign --guide /absolute/path/to/spike/out_session2/render_1.wav --dub /tmp/dub.wav --start 0 --end 15
third_party/ARA_SDK/ARA_Examples/build/bin/Release/BridgeHost --job /tmp/bridge-job-vocalign --autorender
$PY tools/measure_alignment.py /absolute/path/to/spike/out_session2/render_1.wav /tmp/bridge-job-vocalign/result.wav
```

Result: `BridgeHost: ok`, `result.json` status ok with `realign.applied` false, `result.wav` 661500 frames (15 s, 44.1 kHz, 2 channels), bit-identical to the first 15 s of `/tmp/dub.wav` (maximum difference 0.0) and measured at 46.8 ms mean absolute offset, equal to the unaligned baseline of the same region (VocAlign without a capture leaves the dub unchanged). (`check_edit.py` is for Melodyne edits: it reports "identical to the source" for this job, which is expected here.) The `result.*` files were deleted afterwards so the job folder is ready for the manual check.

- [x] **Step 4: Manual check: VocAlign align and apply** (the user does this; the VocAlign UI cannot be driven from a script)

```bash
PY=/opt/homebrew/Caskroom/miniforge/base/bin/python3
cd <repo>
G=<repo>/spike/out_session2/render_1.wav

# 1. the dub and the unaligned baseline (expect a mean |offset| of about 45 ms)
$PY tools/make_dub.py $G /tmp/dub.wav
$PY tools/measure_alignment.py $G /tmp/dub.wav

# 2. the job (15 s region) and BridgeHost with the window
rm -rf /tmp/bridge-job-vocalign
python3 tools/make_test_job.py /tmp/bridge-job-vocalign --plugin vocalign --guide $G --dub /tmp/dub.wav --start 0 --end 15
third_party/ARA_SDK/ARA_Examples/build/bin/Release/BridgeHost --job /tmp/bridge-job-vocalign
```

(Use an `--end` no larger than the length of both files.) In the window:
1. Click **Select guide**, then click **Capture** under GUIDE in VocAlign.
2. Click **Select dub**, then click **Capture** under DUB.
3. Wait for VocAlign to finish aligning (its progress finishes within seconds). If the UI has an Align button, press it. (Play may help check by ear; it plays the dub track.)
4. Click **Apply to Live**.

Then measure (the result covers the region 0-15 s):

```bash
$PY tools/measure_alignment.py $G /tmp/bridge-job-vocalign/result.wav
```

Expected: mean absolute offset below 5 ms (it was 1.4 ms in the spike), versus about 47 ms for the same region unaligned. If the result is still at about 47 ms, a capture was missed: `result.json` shows `realign.applied` false either way (realign is a Melodyne feature; `realign.reason` is `not-requested`), so judge by the measurement.

Result (the user): mean absolute offset 46.8 ms unaligned -> 1.7 ms after VocAlign, largest 5.2 ms (at the clip end). PASS.

- [x] **Step 5: Commit** (the code and the scripts were committed in `29a3c35`; Step 4 passed: 46.8 ms -> 1.7 ms, max 5.2 ms)

```bash
git add host/app/HostApp.mm tools/make_dub.py tools/measure_alignment.py
git commit -m "feat: VocAlign guide/dub selection in the host window; alignment measurement tools"
```

---

## Task 14: Wrap-up and hand-off to the device plan

**Files:**
- Modify: `docs/superpowers/specs/2026-10-22-ara-bridge-design.md` (record what the host does as built)
- Create: `docs/superpowers/specs/2026-10-23-host-device-contract.md` (what the device must do to drive the host)

- [x] **Step 1: Run everything once**

```bash
tools/build_tests.sh
tools/build_host.sh
host/tests/headless_roundtrip.sh
```

Expected: `0 failure(s)` from the unit tests, `** BUILD SUCCEEDED **`, and `headless round trip OK`.

Result (2026-10-23, after the final review fixes): 189 tests, 0 failures (Release, and Debug with ASan + UBSan); `** BUILD SUCCEEDED **` with no warnings from `BridgeHost/` files; `headless round trip OK` (VocAlign bit-identical, Melodyne within 1e-7: max 3.0e-8, 6.0e-8 for the 9.87..19.99 s region); `headless failure cases OK`; scripted window Apply (`ARABRIDGE_TEST_AUTOAPPLY`) for Melodyne (within 1e-7, `realign.reason` `nothing-to-do`) and VocAlign (bit-identical, `not-requested`), exit 0; window run with clip name and path "Gesang Müller 🎤" logs the title correctly; the scratch `tools/setup_sdk.sh` (fresh clone under `/private/tmp/claude-501/`) applies the patch and its `git diff` is byte-identical to `host/patches/ara-examples-bridgehost.patch`.

- [x] **Step 2: Update the spec**

The spec already describes the crash fallback correctly (section 8: a crash, a second stop signal or a hung render writes a prepared error `result.json` when the signal handlers see it; Cancel, close, Quit and a first stop signal write `cancelled`), so section 8 is left as it is: the host does write a fallback on a crash (RunGuard, deviation 6.3). Done in the spec:
- Status line: host implemented and verified, device pending; points to the contract file.
- Section 5.3: the host ignores `createdAt`, `sampleRate`, `channels` and `live.trackIndex`, tolerates unknown keys (`null` counts as absent), and requires absolute clip paths; `result.json` lists `realign.reason`.
- Section 6: the host always writes `<job>/result.wav`; the device copies it to a unique name before creating the clip.
- Section 7, step 5: `realign.reason`.

- [x] **Step 3: Commit and record what the device plan must settle**

```bash
git add docs
git commit -m "docs: final review results, host/device contract, Task 14"
```

The next plan (M4L device, spec milestones 4–6) builds on the contract file and starts with two probes in Live 12.4.6, because its design depends on them:
1. Can `TakeLane.create_audio_clip` / `Track.create_take_lane` be used from Max for Live, and what exactly do they need?
2. Can the device launch `BridgeHost` and see its exit (Node for Max `child_process`)? Does the window get keyboard focus when launched from Live (contract, "Concurrency and focus")?

It also decides on the host additions the contract lists as planned (SIGUSR1 to bring the window to the front, `host.json`) and on the realign limitation (deviation 9.7). Write that plan after those probes, using `anthropic-skills:max4live` for the Max patch work. Milestone 7 (retail-install re-check) follows the device plan.
