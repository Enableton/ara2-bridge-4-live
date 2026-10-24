// EditHost.mm
// Spike: minimal windowed ARA host. Builds an ARA document from one audio file, shows the plug-in's
// editor view (Melodyne) in a window, and offers a "Render" button that renders the playback region
// offline to a WAV file and compares it with the previous render.
//
// Question this answers: does Melodyne's editor open in a non-DAW host, and do edits made in it
// show up in an offline render?
//
// Usage: ARAEditHost -vst3 /Library/Audio/Plug-Ins/VST3/Melodyne.vst3 -file vocal.wav [-out outDir]
// (built on the ARA SDK's TestHost code, see EditHost.cmake)

#include "TestHost.h"
#include "ARAHostInterfaces/ARAAudioAccessController.h"
#include "ExamplesCommon/AudioFiles/AudioFiles.h"
#include "ExamplesCommon/PlugInHosting/VST3Loader.h"

#include "ARA_Library/Utilities/ARASamplePositionConversion.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>
#include <memory>
#include <string>
#include <thread>
#include <vector>

// Cocoa defines macros (e.g. NOFILE) that clash with the SDK's audio file header, so it must come last
#import <Cocoa/Cocoa.h>

ARA::ARAAssertFunction assertFunction { &ARA::ARAInterfaceAssert };
ARA::ARAAssertFunction* assertFunctionReference { &assertFunction };

ARA_SETUP_DEBUG_MESSAGE_PREFIX ("ARAEditHost");

namespace
{
    constexpr CGFloat kBarHeight { 44.0 };
    constexpr int kRenderBlockSize { 2048 };

    struct Render
    {
        std::vector<std::vector<float>> channels;
        double sampleRate { 44100.0 };
    };

    struct State
    {
        std::unique_ptr<PlugInEntry> entry;
        std::unique_ptr<TestHost> testHost;
        std::vector<std::shared_ptr<AudioFileBase>> files;
        ARADocumentController* docController {};
        std::unique_ptr<PlugInInstance> editorInstance;

        std::string outDir;
        bool fullRoles { false };    // -fullroles: bind the editor instance like a DAW track insert (editor view + editor renderer + playback renderer)
        bool autoRender { false };   // -autorender: click Render once shortly after launch (for automated checks)
        size_t renderTrack { 0 };   // index of the region sequence that gets rendered (the 'dub' for VocAlign)
        int renderCount { 0 };
        bool rendering { false };
        std::unique_ptr<PlugInInstance> renderInstance;
        std::shared_ptr<Render> currentRender;
        std::shared_ptr<Render> previousRender;
    };
    State S;

    bool writeWav (const std::string& path, const Render& render)
    {
        FILE* f { std::fopen (path.c_str (), "wb") };
        if (!f)
            return false;
        const uint32_t channels { static_cast<uint32_t> (render.channels.size ()) };
        const uint32_t frames { render.channels.empty () ? 0U : static_cast<uint32_t> (render.channels[0].size ()) };
        const uint32_t sampleRate { static_cast<uint32_t> (render.sampleRate) };
        const uint32_t dataBytes { frames * channels * 4U };
        auto u32 = [&] (uint32_t v) { std::fwrite (&v, 4, 1, f); };
        auto u16 = [&] (uint16_t v) { std::fwrite (&v, 2, 1, f); };
        std::fwrite ("RIFF", 1, 4, f); u32 (36U + dataBytes); std::fwrite ("WAVE", 1, 4, f);
        std::fwrite ("fmt ", 1, 4, f); u32 (16U); u16 (3U /* IEEE float */); u16 (static_cast<uint16_t> (channels));
        u32 (sampleRate); u32 (sampleRate * channels * 4U); u16 (static_cast<uint16_t> (channels * 4U)); u16 (32U);
        std::fwrite ("data", 1, 4, f); u32 (dataBytes);
        std::vector<float> block (channels);
        for (uint32_t i { 0 }; i < frames; ++i)
        {
            for (uint32_t c { 0 }; c < channels; ++c)
                block[c] = render.channels[c][i];
            std::fwrite (block.data (), 4, channels, f);
        }
        std::fclose (f);
        return true;
    }

    double rms (const Render& r)
    {
        double sum { 0.0 };
        size_t n { 0 };
        for (const auto& ch : r.channels)
            for (float v : ch) { sum += static_cast<double> (v) * v; ++n; }
        return n ? std::sqrt (sum / static_cast<double> (n)) : 0.0;
    }

    // creates the ARA document: one musical context, one region sequence, and per file an audio
    // source + modification + playback region covering the whole file
    void buildDocument ()
    {
        S.testHost = std::make_unique<TestHost> ();
        auto document { S.testHost->addDocument ("ARAEditHost", S.entry.get ()) };
        S.docController = S.testHost->getDocumentController (document);

        S.docController->beginEditing ();
        auto musicalContext { S.testHost->addMusicalContext (document, "Musical Context", { 1.0f, 0.0f, 0.0f }) };
        for (size_t i { 0 }; i < S.files.size (); ++i)
        {
            // one track per file, all regions start at time 0 so a guide and a dub overlap (as VocAlign expects)
            auto regionSequence { S.testHost->addRegionSequence (document, "Track " + std::to_string (i + 1), musicalContext, { 0.0f, 1.0f, 0.0f }) };
            const double position { 0.0 };
            auto audioSource { S.testHost->addAudioSource (document, S.files[i].get (), "audioSource " + std::to_string (i)) };
            auto audioModification { S.testHost->addAudioModification (document, audioSource, "Modification " + std::to_string (i), "audioModification " + std::to_string (i)) };
            const auto duration { audioSource->getDuration () };
            S.testHost->addPlaybackRegion (document, audioModification, ARA::kARAPlaybackTransformationNoChanges,
                                           0.0, duration, position, duration, regionSequence, "Region", { 0.0f, 0.0f, 1.0f });
        }
        S.docController->endEditing ();

        const auto factory { S.entry->getARAFactory () };
        for (auto& audioSource : document->getAudioSources ())
        {
            S.docController->enableAudioSourceSamplesAccess (audioSource.get (), true);
            if (factory->analyzeableContentTypesCount > 0)
                S.docController->requestAudioSourceContentAnalysis (audioSource.get (), factory->analyzeableContentTypesCount, factory->analyzeableContentTypes, false);
        }
    }

    // selects the regions of one track (index) in the editor view, or of all tracks (index < 0)
    void selectTrackInEditor (int index)
    {
        std::vector<ARA::ARAPlaybackRegionRef> refs;
        int i { 0 };
        for (const auto& regionSequence : S.docController->getDocument ()->getRegionSequences ())
        {
            if (index < 0 || i == index)
                for (const auto& playbackRegion : regionSequence->getPlaybackRegions ())
                    refs.push_back (S.docController->getRef (playbackRegion));
            ++i;
        }
        std::printf ("[EditHost] editor selection: %s %d (%zu region(s))\n", index < 0 ? "all tracks" : "track", index + 1, refs.size ());

        using Selection = ARA::SizedStruct<ARA_STRUCT_MEMBER (ARAViewSelection, timeRange)>;
        const Selection selection { refs.size (), refs.data (), 0U, nullptr, nullptr };
        S.editorInstance->getEditorView ().notifySelection (&selection);
    }
}

/*******************************************************************************/

@interface EditHostDelegate : NSObject <NSApplicationDelegate>
@property (strong) NSWindow* window;
@property (strong) NSView* editorHolder;
@property (strong) NSTextField* status;
@property (strong) NSButton* renderButton;
@end

@implementation EditHostDelegate

- (void) setStatusText: (NSString*) text
{
    self.status.stringValue = text;
    std::printf ("[EditHost] %s\n", text.UTF8String);
    std::fflush (stdout);
}

- (void) applicationDidFinishLaunching: (NSNotification*) notification
{
    buildDocument ();

    S.editorInstance = S.entry->createPlugInInstance ();
    if (S.fullRoles)
    {
        // like a DAW track insert: this instance renders (and edits) the regions of the chosen track
        S.editorInstance->bindToDocumentControllerWithRoles (S.docController->getDocumentController ()->getRef (),
                                                             ARA::kARAPlaybackRendererRole | ARA::kARAEditorRendererRole | ARA::kARAEditorViewRole);
        auto playbackRenderer { S.editorInstance->getPlaybackRenderer () };
        auto editorRenderer { S.editorInstance->getEditorRenderer () };
        size_t trackIndex { 0 };
        for (const auto& regionSequence : S.docController->getDocument ()->getRegionSequences ())
        {
            if (trackIndex++ != S.renderTrack)
                continue;
            for (const auto& playbackRegion : regionSequence->getPlaybackRegions ())
            {
                playbackRenderer.addPlaybackRegion (S.docController->getRef (playbackRegion));
                editorRenderer.addPlaybackRegion (S.docController->getRef (playbackRegion));
            }
        }
        std::printf ("[EditHost] editor instance bound with all roles to track %zu\n", S.renderTrack + 1);
    }
    else
    {
        S.editorInstance->bindToDocumentControllerWithRoles (S.docController->getDocumentController ()->getRef (), ARA::kARAEditorViewRole);
    }

    NSRect frame { NSMakeRect (120, 120, 1100, 700) };
    self.window = [[NSWindow alloc] initWithContentRect: frame
                                              styleMask: NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
                                                backing: NSBackingStoreBuffered
                                                  defer: NO];
    self.window.title = [NSString stringWithFormat: @"ARAEditHost - %s", S.entry->getARAFactory ()->plugInName];

    self.editorHolder = [[NSView alloc] initWithFrame: NSMakeRect (0, kBarHeight, frame.size.width, frame.size.height - kBarHeight)];
    [self.window.contentView addSubview: self.editorHolder];

    self.renderButton = [NSButton buttonWithTitle: @"Render to WAV (compare with previous)" target: self action: @selector (renderClicked:)];
    self.renderButton.frame = NSMakeRect (10, 8, 280, 28);
    [self.window.contentView addSubview: self.renderButton];

    CGFloat statusX { 300 };
    for (size_t i { 0 }; i < S.files.size () && S.files.size () > 1; ++i)
    {
        NSButton* select { [NSButton buttonWithTitle: [NSString stringWithFormat: @"Select track %zu", i + 1] target: self action: @selector (selectTrackClicked:)] };
        select.tag = static_cast<NSInteger> (i);
        select.frame = NSMakeRect (statusX, 8, 120, 28);
        [self.window.contentView addSubview: select];
        statusX += 126;
    }

    self.status = [NSTextField labelWithString: @""];
    self.status.frame = NSMakeRect (statusX, 12, frame.size.width - statusX - 10, 20);
    self.status.autoresizingMask = NSViewWidthSizable;
    [self.window.contentView addSubview: self.status];

    int width { 0 }, height { 0 };
    const int result { S.editorInstance->attachEditor ((__bridge void*) self.editorHolder, width, height) };
    if (result == 0)
    {
        // some plug-ins (VocAlign) report no preferred size - then the host decides
        if (width <= 0 || height <= 0)
        {
            width = 1100;
            height = 640;
        }
        // Melodyne remembers and grows its editor size between launches - never let the window exceed the screen
        const NSRect visible { NSScreen.mainScreen.visibleFrame };
        const int fitWidth { static_cast<int> (std::min<CGFloat> (width, visible.size.width * 0.92)) };
        const int fitHeight { static_cast<int> (std::min<CGFloat> (height, visible.size.height * 0.85 - kBarHeight)) };
        [self.window setContentSize: NSMakeSize (fitWidth, fitHeight + kBarHeight)];
        [self.window setFrameOrigin: NSMakePoint (visible.origin.x + 20, visible.origin.y + visible.size.height - self.window.frame.size.height - 20)];
        self.editorHolder.frame = NSMakeRect (0, kBarHeight, fitWidth, fitHeight);
        self.editorHolder.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        self.editorHolder.postsFrameChangedNotifications = YES;
        [[NSNotificationCenter defaultCenter] addObserver: self selector: @selector (editorHolderResized:)
                                                     name: NSViewFrameDidChangeNotification object: self.editorHolder];
        S.editorInstance->resizeEditor (fitWidth, fitHeight);
        std::printf ("[EditHost] editor wants %dx%d, window fitted to %dx%d\n", width, height, fitWidth, fitHeight);
    }
    selectTrackInEditor (-1);

    [self.window makeKeyAndOrderFront: nil];
    [NSApp activateIgnoringOtherApps: YES];
    if (S.autoRender)
        [self performSelector: @selector (renderClicked:) withObject: nil afterDelay: 3.0];
    [self setStatusText: [NSString stringWithFormat: @"Editor attach result: %d (0 = ok), editor size %dx%d. Edit a note, then click Render.", result, width, height]];
}

- (void) selectTrackClicked: (NSButton*) sender
{
    selectTrackInEditor (static_cast<int> (sender.tag));
    [self setStatusText: [NSString stringWithFormat: @"Selected track %ld in the editor.", static_cast<long> (sender.tag) + 1]];
}

- (void) editorHolderResized: (NSNotification*) notification
{
    const NSSize size { self.editorHolder.frame.size };
    S.editorInstance->resizeEditor (static_cast<int> (size.width), static_cast<int> (size.height));
}

- (void) renderClicked: (id) sender
{
    if (S.rendering)
        return;
    S.rendering = true;
    self.renderButton.enabled = NO;
    [self setStatusText: @"Rendering..."];

    const auto document { S.docController->getDocument () };
    VST3SetOfflineRendering (1);
    S.renderInstance = S.entry->createPlugInInstance ();
    S.renderInstance->bindToDocumentControllerWithRoles (S.docController->getDocumentController ()->getRef (), ARA::kARAPlaybackRendererRole);
    auto playbackRenderer { S.renderInstance->getPlaybackRenderer () };

    const double sampleRate { document->getAudioSources ().empty () ? 44100.0 : document->getAudioSources ().front ()->getSampleRate () };
    double start { std::numeric_limits<double>::max () };
    double end { std::numeric_limits<double>::lowest () };
    size_t trackIndex { 0 };
    for (const auto& regionSequence : document->getRegionSequences ())
    {
        if (trackIndex++ != S.renderTrack)
            continue;
        for (const auto& playbackRegion : regionSequence->getPlaybackRegions ())
        {
            playbackRenderer.addPlaybackRegion (S.docController->getRef (playbackRegion));
            double headTime { 0.0 }, tailTime { 0.0 };
            S.docController->getPlaybackRegionHeadAndTailTime (playbackRegion, &headTime, &tailTime);
            std::printf ("[EditHost] region: start %.6f dur %.6f s, head %.6f tail %.6f s\n", playbackRegion->getStartInPlaybackTime (), playbackRegion->getDurationInPlaybackTime (), headTime, tailTime);
            start = std::min (start, playbackRegion->getStartInPlaybackTime () - headTime);
            end = std::max (end, playbackRegion->getEndInPlaybackTime () + tailTime);
        }
    }

    const size_t channelCount { static_cast<size_t> (S.files[S.renderTrack]->getChannelCount ()) };
    std::printf ("[EditHost] render span %.6f .. %.6f s\n", start, end);
    const auto startSample { ARA::samplePositionAtTime (start, sampleRate) };
    const auto endSample { ARA::samplePositionAtTime (end, sampleRate) };
    auto render { std::make_shared<Render> () };
    render->sampleRate = sampleRate;
    render->channels.assign (channelCount, std::vector<float> (static_cast<size_t> (endSample - startSample)));
    S.currentRender = render;

    S.renderInstance->startRendering (static_cast<int> (channelCount), kRenderBlockSize, sampleRate);
    std::printf ("[EditHost] plug-in reports latency: %d samples\n", S.renderInstance->getLatencySamples ());

    // the rendering loop runs on its own thread (as ARA plug-ins expect), the main thread keeps serving the UI
    PlugInInstance* instance { S.renderInstance.get () };
    EditHostDelegate* delegate { self };
    std::thread ([=] () {
        // not registered as a 'render thread': this is an offline render, and plug-ins (VocAlign) read audio samples while processing
        std::vector<float*> buffers (channelCount);
        for (auto position { startSample }; position < endSample; position += kRenderBlockSize)
        {
            const int count { std::min (kRenderBlockSize, static_cast<int> (endSample - position)) };
            for (size_t c { 0 }; c < channelCount; ++c)
                buffers[c] = render->channels[c].data () + (position - startSample);
            instance->renderSamples (count, position, buffers.data ());
        }
        dispatch_async (dispatch_get_main_queue (), ^{ [delegate renderFinished]; });
    }).detach ();
}

- (void) renderFinished
{
    S.renderInstance->stopRendering ();
    S.renderInstance.reset ();
    VST3SetOfflineRendering (0);

    ++S.renderCount;
    const std::string path { S.outDir + "/render_" + std::to_string (S.renderCount) + ".wav" };
    const bool wrote { writeWav (path, *S.currentRender) };

    NSString* text { [NSString stringWithFormat: @"Render %d written to %s (%s), RMS %.5f.", S.renderCount, path.c_str (), wrote ? "ok" : "WRITE FAILED", rms (*S.currentRender)] };
    if (S.previousRender)
    {
        const auto& a { S.previousRender->channels };
        const auto& b { S.currentRender->channels };
        const size_t n { std::min (a[0].size (), b[0].size ()) };
        double sumSq { 0.0 }, maxAbs { 0.0 };
        for (size_t c { 0 }; c < std::min (a.size (), b.size ()); ++c)
        {
            for (size_t i { 0 }; i < n; ++i)
            {
                const double d { static_cast<double> (a[c][i]) - static_cast<double> (b[c][i]) };
                sumSq += d * d;
                maxAbs = std::max (maxAbs, std::fabs (d));
            }
        }
        const double diffRMS { std::sqrt (sumSq / static_cast<double> (n * std::min (a.size (), b.size ()))) };
        const double reference { std::max (rms (*S.previousRender), 1e-12) };
        text = [text stringByAppendingFormat: @" Vs render %d: diff RMS %.6f (%.2f%% of signal), max %.5f -> %@",
                S.renderCount - 1, diffRMS, 100.0 * diffRMS / reference, maxAbs, (diffRMS / reference > 0.001) ? @"AUDIO CHANGED" : @"identical"];
    }
    S.previousRender = S.currentRender;
    S.rendering = false;
    self.renderButton.enabled = YES;
    [self setStatusText: text];
}

- (BOOL) applicationShouldTerminateAfterLastWindowClosed: (NSApplication*) sender
{
    return YES;
}

- (void) applicationWillTerminate: (NSNotification*) notification
{
    S.editorInstance.reset ();
    S.testHost.reset ();
    S.entry->uninitializeARA ();
    S.entry.reset ();
}

@end

/*******************************************************************************/

int main (int argc, const char* argv[])
{
    @autoreleasepool
    {
        const std::vector<std::string> args (argv, argv + argc);
        ARA::ARASetExternalAssertReference (assertFunctionReference);

        S.entry = PlugInEntry::parsePlugInEntry (args);
        if (!S.entry || !S.entry->getARAFactory ())
        {
            std::printf ("usage: ARAEditHost -vst3 <plug-in.vst3> -file <audio.wav> [-out <dir>]\n(plug-in missing or without ARA support)\n");
            return 1;
        }

        S.outDir = ".";
        for (size_t i { 0 }; i + 1 < args.size (); ++i)
        {
            if (args[i] == "-file")
            {
                icstdsp::AudioFile audioFile;
                if (audioFile.Load (args[i + 1].c_str ()) != 0)
                {
                    std::printf ("could not load audio file %s\n", args[i + 1].c_str ());
                    return 1;
                }
                S.files.emplace_back (std::make_shared<AudioDataFile> (args[i + 1], std::move (audioFile)));
            }
            else if (args[i] == "-out")
            {
                S.outDir = args[i + 1];
            }
            else if (args[i] == "-fullroles")
            {
                S.fullRoles = true;
            }
            else if (args[i] == "-autorender")
            {
                S.autoRender = true;
            }
            else if (args[i] == "-render")
            {
                S.renderTrack = static_cast<size_t> (std::atoi (args[i + 1].c_str ()));   // 0-based track index to render
            }
        }
        if (S.files.size () > 1 && S.renderTrack == 0)
            S.renderTrack = S.files.size () - 1;   // default: render the last file (the 'dub')
        if (S.files.empty ())
        {
            std::printf ("no -file given\n");
            return 1;
        }

        S.entry->initializeARA (assertFunctionReference);

        NSApplication* app { [NSApplication sharedApplication] };
        [app setActivationPolicy: NSApplicationActivationPolicyRegular];
        NSMenu* menuBar { [[NSMenu alloc] init] };
        NSMenuItem* appItem { [[NSMenuItem alloc] init] };
        [menuBar addItem: appItem];
        NSMenu* appMenu { [[NSMenu alloc] init] };
        [appMenu addItemWithTitle: @"Quit ARAEditHost" action: @selector (terminate:) keyEquivalent: @"q"];
        appItem.submenu = appMenu;
        app.mainMenu = menuBar;

        EditHostDelegate* delegate { [[EditHostDelegate alloc] init] };
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
