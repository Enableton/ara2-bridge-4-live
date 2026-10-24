// SDK headers first: Cocoa defines macros that clash with the SDK's audio file header (see MemoryAudioFile.h).
#include "app/HostApp.h"

#include "app/JobRender.h"
#include "app/Playback.h"
#include "audio/OutputDevices.h"
#include "common/NSText.h"
#include "hostcore/ApplyJob.h"
#include "hostcore/AudioOutput.h"
#include "hostcore/Options.h"
#include "hostcore/RunGuard.h"
#include "hostcore/TransportKey.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <unistd.h>
#include <vector>

#import <Cocoa/Cocoa.h>

// The window: the plug-in's editor above a bar with Play, Apply to Live, Cancel, a status line and the
// Output menu (the device the host plays to: an ARA plug-in has no audio device settings of its own, and a
// host launched from Live inherits the system default output, which may not be Live's interface).
//
// Threads and run loops: everything here runs on the main thread, which is also the thread the ARA
// document was created on. Apply is started from a run loop timer (never from a main-queue block: a
// nested run loop inside one would not drain other main-queue blocks the plug-in may post) and renders
// through renderJobClip, whose worker thread calls the plug-in's process function while this thread keeps
// pumping events. During Apply a sheet with a Cancel button blocks the editor, so nothing is edited while
// rendering. The app is left with [NSApp stop:] (not terminate:, which calls exit()), so runHostApp returns
// and tears down in order: playback, editor instance, then (in main.mm) document and ARA.

namespace
{
    constexpr CGFloat kBarHeight { 44.0 };
    constexpr double kPollSeconds { 0.1 };
    constexpr double kCloseAfterApplySeconds { 1.2 };
    constexpr double kOutputCheckSeconds { 0.5 };   // after Play: did the output device call for audio?
    constexpr CGFloat kOutputMenuWidth { 230.0 };

    enum class Phase { editing, applying, done };

    struct State
    {
        AppContext* context { nullptr };
        std::unique_ptr<PlugInInstance> editor;
        std::unique_ptr<Playback> playback;
        bool rendering { false };       // editor instance between startRendering and stopRendering
        Phase phase { Phase::editing };
        bool cancelRequested { false }; // Cancel, window close or Quit during Apply
        bool resultWritten { false };   // result.json is there (or could not be written): nothing more to write
        bool stopping { false };        // [NSApp stop:] was sent
        bool wasPlaying { false };
        // The Space key and the plug-in's transport requests must never both toggle for one key press
        // (hostcore/TransportKey.h): when each last happened
        std::optional<std::chrono::steady_clock::time_point> lastPlugInRequest;
        std::optional<std::chrono::steady_clock::time_point> lastHostToggle;
        int exitCode { bridge::kExitCancelled };

        // the Output menu (hostcore/AudioOutput.h): the devices as last listed, the system default then, and
        // what is selected; audio.json is written on a choice in the menu only
        std::vector<bridge::OutputDevice> devices;
        uint32_t defaultDevice { 0 };
        bridge::OutputChoice output;
        std::string audioSettingsPath;
        bool saveOutputChoice { true };     // false: a test choice without ARABRIDGE_AUDIO_SETTINGS (never the user's file)
        std::unique_ptr<bridge::AudioDeviceListener> deviceListener;
        std::string idleText;               // the editing phase's status text, shown with the output
        int playGeneration { 0 };           // which Play the pending output check belongs to
        int64_t callbacksAtPlay { 0 };
    };
    State S;

    bool gEarlyQuit { false };          // a quit Apple event arrived before the window opened

    void say (const std::string& text)
    {
        std::printf ("BridgeHost: %s\n", text.c_str ());
        std::fflush (stdout);
    }

    double environmentSeconds (const char* name)
    {
        const char* value { std::getenv (name) };
        if (value == nullptr || *value == '\0')
            return -1.0;
        char* end { nullptr };
        const double seconds { std::strtod (value, &end) };
        return (end != value && *end == '\0' && seconds >= 0.0 && seconds < 3600.0) ? seconds : -1.0;
    }

    double msSince (const std::optional<std::chrono::steady_clock::time_point>& when, double never)
    {
        if (! when)
            return never;
        return std::chrono::duration<double, std::milli> (std::chrono::steady_clock::now () - *when).count ();
    }

    // text into and out of NSString as UTF-8 (never "%s", see common/NSText.h)
    using bridge::ns;
    using bridge::utf8;

    std::string signalName (int signal)
    {
        return signal == SIGTERM ? "SIGTERM" : signal == SIGINT ? "SIGINT" : signal == SIGHUP ? "SIGHUP" : "a signal";
    }

    // Writes result.json with status "cancelled" (exclusively: never over a result written meanwhile)
    // unless a result was written already. Safe to call more than once.
    void writeCancelled (const std::string& message, int exitCode)
    {
        if (S.resultWritten)
            return;
        S.resultWritten = true;
        S.exitCode = exitCode;
        bridge::ResultInfo info;
        info.status = "cancelled";
        info.message = message;
        std::string error;
        if (bridge::writeResult (S.context->job.dir, S.context->job.id, info, error, true))
        {
            bridge::markResultWritten ();
            say ("cancelled - " + message);
        }
        else
        {
            std::fprintf (stderr, "BridgeHost: result.json not written: %s\n", error.c_str ());
        }
    }

    // tells the editor view which track's regions are selected (a DAW does this when you click a clip)
    void selectTrack (size_t track)
    {
        std::vector<ARA::ARAPlaybackRegionRef> refs;
        for (auto* region : S.context->document->regions (track))
            refs.push_back (S.context->document->controller ()->getRef (region));
        using Selection = ARA::SizedStruct<ARA_STRUCT_MEMBER (ARAViewSelection, timeRange)>;
        const Selection selection { refs.size (), refs.data (), 0U, nullptr, nullptr };
        S.editor->getEditorView ().notifySelection (&selection);
    }

    // The idle function of Apply: pumps one event (or waits up to 10 ms; this also runs timers, run loop
    // sources and main-queue blocks), and returns false from the first stop request on (Cancel, window
    // close, Quit, a stop signal, or the time budget). A render that does not end within the grace time
    // after that is given up: result.json is written and the process exits.
    class ApplyIdle
    {
    public:
        ApplyIdle (double timeoutSec, double graceSec)
        : _timeoutSec { timeoutSec }, _graceSec { graceSec }, _started { std::chrono::steady_clock::now () } {}

        bool operator() ()
        {
            @autoreleasepool
            {
                NSEvent* event { [NSApp nextEventMatchingMask: NSEventMaskAny untilDate: [NSDate dateWithTimeIntervalSinceNow: 0.01]
                                                         inMode: NSDefaultRunLoopMode dequeue: YES] };
                if (event != nil)
                    [NSApp sendEvent: event];
            }
            S.context->document->notifyModelUpdates ();
            const double elapsed { std::chrono::duration<double> (std::chrono::steady_clock::now () - _started).count () };
            if (! _stopping && (S.cancelRequested || bridge::stopRequested () || elapsed > _timeoutSec))
            {
                _stopping = true;
                _timedOut = ! S.cancelRequested && ! bridge::stopRequested ();
                _stoppedAt = elapsed;
            }
            if (_stopping && elapsed > _stoppedAt + _graceSec)
                giveUp ();
            return ! _stopping;
        }

        bool timedOut () const { return _timedOut; }
        double timeoutSec () const { return _timeoutSec; }

    private:
        [[noreturn]] void giveUp () const
        {
            std::fprintf (stderr, "BridgeHost: error: the plug-in did not stop rendering in time; giving up\n");
            if (_timedOut)
            {
                bridge::writeFallbackResult (0);
                _exit (bridge::kExitStopped);
            }
            if (bridge::stopRequested ())
            {
                writeCancelled ("stopped by " + signalName (bridge::stopSignal ()) + " while rendering", bridge::kExitStopped);
                _exit (bridge::kExitStopped);
            }
            writeCancelled ("cancelled while rendering", bridge::kExitCancelled);
            _exit (bridge::kExitCancelled);
        }

        const double _timeoutSec;
        const double _graceSec;
        const std::chrono::steady_clock::time_point _started;
        bool _stopping { false };
        bool _timedOut { false };
        double _stoppedAt { 0.0 };
    };
}

// Until the window opens (e.g. while a licence dialog is up): a quit Apple event only marks the job to be
// closed; runHostApp then writes "cancelled" without opening the window.
@interface EarlyQuitHandler : NSObject <NSApplicationDelegate>
@end

@implementation EarlyQuitHandler
- (void) handleQuitEvent: (NSAppleEventDescriptor*) event withReplyEvent: (NSAppleEventDescriptor*) reply
{
    say ("quit requested before the window opened");
    gEarlyQuit = true;
}

// terminate: (which would call exit()) asks the delegate first
- (NSApplicationTerminateReply) applicationShouldTerminate: (NSApplication*) sender
{
    say ("quit requested before the window opened");
    gEarlyQuit = true;
    return NSTerminateCancel;
}
@end

@class BridgeDelegate;

namespace
{
    // The plug-in's transport requests (ARA playback controller: Space or the transport in Melodyne's
    // editor, clicks in its time ruler) drive the window's playback, within the render track's region.
    // The ARA API allows these calls from any thread except render threads: a call on another thread is
    // posted to the main queue (the main thread pumps it while editing and during Apply), so all the work
    // happens on the main thread. The object lives for the rest of the process (a worker thread may still
    // hold its pointer after teardown); detach() makes it drop requests, also those already posted.
    class TransportRequests : public PlaybackRequestHandler
    {
    public:
        explicit TransportRequests (BridgeDelegate* delegate) : _delegate { delegate } {}
        void requestStartPlayback () override;
        void requestStopPlayback () override;
        void requestSetPlaybackPosition (double timePosition) override;
        void requestSetCycleRange (double startTime, double duration) override;
        void requestEnableCycle (bool enable) override;

        // main thread only
        void detach () { *_alive = false; }

    private:
        using Clock = std::chrono::steady_clock;
        // runs 'work' on the main thread (at once when called there) unless detached; 'when' is the call time
        void onMainThread (void (^work) (BridgeDelegate* delegate, Clock::time_point when));

        __weak BridgeDelegate* _delegate;
        const std::shared_ptr<bool> _alive { std::make_shared<bool> (true) };   // read and written on the main thread only
    };
    TransportRequests* gTransport { nullptr };      // never freed, see above

    int64_t samplesAt (double seconds)
    {
        const double rate { static_cast<double> (S.context->document->sampleRate (S.context->layout.renderClip)) };
        return static_cast<int64_t> (std::llround (seconds * rate));
    }

    // test only: besides key presses, ARABRIDGE_TEST_KEYS can carry the plug-in's start/stop requests
    constexpr unsigned short kTestRequestStart { 1001 };
    constexpr unsigned short kTestRequestStop { 1002 };
    // ... and the same requests sent from a background thread through the SDK's playback controller (the
    // interface the plug-in calls)
    constexpr unsigned short kTestBackgroundStart { 1003 };
    constexpr unsigned short kTestBackgroundStop { 1004 };

    // test only: "seconds:key,seconds:key" with key space, escape, request-start, request-stop, bg-start or
    // bg-stop: key presses posted to the window, or the plug-in's playback requests (to test both together;
    // bg-*: from a background thread through the SDK's playback controller)
    std::vector<std::pair<double, unsigned short>> testKeys ()
    {
        std::vector<std::pair<double, unsigned short>> keys;
        const char* value { std::getenv ("ARABRIDGE_TEST_KEYS") };
        std::string text { value ? value : "" };
        size_t at { 0 };
        while (at < text.size ())
        {
            const size_t comma { std::min (text.find (',', at), text.size ()) };
            const std::string item { text.substr (at, comma - at) };
            const size_t colon { item.find (':') };
            if (colon != std::string::npos)
            {
                const double seconds { std::atof (item.substr (0, colon).c_str ()) };
                const std::string key { item.substr (colon + 1) };
                if (key == "space")
                    keys.emplace_back (seconds, 49);
                else if (key == "escape")
                    keys.emplace_back (seconds, 53);
                else if (key == "request-start")
                    keys.emplace_back (seconds, kTestRequestStart);
                else if (key == "request-stop")
                    keys.emplace_back (seconds, kTestRequestStop);
                else if (key == "bg-start")
                    keys.emplace_back (seconds, kTestBackgroundStart);
                else if (key == "bg-stop")
                    keys.emplace_back (seconds, kTestBackgroundStop);
            }
            at = comma + 1;
        }
        return keys;
    }

    // the device UID an Output menu item stands for (empty: the system default)
    std::string menuItemUid (NSMenuItem* item)
    {
        NSObject* value { item.representedObject };
        return [value isKindOfClass: [NSString class]] ? utf8 (static_cast<NSString*> (value)) : std::string {};
    }

    // test only: ARABRIDGE_TEST_SELECT_OUTPUT "seconds:UID;seconds:default": choices in the Output menu (saved
    // only with ARABRIDGE_AUDIO_SETTINGS set, so a test never writes the user's audio.json). Items are split at
    // ';' (UIDs hold ':' and ',', e.g. "AppleUSBAudioEngine:Maker Co., Ltd.:...:1,2"), the time ends at the first ':'.
    std::vector<std::pair<double, std::string>> testOutputChoices ()
    {
        std::vector<std::pair<double, std::string>> choices;
        const char* value { std::getenv ("ARABRIDGE_TEST_SELECT_OUTPUT") };
        const std::string text { value ? value : "" };
        size_t at { 0 };
        while (at < text.size ())
        {
            const size_t comma { std::min (text.find (';', at), text.size ()) };
            const std::string item { text.substr (at, comma - at) };
            const size_t colon { item.find (':') };
            if (colon != std::string::npos && colon + 1 < item.size ())
                choices.emplace_back (std::atof (item.substr (0, colon).c_str ()), item.substr (colon + 1));
            at = comma + 1;
        }
        return choices;
    }
}

// The main window. A key press that nothing in the responder chain used (the plug-in's editor view passes
// the keys it does not need up to the window) ends in keyDown:, where the delegate may use it (Space).
@protocol BridgeWindowDelegate <NSWindowDelegate>
- (void) cancelOperation: (id) sender;
@end

@interface BridgeWindow : NSWindow
@property (nonatomic, copy) BOOL (^unusedKeyHandler) (NSEvent*);
@end

@implementation BridgeWindow
@synthesize unusedKeyHandler = _unusedKeyHandler;

- (void) keyDown: (NSEvent*) event
{
    if (self.unusedKeyHandler != nil && self.unusedKeyHandler (event))
        return;
    [super keyDown: event];     // Escape (-> cancelOperation:), everything else as before
}

// Escape that nothing before the window used: NSWindow's own cancelOperation: answers it (it does nothing
// for this window) before the delegate is asked, so hand it to the delegate (Cancel) here.
- (void) cancelOperation: (id) sender
{
    id<BridgeWindowDelegate> delegate { static_cast<id<BridgeWindowDelegate>> (self.delegate) };
    if ([delegate respondsToSelector: @selector (cancelOperation:)])
        [delegate cancelOperation: sender];
    else
        [super cancelOperation: sender];
}
@end

@interface BridgeDelegate : NSObject <NSApplicationDelegate, BridgeWindowDelegate>
- (void) startPlayback;
- (void) stopPlayback;
- (BOOL) handleUnusedKey: (NSEvent*) event;
@property (nonatomic, strong) NSWindow* window;
@property (nonatomic, strong) NSView* editorHolder;
@property (nonatomic, strong) NSButton* playButton;
@property (nonatomic, strong) NSButton* applyButton;
@property (nonatomic, strong) NSButton* cancelButton;
@property (nonatomic, strong) NSTextField* status;
@property (nonatomic, strong) NSPopUpButton* outputMenu;
@property (nonatomic, strong) NSWindow* sheet;
@property (nonatomic, strong) NSTextField* sheetText;
@property (nonatomic, strong) NSTimer* pollTimer;
@end

@implementation BridgeDelegate

@synthesize window = _window, editorHolder = _editorHolder, playButton = _playButton, applyButton = _applyButton,
            cancelButton = _cancelButton, status = _status, outputMenu = _outputMenu, sheet = _sheet, sheetText = _sheetText, pollTimer = _pollTimer;

- (void) setStatusText: (NSString*) text
{
    self.status.stringValue = text;
    if (self.sheetText != nil)
        self.sheetText.stringValue = text;
    say ("status: " + utf8 (text));
}

- (void) schedule: (SEL) selector after: (double) seconds
{
    [self performSelector: selector withObject: nil afterDelay: seconds inModes: @[ NSRunLoopCommonModes ]];
}

- (void) applicationDidFinishLaunching: (NSNotification*) notification
{
    AppContext& context { *S.context };
    BridgeDocument& document { *context.document };
    const size_t track { context.layout.renderClip };
    const auto& region { context.layout.regions[track] };

    // The editor instance is bound like a DAW track insert: all three ARA roles, with the regions of the
    // track that gets edited and rendered (VocAlign crashes without this; Melodyne needs it to play).
    // It is started before any offline render, so it keeps the realtime process mode (VST3Loader fixes the
    // mode per effect when rendering starts).
    S.editor = context.entry->createPlugInInstance ();
    S.editor->bindToDocumentControllerWithRoles (document.controller ()->getDocumentController ()->getRef (),
                                                 ARA::kARAPlaybackRendererRole | ARA::kARAEditorRendererRole | ARA::kARAEditorViewRole);
    auto playbackRenderer { S.editor->getPlaybackRenderer () };
    auto editorRenderer { S.editor->getEditorRenderer () };
    for (auto* playbackRegion : document.regions (track))
    {
        playbackRenderer.addPlaybackRegion (document.controller ()->getRef (playbackRegion));
        editorRenderer.addPlaybackRegion (document.controller ()->getRef (playbackRegion));
    }

    const int channels { document.channelCount (track) };
    const int sampleRate { document.sampleRate (track) };
    S.editor->startRendering (channels, Playback::kMaxBlock, static_cast<double> (sampleRate));
    S.rendering = true;
    [self chooseInitialOutput];
    S.playback = std::make_unique<Playback> (S.editor.get (), channels, static_cast<double> (sampleRate), region.playbackStart, region.playbackStart + region.frames,
                                             S.output.deviceId);
    if (S.playback->started ())
        say ("audio output started: " + std::to_string (channels) + " ch at " + std::to_string (sampleRate) + " Hz to " + S.playback->deviceDescription ());
    else
        say ("audio output failed to start: " + S.playback->error () + " (" + S.playback->deviceDescription () + ")");
    [self logOutput];

    const NSRect visible { NSScreen.mainScreen.visibleFrame };
    NSRect frame { NSMakeRect (visible.origin.x + 20, visible.origin.y + 20, 1100, 700) };
    self.window = [[BridgeWindow alloc] initWithContentRect: frame
                                              styleMask: NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
                                                backing: NSBackingStoreBuffered
                                                  defer: NO];
    self.window.releasedWhenClosed = NO;    // ARC owns it; it must outlive the editor view (see runHostApp)
    self.window.title = [NSString stringWithFormat: @"ARA Bridge - %@ - %@", ns (context.entry->getARAFactory ()->plugInName), ns (context.job.clips[track].name)];
    say ("window title: " + utf8 (self.window.title));
    self.window.delegate = self;
    __weak BridgeDelegate* weakSelf { self };
    static_cast<BridgeWindow*> (self.window).unusedKeyHandler = ^BOOL (NSEvent* event) { return [weakSelf handleUnusedKey: event]; };

    self.editorHolder = [[NSView alloc] initWithFrame: NSMakeRect (0, kBarHeight, frame.size.width, frame.size.height - kBarHeight)];
    [self.window.contentView addSubview: self.editorHolder];

    CGFloat x { 10 };
    self.playButton = [NSButton buttonWithTitle: @"Play" target: self action: @selector (playClicked:)];
    self.playButton.frame = NSMakeRect (x, 8, 70, 28);
    self.playButton.enabled = S.playback->started ();
    [self.window.contentView addSubview: self.playButton];
    x += 78;

    self.applyButton = [NSButton buttonWithTitle: @"Apply to Live" target: self action: @selector (applyClicked:)];
    self.applyButton.frame = NSMakeRect (x, 8, 120, 28);
    self.applyButton.keyEquivalent = @"";
    [self.window.contentView addSubview: self.applyButton];
    x += 128;

    self.cancelButton = [NSButton buttonWithTitle: @"Cancel" target: self action: @selector (cancelClicked:)];
    self.cancelButton.frame = NSMakeRect (x, 8, 80, 28);
    [self.window.contentView addSubview: self.cancelButton];
    x += 88;

    // VocAlign picks its guide and dub from the editor view's selection: one button per clip
    if (context.job.plugin == "vocalign")
    {
        for (size_t i { 0 }; i < context.job.clips.size (); ++i)
        {
            NSString* title = [NSString stringWithFormat: @"Select %@", ns (context.job.clips[i].role)];
            NSButton* select = [NSButton buttonWithTitle: title target: self action: @selector (selectTrackClicked:)];
            select.tag = static_cast<NSInteger> (i);
            select.frame = NSMakeRect (x, 8, 110, 28);
            [self.window.contentView addSubview: select];
            x += 116;
        }
    }

    // the Output menu at the right end of the bar; it never takes keyboard focus (Space stays Play/Stop)
    const CGFloat menuX { frame.size.width - kOutputMenuWidth - 10 };
    NSTextField* outputLabel { [NSTextField labelWithString: @"Output:"] };
    outputLabel.frame = NSMakeRect (menuX - 56, 12, 52, 20);
    outputLabel.alignment = NSTextAlignmentRight;
    outputLabel.autoresizingMask = NSViewMinXMargin;
    [self.window.contentView addSubview: outputLabel];
    self.outputMenu = [[NSPopUpButton alloc] initWithFrame: NSMakeRect (menuX, 8, kOutputMenuWidth, 28) pullsDown: NO];
    self.outputMenu.autoresizingMask = NSViewMinXMargin;
    self.outputMenu.refusesFirstResponder = YES;
    self.outputMenu.target = self;
    self.outputMenu.action = @selector (outputChosen:);
    [self.window.contentView addSubview: self.outputMenu];
    [self rebuildOutputMenu];

    self.status = [NSTextField labelWithString: @""];
    self.status.frame = NSMakeRect (x + 8, 12, std::max<CGFloat> (40, menuX - 56 - x - 16), 20);
    self.status.autoresizingMask = NSViewWidthSizable;
    self.status.lineBreakMode = NSLineBreakByTruncatingTail;
    [self.window.contentView addSubview: self.status];

    int width { 0 }, height { 0 };
    const int attachResult { S.editor->attachEditor ((__bridge void*) self.editorHolder, width, height) };
    if (attachResult == 0)
    {
        const int wantedWidth { width }, wantedHeight { height };
        if (width <= 0 || height <= 0)      // some plug-ins (VocAlign) report no preferred size: the host decides
        {
            width = 1100;
            height = 640;
        }
        // Melodyne remembers and grows its editor size between launches: never let the window exceed the screen
        const int fitWidth { static_cast<int> (std::min<CGFloat> (width, visible.size.width * 0.92)) };
        const int fitHeight { static_cast<int> (std::min<CGFloat> (height, visible.size.height * 0.85 - kBarHeight)) };
        [self.window setContentSize: NSMakeSize (fitWidth, fitHeight + kBarHeight)];
        [self.window setFrameOrigin: NSMakePoint (visible.origin.x + 20, visible.origin.y + visible.size.height - self.window.frame.size.height - 20)];
        self.editorHolder.frame = NSMakeRect (0, kBarHeight, fitWidth, fitHeight);
        self.editorHolder.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        self.editorHolder.postsFrameChangedNotifications = YES;
        [[NSNotificationCenter defaultCenter] addObserver: self selector: @selector (editorHolderResized:)
                                                     name: NSViewFrameDidChangeNotification object: self.editorHolder];
        S.editor->resizeEditor (fitWidth, fitHeight);
        char text[200];
        std::snprintf (text, sizeof text, "editor attached: wants %dx%d, shown at %dx%d; screen area %.0fx%.0f; window %.0fx%.0f",
                       wantedWidth, wantedHeight, fitWidth, fitHeight, visible.size.width, visible.size.height,
                       self.window.frame.size.width, self.window.frame.size.height);
        say (text);
    }
    else
    {
        say ("the plug-in editor could not be attached (code " + std::to_string (attachResult) + ")");
    }

    // the bar after the window got its final size (for the log: nothing may overlap or be cut off)
    {
        std::string bar { "bar layout (x..x+width):" };
        for (NSView* view in self.window.contentView.subviews)
        {
            if (view == self.editorHolder)
                continue;
            NSString* title { [view isKindOfClass: [NSButton class]] ? static_cast<NSButton*> (view).title
                            : [view isKindOfClass: [NSTextField class]] ? (view == self.status ? @"status" : static_cast<NSTextField*> (view).stringValue) : @"?" };
            char item[160];
            std::snprintf (item, sizeof item, " %s %.0f..%.0f", utf8 (title).c_str (), view.frame.origin.x, view.frame.origin.x + view.frame.size.width);
            bar += item;
        }
        say (bar);
    }

    selectTrack (track);
    if (gTransport == nullptr)
        gTransport = new TransportRequests (self);
    document.controller ()->setPlaybackRequestHandler (gTransport);
    [self.window makeKeyAndOrderFront: nil];
    [self focusEditor];
    [NSApp activate];
    // activation is only a request since macOS 14 (an app started from a background process may not get
    // it): show the window in front anyway
    [self.window orderFrontRegardless];

    // replaces AppKit's handler, which goes through terminate: (see quitClicked:)
    [[NSAppleEventManager sharedAppleEventManager] setEventHandler: self andSelector: @selector (handleQuitEvent:withReplyEvent:)
                                                     forEventClass: kCoreEventClass andEventID: kAEQuitApplication];

    self.pollTimer = [NSTimer timerWithTimeInterval: kPollSeconds target: self selector: @selector (poll:) userInfo: nil repeats: YES];
    [[NSRunLoop currentRunLoop] addTimer: self.pollTimer forMode: NSRunLoopCommonModes];

    if (const double seconds { environmentSeconds ("ARABRIDGE_TEST_AUTOPLAY") }; seconds >= 0.0)
        [self schedule: @selector (playClicked:) after: seconds];
    if (const double seconds { environmentSeconds ("ARABRIDGE_TEST_AUTOAPPLY") }; seconds >= 0.0)
        [self schedule: @selector (applyClicked:) after: seconds];
    if (const double seconds { environmentSeconds ("ARABRIDGE_TEST_AUTOCANCEL") }; seconds >= 0.0)
        [self schedule: @selector (cancelClicked:) after: seconds];
    if (const double seconds { environmentSeconds ("ARABRIDGE_TEST_TRANSPORT") }; seconds >= 0.0)
        for (int step { 0 }; step < 4; ++step)
            [self performSelector: @selector (transportTestStep:) withObject: @(step) afterDelay: seconds + (step == 0 ? 0.0 : step == 1 ? 1.0 : step == 2 ? 1.5 : 3.5)
                          inModes: @[ NSRunLoopCommonModes ]];
    if (const double seconds { environmentSeconds ("ARABRIDGE_TEST_AUDIO_RESTART") }; seconds >= 0.0)
        [self schedule: @selector (simulateAudioRestart) after: seconds];
    for (const auto& [seconds, keyCode] : testKeys ())
        [self performSelector: @selector (postTestKey:) withObject: @(keyCode) afterDelay: seconds inModes: @[ NSRunLoopCommonModes ]];
    for (const auto& [seconds, uid] : testOutputChoices ())
        [self performSelector: @selector (chooseTestOutput:) withObject: ns (uid) afterDelay: seconds inModes: @[ NSRunLoopCommonModes ]];

    S.deviceListener = std::make_unique<bridge::AudioDeviceListener> ([weakSelf] { [weakSelf audioDevicesChanged]; });

    S.idleText = attachResult == 0 ? "Edit, then press Apply to Live." : "The plug-in editor could not be attached (code " + std::to_string (attachResult) + "). Apply renders the clip unedited.";
    [self showIdleStatus];
}

// ---- Output menu ----

// The output to start with: ARABRIDGE_AUDIO_OUTPUT_UID, else audio.json (ARABRIDGE_AUDIO_SETTINGS or
// Application Support), else the system default; a device that is not connected falls back to the default.
- (void) chooseInitialOutput
{
    const char* settingsOverride { std::getenv ("ARABRIDGE_AUDIO_SETTINGS") };
    S.audioSettingsPath = settingsOverride != nullptr && *settingsOverride != '\0' ? std::string { settingsOverride } : bridge::defaultAudioSettingsPath ();
    bridge::AudioSettings settings;
    std::string error;
    if (! bridge::loadAudioSettings (S.audioSettingsPath, settings, error))
        say ("warning: audio settings ignored (system default output): " + error);
    const char* environment { std::getenv ("ARABRIDGE_AUDIO_OUTPUT_UID") };
    const std::string environmentUid { environment != nullptr ? environment : "" };

    S.devices = bridge::listAudioDevices ();
    S.defaultDevice = bridge::defaultOutputDeviceId ();
    S.output = bridge::chooseOutput (S.devices, settings.outputUID, environmentUid);
    say (bridge::describeAudioDevices (S.devices, S.defaultDevice, S.output.deviceId != 0 ? S.output.deviceId : S.defaultDevice));
    say (bridge::describeOutputUids (S.devices));
    const std::string from { S.output.source == bridge::OutputSource::environment ? "ARABRIDGE_AUDIO_OUTPUT_UID" : S.audioSettingsPath };
    if (S.output.requestedMissing)
        say ("audio output: " + (settings.outputName.empty () || S.output.source == bridge::OutputSource::environment ? std::string {} : "'" + settings.outputName + "' ")
             + "(UID " + S.output.requestedUid + ", from " + from + ") is not connected: using the system default");
    else if (S.output.source != bridge::OutputSource::systemDefault)
        say ("audio output chosen by " + from + ": " + (S.output.deviceId != 0 ? "UID " + S.output.uid : std::string { "system default" }));
}

- (void) logOutput
{
    // "IO running" is CoreAudio's view of this process on that device (kAudioDevicePropertyDeviceIsRunning)
    say ("audio output: " + S.playback->deviceDescription () + (S.playback->engineRunning () ? ", running" : ", not running: " + S.playback->error ())
         + (S.playback->requestedOutputDevice () == 0 ? " (system default)" : "")
         + (bridge::deviceIsRunning (S.playback->outputDeviceId ()) ? ", device IO running" : ", device IO not running"));
}

// Status line while editing: the job's text and the output, e.g. "Edit, then press Apply to Live.   Output: P1"
- (void) showIdleStatus
{
    if (S.phase != Phase::editing || S.stopping || S.idleText.empty ())
        return;
    std::string output { bridge::outputStatusText (S.output, S.devices, S.defaultDevice) };
    if (S.playback != nullptr && ! S.playback->started ())
        output += " - not working (" + S.playback->error () + "), choose another output";
    [self setStatusText: ns (S.idleText + "   " + output)];
}

// "System default (<name>)", then every selectable output; the selected one is checked
- (void) rebuildOutputMenu
{
    NSMenu* menu { [[NSMenu alloc] initWithTitle: @"Output"] };
    NSMenuItem* systemDefault { [[NSMenuItem alloc] initWithTitle: ns (bridge::systemDefaultMenuTitle (S.devices, S.defaultDevice)) action: nil keyEquivalent: @""] };
    systemDefault.representedObject = @"";
    [menu addItem: systemDefault];
    NSMenuItem* selected { systemDefault };
    const auto outputs { bridge::selectableOutputs (S.devices) };
    if (! outputs.empty ())
        [menu addItem: [NSMenuItem separatorItem]];
    for (const bridge::OutputDevice& device : outputs)
    {
        // items are added directly: NSPopUpButton's addItemWithTitle: would merge two devices with one name
        NSMenuItem* item { [[NSMenuItem alloc] initWithTitle: ns (bridge::outputMenuTitle (device)) action: nil keyEquivalent: @""] };
        item.representedObject = ns (device.uid);
        item.toolTip = ns (std::to_string (device.outputChannels) + " ch, " + std::to_string (static_cast<long long> (std::llround (device.sampleRate))) + " Hz");
        [menu addItem: item];
        if (S.output.deviceId != 0 && device.uid == S.output.uid)
            selected = item;
    }
    self.outputMenu.menu = menu;
    [self.outputMenu selectItem: selected];
}

// A choice in the Output menu: switch (also while playing), remember it in audio.json, show it.
- (void) outputChosen: (NSPopUpButton*) sender
{
    [self selectOutputUid: menuItemUid (sender.selectedItem) save: S.saveOutputChoice];
    [self focusEditor];         // the menu took no focus, but give the editor its keys back for sure
}

- (void) selectOutputUid: (const std::string&) uid save: (bool) save
{
    if (S.playback == nullptr || S.phase != Phase::editing || S.stopping)
        return;
    bridge::OutputChoice choice;
    if (! uid.empty ())
    {
        const bridge::OutputDevice* device { bridge::findDeviceByUid (S.devices, uid) };
        if (device == nullptr)
        {
            say ("audio output: the chosen device (UID " + uid + ") is gone");
            [self rebuildOutputMenu];
            return;
        }
        choice.source = bridge::OutputSource::saved;
        choice.requestedUid = uid;
        choice.uid = uid;
        choice.deviceId = device->id;
    }
    say ("output menu: " + (uid.empty () ? std::string { "system default" } : "UID " + uid) + (S.playback->isPlaying () ? " (while playing)" : ""));
    S.output = choice;
    [self switchPlaybackTo: choice.deviceId];
    [self rebuildOutputMenu];
    [self showIdleStatus];

    if (! save)
    {
        say ("audio output choice not saved (test choice without ARABRIDGE_AUDIO_SETTINGS)");
        return;
    }
    bridge::AudioSettings settings;
    settings.outputUID = choice.uid;
    if (const bridge::OutputDevice* device { bridge::findDeviceById (S.devices, choice.deviceId) })
        settings.outputName = device->name;
    std::string error;
    if (bridge::saveAudioSettings (S.audioSettingsPath, settings, error))
        say ("audio output choice saved to " + S.audioSettingsPath);
    else
        say ("warning: the audio output choice was not saved: " + error);
}

- (void) switchPlaybackTo: (uint32_t) deviceId
{
    const bool playing { S.playback->isPlaying () };
    const int64_t at { S.playback->positionSamples () };
    S.playback->setOutputDevice (deviceId);
    [self logOutput];
    if (playing)
        say ("playback goes on at sample " + std::to_string (at) + (S.playback->started () ? "" : " (stopped: the output did not start)"));
    if (! S.playback->started ())
        S.playback->stop ();
    if (playing && S.playback->isPlaying ())
        [self scheduleOutputCheck];
}

// main queue: the device list or the system default output changed
- (void) audioDevicesChanged
{
    if (S.stopping || S.playback == nullptr)
        return;
    const uint32_t oldDefault { S.defaultDevice };
    S.devices = bridge::listAudioDevices ();
    S.defaultDevice = bridge::defaultOutputDeviceId ();
    say ("audio devices changed: " + bridge::describeAudioDevices (S.devices, S.defaultDevice, S.playback->outputDeviceId ()));

    if (S.output.deviceId != 0)
    {
        const bridge::OutputDevice* device { bridge::findDeviceByUid (S.devices, S.output.uid) };
        if (device == nullptr || ! bridge::isSelectableOutput (*device))
        {
            // the chosen device went away: stop (never go on loudly on another device), use the default
            say ("audio output: the chosen device (UID " + S.output.uid + ") went away: playback stopped, using the system default");
            S.playback->stop ();
            S.output.requestedMissing = true;
            S.output.requestedUid = S.output.uid;
            S.output.uid.clear ();
            S.output.deviceId = 0;
            [self switchPlaybackTo: 0];
        }
        else if (device->id != S.output.deviceId || S.playback->outputDeviceId () != device->id)
        {
            S.output.deviceId = device->id;     // reconnected under a new id
            [self switchPlaybackTo: device->id];
        }
    }
    else if (S.output.requestedMissing && bridge::findDeviceByUid (S.devices, S.output.requestedUid) != nullptr
             && bridge::isSelectableOutput (*bridge::findDeviceByUid (S.devices, S.output.requestedUid)))
    {
        // the saved (or requested) device is back
        const bridge::OutputDevice* device { bridge::findDeviceByUid (S.devices, S.output.requestedUid) };
        say ("audio output: the " + std::string { S.output.source == bridge::OutputSource::environment ? "requested" : "saved" } + " device is back: " + device->name);
        S.output.requestedMissing = false;
        S.output.uid = device->uid;
        S.output.deviceId = device->id;
        [self switchPlaybackTo: device->id];
    }
    else if (S.defaultDevice != 0 && (S.defaultDevice != oldDefault || S.playback->outputDeviceId () != S.defaultDevice))
    {
        // "System default" follows the system default
        say ("audio output: the system default changed, following it");
        [self switchPlaybackTo: 0];
    }
    [self rebuildOutputMenu];
    [self showIdleStatus];
}

// 500 ms after Play: no render callbacks or no running engine means the device gives no audio
- (void) scheduleOutputCheck
{
    ++S.playGeneration;
    S.callbacksAtPlay = S.playback->stats ().callbacks;
    [self performSelector: @selector (checkOutput:) withObject: @(S.playGeneration) afterDelay: kOutputCheckSeconds inModes: @[ NSRunLoopCommonModes ]];
}

- (void) checkOutput: (NSNumber*) generation
{
    if (generation.intValue != S.playGeneration || S.playback == nullptr || S.stopping)
        return;
    if (! S.playback->isPlaying ())
    {
        say ("output check skipped: playback already stopped");
        return;
    }
    const int64_t callbacks { S.playback->stats ().callbacks - S.callbacksAtPlay };
    const bool running { S.playback->engineRunning () };
    const uint32_t device { S.playback->outputDeviceId () };
    char text[300];
    std::snprintf (text, sizeof text, "output check: %lld render callbacks in %.0f ms, engine %s, device %u IO %s here, %s; peak so far %.4f",
                   static_cast<long long> (callbacks), kOutputCheckSeconds * 1000.0, running ? "running" : "not running", device,
                   bridge::deviceIsRunning (device) ? "running" : "not running", bridge::deviceIsRunningSomewhere (device) ? "running somewhere" : "not running anywhere",
                   S.playback->stats ().peak);
    say (text);
    if (bridge::outputLooksDead (callbacks, running) && S.phase == Phase::editing)
        [self setStatusText: @"No audio from the output device - choose another output"];
}

// test only: ARABRIDGE_TEST_SELECT_OUTPUT, the same path as a choice in the menu
- (void) chooseTestOutput: (NSString*) uid
{
    const std::string wanted { utf8 (uid) == bridge::kSystemDefaultOutputUid ? std::string {} : utf8 (uid) };
    say ("test: choosing output " + (wanted.empty () ? std::string { "system default" } : "UID " + wanted));
    for (NSMenuItem* item in self.outputMenu.itemArray)
        if (menuItemUid (item) == wanted)
        {
            [self.outputMenu selectItem: item];
            [self outputChosen: self.outputMenu];
            return;
        }
    say ("test: no such output in the menu");
}

// keyboard focus to the plug-in's editor (as after a click into it), so its keys (Space) work at once
- (void) focusEditor
{
    NSMutableArray<NSView*>* views { [NSMutableArray arrayWithArray: self.editorHolder.subviews] };
    while (views.count > 0)
    {
        NSView* view { views.firstObject };
        [views removeObjectAtIndex: 0];
        if (view.acceptsFirstResponder && [self.window makeFirstResponder: view])
        {
            say (std::string ("keyboard focus: ") + utf8 (NSStringFromClass ([view class])));
            return;
        }
        [views addObjectsFromArray: view.subviews];
    }
    say ("keyboard focus: the editor takes none");
}

- (void) selectTrackClicked: (NSButton*) sender
{
    const size_t track { static_cast<size_t> (sender.tag) };
    selectTrack (track);
    [self setStatusText: [NSString stringWithFormat: @"Selected the %@ in the editor.", ns (S.context->job.clips[track].role)]];
}

- (void) editorHolderResized: (NSNotification*) notification
{
    if (S.editor == nullptr)
        return;
    const NSSize size { self.editorHolder.frame.size };
    S.editor->resizeEditor (static_cast<int> (size.width), static_cast<int> (size.height));
}

// main thread, every 100 ms (also while Apply pumps events)
- (void) poll: (NSTimer*) timer
{
    // lets the plug-in send model updates (during Apply the idle function does it)
    if (S.phase != Phase::applying && ! S.stopping)
        S.context->document->notifyModelUpdates ();

    if (S.playback != nullptr)
    {
        // the button follows the playback state, whoever changed it (the button, the plug-in's transport,
        // the end of the region, a failed audio restart)
        const bool playing { S.playback->isPlaying () };
        [self showPlaying: playing];
        if (S.phase == Phase::editing)
            self.playButton.enabled = S.playback->started ();
        if (S.wasPlaying && ! playing)
        {
            const auto stats { S.playback->stats () };
            char text[200];
            std::snprintf (text, sizeof text, "playback stopped at sample %lld: %lld render callbacks, %lld frames, peak %.4f, %d audio restart(s)",
                           static_cast<long long> (S.playback->positionSamples ()), static_cast<long long> (stats.callbacks),
                           static_cast<long long> (stats.frames), stats.peak, S.playback->restarts ());
            say (text);
        }
        S.wasPlaying = playing;
        static int restartsSeen { 0 };
        if (S.playback->restarts () != restartsSeen)
        {
            restartsSeen = S.playback->restarts ();
            say ("audio engine restarted after a device change (" + std::to_string (restartsSeen) + " so far)");
            [self logOutput];
            [self showIdleStatus];
        }
    }

    // a stop signal while editing closes the job like Cancel (during Apply the idle function handles it)
    if (bridge::stopRequested () && S.phase != Phase::applying && ! S.stopping)
    {
        if (S.phase == Phase::editing)
            writeCancelled ("stopped by " + signalName (bridge::stopSignal ()) + " before Apply", bridge::kExitStopped);
        [self.window close];
    }
}

// the Play button's title follows the playback state (logged when it changes, for the scripted tests)
- (void) showPlaying: (BOOL) playing
{
    NSString* title { playing ? @"Stop" : @"Play" };
    if ([self.playButton.title isEqualToString: title])
        return;
    self.playButton.title = title;
    say (std::string ("play button: ") + utf8 (title));
}

- (void) startPlayback
{
    if (S.phase != Phase::editing || S.playback == nullptr || ! S.playback->started () || S.playback->isPlaying ())
        return;
    S.playback->play ();
    S.wasPlaying = true;
    [self showPlaying: YES];
    say ("playback started at sample " + std::to_string (S.playback->positionSamples ()));
    [self scheduleOutputCheck];
}

- (void) stopPlayback
{
    if (S.playback == nullptr || ! S.playback->isPlaying ())
        return;
    S.playback->stop ();
    [self showPlaying: NO];
}

- (void) playClicked: (id) sender
{
    if (S.playback != nullptr && S.playback->isPlaying ())
        [self stopPlayback];
    else
        [self startPlayback];
}

// Space that nothing before the window used is Play/Stop, like the button (hostcore/TransportKey.h has the
// rules). Returns YES if the key is consumed.
- (BOOL) handleUnusedKey: (NSEvent*) event
{
    constexpr unsigned short kSpaceKeyCode { 49 };
    constexpr NSEventModifierFlags kModifiers { NSEventModifierFlagShift | NSEventModifierFlagControl | NSEventModifierFlagOption | NSEventModifierFlagCommand };
    NSResponder* responder { self.window.firstResponder };
    bridge::SpaceKey key;
    key.isSpace = event.keyCode == kSpaceKeyCode;
    key.hasModifiers = (event.modifierFlags & kModifiers) != 0;
    key.isRepeat = event.isARepeat;
    key.editing = S.phase == Phase::editing && ! S.stopping;
    key.sheetShown = self.window.attachedSheet != nil;
    key.textEditing = [responder isKindOfClass: [NSText class]] || [responder isKindOfClass: [NSTextField class]]
                      || ([responder conformsToProtocol: @protocol (NSTextInputClient)] && [static_cast<id<NSTextInputClient>> (responder) hasMarkedText]);
    key.msSincePlugInRequest = msSince (S.lastPlugInRequest, 1e9);
    switch (bridge::decideSpaceKey (key))
    {
        case bridge::SpaceAction::passOn:
            return NO;
        case bridge::SpaceAction::swallow:
            say (std::string ("key: space ignored (") + (key.isRepeat ? "repeat" : ! key.editing ? "not editing" : key.sheetShown ? "sheet shown" : "the plug-in just acted") + ")");
            return YES;
        case bridge::SpaceAction::toggle:
            break;
    }
    say (std::string ("key: space -> ") + (S.playback != nullptr && S.playback->isPlaying () ? "stop" : "play") + " (not used by the editor)");
    S.lastHostToggle = std::chrono::steady_clock::now ();
    [self playClicked: nil];
    return YES;
}

// test only: the plug-in's transport requests as the SDK forwards them (start at 1 s, stop, then a cycle
// of 0.5 .. 1 s from 0.6 s for 2 s); the log shows where playback was
- (void) transportTestStep: (NSNumber*) step
{
    PlaybackRequestHandler* handler { S.context->document->controller ()->getPlaybackRequestHandler () };
    switch (step.intValue)
    {
        case 0: handler->requestSetPlaybackPosition (1.0); handler->requestStartPlayback (); break;
        case 1: handler->requestStopPlayback (); break;
        case 2: handler->requestSetCycleRange (0.5, 0.5); handler->requestEnableCycle (true); handler->requestSetPlaybackPosition (0.6); handler->requestStartPlayback (); break;
        default: handler->requestStopPlayback (); handler->requestEnableCycle (false); break;
    }
    say ("test: transport step " + std::to_string (step.intValue) + ", position " + std::to_string (S.playback->positionSamples ())
         + (S.playback->isPlaying () ? ", playing" : ", stopped"));
}

- (void) simulateAudioRestart
{
    say ("test: simulating an output device change");
    S.playback->simulateConfigurationChangeForTests ();
}

- (void) postTestKey: (NSNumber*) keyCode
{
    const unsigned short code { keyCode.unsignedShortValue };
    if (code == kTestBackgroundStart || code == kTestBackgroundStop)
    {
        ARA::Host::PlaybackControllerInterface* controller { S.context->document->controller ()->getPlaybackControllerForTests () };
        say (std::string ("test: plug-in request from a background thread: ") + (code == kTestBackgroundStart ? "start" : "stop"));
        dispatch_async (dispatch_get_global_queue (QOS_CLASS_UTILITY, 0), ^{
            if (code == kTestBackgroundStart)
                controller->requestStartPlayback ();
            else
                controller->requestStopPlayback ();
        });
        return;
    }
    if (code == kTestRequestStart || code == kTestRequestStop)
    {
        PlaybackRequestHandler* handler { S.context->document->controller ()->getPlaybackRequestHandler () };
        say (std::string ("test: plug-in request ") + (code == kTestRequestStart ? "start" : "stop"));
        if (code == kTestRequestStart)
            handler->requestStartPlayback ();
        else
            handler->requestStopPlayback ();
        return;
    }
    NSString* characters { code == 53 ? @"\033" : @" " };
    say (std::string ("test: key ") + (code == 53 ? "escape" : "space"));
    for (const NSEventType type : { NSEventTypeKeyDown, NSEventTypeKeyUp })
    {
        NSEvent* event { [NSEvent keyEventWithType: type location: NSZeroPoint modifierFlags: 0 timestamp: NSProcessInfo.processInfo.systemUptime
                                      windowNumber: self.window.windowNumber context: nil characters: characters
                       charactersIgnoringModifiers: characters isARepeat: NO keyCode: code] };
        [NSApp postEvent: event atStart: NO];
    }
}

// Escape that the editor does not use itself arrives here through the responder chain: Cancel. (Not a key
// equivalent on the button: that would take Escape away from the plug-in's editor.)
- (void) cancelOperation: (id) sender
{
    say ("escape");
    [self cancelClicked: sender];
}

- (void) setEditingControlsEnabled: (BOOL) enabled
{
    self.playButton.enabled = enabled && S.playback->started ();
    self.applyButton.enabled = enabled;
    self.outputMenu.enabled = enabled;
}

- (void) applyClicked: (id) sender
{
    if (S.phase != Phase::editing || S.stopping)
        return;
    S.phase = Phase::applying;
    S.cancelRequested = false;
    S.playback->stop ();        // the editor instance does not render while the offline render runs
    [self showPlaying: NO];
    [self setEditingControlsEnabled: NO];
    [self showSheet];
    [self setStatusText: @"Rendering..."];
    // from a run loop timer, after the sheet and the status text are drawn
    [self schedule: @selector (runApply) after: 0.0];
}

- (void) showSheet
{
    self.sheet = [[NSWindow alloc] initWithContentRect: NSMakeRect (0, 0, 420, 96) styleMask: NSWindowStyleMaskTitled backing: NSBackingStoreBuffered defer: NO];
    self.sheet.releasedWhenClosed = NO;
    self.sheetText = [NSTextField labelWithString: @""];
    self.sheetText.frame = NSMakeRect (20, 56, 380, 20);
    self.sheetText.lineBreakMode = NSLineBreakByTruncatingTail;
    [self.sheet.contentView addSubview: self.sheetText];
    NSButton* cancel { [NSButton buttonWithTitle: @"Cancel" target: self action: @selector (cancelClicked:)] };
    cancel.frame = NSMakeRect (310, 12, 90, 28);
    cancel.keyEquivalent = @"\033";      // Escape
    [self.sheet.contentView addSubview: cancel];
    [self.window beginSheet: self.sheet completionHandler: nil];
}

- (void) hideSheet
{
    if (self.sheet == nil)
        return;
    [self.window endSheet: self.sheet];
    [self.sheet orderOut: nil];
    self.sheet = nil;
    self.sheetText = nil;
}

- (void) runApply
{
    AppContext& context { *S.context };
    ApplyIdle idle { context.applyTimeoutSec, context.stopGraceSec };
    const auto log = [] (const std::string& line) { say (line); };

    bridge::ResultInfo info;
    double analysisSeconds { 0.0 };
    [self setStatusText: @"Waiting for the plug-in's analysis..."];
    if (context.document->waitForAnalysis (std::ref (idle), analysisSeconds))
    {
        char text[80];
        std::snprintf (text, sizeof text, "analysis done (waited %.2f s)", analysisSeconds);
        say (text);
        [self setStatusText: @"Rendering..."];
        // renderJobClip renders Melodyne twice and repairs its doubled samples (as in headless mode)
        const auto render = [&] (bridge::Audio& out, std::string& error, std::string& diagnostics) {
            const bool ok { renderJobClip (*context.document, context.job, context.layout, std::ref (idle), log, out, error, diagnostics) };
            if (! ok && idle.timedOut ())
                error = "timed out after " + std::to_string (static_cast<int> (idle.timeoutSec ())) + " s while rendering";
            return ok;
        };
        info = bridge::applyJob (context.job, context.original, context.layout.regions[context.layout.renderClip].sourceStart, render, false, log, context.layout.guideWindow);
    }
    else
    {
        info.status = "error";
        info.message = idle.timedOut () ? "timed out while the plug-in was analysing the audio" : "stopped while the plug-in was analysing the audio";
    }
    [self hideSheet];

    if (info.status == "ok")
    {
        bridge::markResultWritten ();
        S.resultWritten = true;
        S.exitCode = bridge::kExitOk;
        S.phase = Phase::done;
        say ("ok" + (info.message.empty () ? std::string {} : " - " + info.message));
        [self setStatusText: ns ("Applied. Sending the result back to Live." + (info.message.empty () ? std::string {} : " " + info.message))];
        [self schedule: @selector (closeWindow) after: kCloseAfterApplySeconds];
        return;
    }
    if (bridge::stopRequested ())
    {
        writeCancelled ("stopped by " + signalName (bridge::stopSignal ()) + " while rendering", bridge::kExitStopped);
        [self closeWindow];
        return;
    }
    if (S.cancelRequested)
    {
        writeCancelled ("cancelled while rendering", bridge::kExitCancelled);
        [self closeWindow];
        return;
    }
    // a failed Apply writes nothing: the user can retry or cancel
    say ("apply failed: " + info.message);
    S.phase = Phase::editing;
    [self setEditingControlsEnabled: YES];
    [self setStatusText: ns ("Apply failed: " + info.message)];
}

- (void) closeWindow
{
    [self.window close];
}

- (void) cancelClicked: (id) sender
{
    if (S.phase == Phase::applying)
    {
        S.cancelRequested = true;
        [self setStatusText: @"Cancelling..."];
        return;
    }
    [self.window performClose: nil];
}

- (BOOL) windowShouldClose: (NSWindow*) sender
{
    if (S.phase == Phase::applying)     // the render stops first; runApply then closes the window
    {
        S.cancelRequested = true;
        [self setStatusText: @"Cancelling..."];
        return NO;
    }
    return YES;
}

// closing the window without applying cancels the job; closing it always ends the app
- (void) windowWillClose: (NSNotification*) notification
{
    if (notification.object != self.window)
        return;
    writeCancelled ("closed without applying", bridge::kExitCancelled);
    [self stopApp];
}

- (void) stopApp
{
    if (S.stopping)
        return;
    S.stopping = true;
    [self.pollTimer invalidate];
    [NSApp stop: nil];
    // stop: takes effect after the current event; this one makes sure there is one
    NSEvent* wake { [NSEvent otherEventWithType: NSEventTypeApplicationDefined location: NSZeroPoint modifierFlags: 0 timestamp: 0
                                    windowNumber: 0 context: nil subtype: 0 data1: 0 data2: 0] };
    [NSApp postEvent: wake atStart: NO];
}

// Quit (the menu, Cmd-Q, the Dock, a quit Apple event) closes the job like the window's close button
// instead of calling exit(). AppKit's own quit handling (terminate:) does nothing while a sheet is shown,
// so the menu item and the quit Apple event come here directly.
- (void) quitClicked: (id) sender
{
    say ("quit requested");
    if (S.phase == Phase::applying)
    {
        S.cancelRequested = true;
        [self setStatusText: @"Cancelling..."];
    }
    else if (! S.stopping)
    {
        [self.window close];
    }
}

- (void) handleQuitEvent: (NSAppleEventDescriptor*) event withReplyEvent: (NSAppleEventDescriptor*) reply
{
    [self quitClicked: nil];
}

- (NSApplicationTerminateReply) applicationShouldTerminate: (NSApplication*) sender
{
    [self quitClicked: nil];
    return NSTerminateCancel;
}

- (void) teardownEditor
{
    [NSObject cancelPreviousPerformRequestsWithTarget: self];
    [self.pollTimer invalidate];
    [[NSNotificationCenter defaultCenter] removeObserver: self];
    S.context->document->controller ()->setPlaybackRequestHandler (nullptr);
    if (gTransport != nullptr)
        gTransport->detach ();      // kept: a worker thread may still call it
    S.deviceListener.reset ();      // no more device switches
    if (S.playback != nullptr)
    {
        const auto stats { S.playback->stats () };
        say ("playback in total: " + std::to_string (stats.callbacks) + " render callbacks, " + std::to_string (stats.frames) + " frames, "
             + std::to_string (S.playback->restarts ()) + " audio restart(s)" + (S.playback->started () ? "" : ", output not running: " + S.playback->error ()));
    }
    S.playback.reset ();    // stops the audio engine: the plug-in is not called from the audio thread anymore
    if (S.editor != nullptr)
    {
        if (S.rendering)
            S.editor->stopRendering ();
        S.rendering = false;
        auto& document { *S.context->document };
        auto playbackRenderer { S.editor->getPlaybackRenderer () };
        auto editorRenderer { S.editor->getEditorRenderer () };
        for (auto* playbackRegion : document.regions (S.context->layout.renderClip))
        {
            playbackRenderer.removePlaybackRegion (document.controller ()->getRef (playbackRegion));
            editorRenderer.removePlaybackRegion (document.controller ()->getRef (playbackRegion));
        }
        S.editor.reset ();  // removes the editor view while its parent view still exists
    }
}

@end

namespace
{
    // true if the host's own Space handling did what this request (sent at 'when') asks for: the two came
    // within the dedup window of each other, in either order (a request from a worker thread can reach the
    // main thread after the key). See hostcore/TransportKey.h.
    bool droppedAfterSpace (const char* what, std::chrono::steady_clock::time_point when)
    {
        const double msApart { S.lastHostToggle ? std::fabs (std::chrono::duration<double, std::milli> (when - *S.lastHostToggle).count ()) : -1.0 };
        if (! bridge::ignorePlugInTransportRequest (msApart))
        {
            S.lastPlugInRequest = when;
            return false;
        }
        say (std::string ("plug-in requests: ") + what + " (ignored: the host just handled the same Space key)");
        return true;
    }

    void TransportRequests::onMainThread (void (^work) (BridgeDelegate* delegate, Clock::time_point when))
    {
        const Clock::time_point when { Clock::now () };
        if ([NSThread isMainThread])
        {
            if (*_alive)
                work (_delegate, when);
            return;
        }
        const std::shared_ptr<bool> alive { _alive };
        __weak BridgeDelegate* delegate { _delegate };
        dispatch_async (dispatch_get_main_queue (), ^{
            if (! *alive)
                return;
            say ("plug-in request from another thread, handled on the main thread");
            work (delegate, when);
        });
    }

    void TransportRequests::requestStartPlayback ()
    {
        onMainThread (^(BridgeDelegate* delegate, Clock::time_point when) {
            if (droppedAfterSpace ("start playback", when))
                return;
            say ("plug-in requests: start playback");
            [delegate startPlayback];
        });
    }

    void TransportRequests::requestStopPlayback ()
    {
        onMainThread (^(BridgeDelegate* delegate, Clock::time_point when) {
            if (droppedAfterSpace ("stop playback", when))
                return;
            say ("plug-in requests: stop playback");
            [delegate stopPlayback];
        });
    }

    void TransportRequests::requestSetPlaybackPosition (double timePosition)
    {
        onMainThread (^(BridgeDelegate*, Clock::time_point) {
            say ("plug-in requests: position " + std::to_string (timePosition) + " s");
            if (S.playback != nullptr)
                S.playback->seek (samplesAt (timePosition));
        });
    }

    void TransportRequests::requestSetCycleRange (double startTime, double duration)
    {
        onMainThread (^(BridgeDelegate*, Clock::time_point) {
            say ("plug-in requests: cycle " + std::to_string (startTime) + " s + " + std::to_string (duration) + " s");
            if (S.playback != nullptr)
                S.playback->setCycle (samplesAt (startTime), samplesAt (startTime + duration));
        });
    }

    void TransportRequests::requestEnableCycle (bool enable)
    {
        onMainThread (^(BridgeDelegate*, Clock::time_point) {
            say (std::string ("plug-in requests: cycle ") + (enable ? "on" : "off"));
            if (S.playback != nullptr)
                S.playback->enableCycle (enable);
        });
    }
}

void installEarlyQuitHandler ()
{
    static id handler { nil };
    if (handler != nil)
        return;
    handler = [[EarlyQuitHandler alloc] init];
    [[NSAppleEventManager sharedAppleEventManager] setEventHandler: handler andSelector: @selector (handleQuitEvent:withReplyEvent:)
                                                     forEventClass: kCoreEventClass andEventID: kAEQuitApplication];
    NSApp.delegate = handler;       // runHostApp installs the window's delegate
}

int runHostApp (AppContext& context)
{
    S = State {};
    S.context = &context;
    {
        const char* testChoices { std::getenv ("ARABRIDGE_TEST_SELECT_OUTPUT") };
        const char* settings { std::getenv ("ARABRIDGE_AUDIO_SETTINGS") };
        S.saveOutputChoice = testChoices == nullptr || *testChoices == '\0' || (settings != nullptr && *settings != '\0');
    }
    if (gEarlyQuit)
    {
        writeCancelled ("quit before the window opened", bridge::kExitCancelled);
        return S.exitCode;
    }

    NSApplication* app { [NSApplication sharedApplication] };
    [app setActivationPolicy: NSApplicationActivationPolicyRegular];
    NSMenu* menuBar { [[NSMenu alloc] init] };
    NSMenuItem* appItem { [[NSMenuItem alloc] init] };
    [menuBar addItem: appItem];
    NSMenu* appMenu { [[NSMenu alloc] init] };
    BridgeDelegate* delegate { [[BridgeDelegate alloc] init] };
    NSMenuItem* quit { [appMenu addItemWithTitle: @"Quit ARA Bridge" action: @selector (quitClicked:) keyEquivalent: @"q"] };
    quit.target = delegate;
    appItem.submenu = appMenu;
    app.mainMenu = menuBar;
    app.delegate = delegate;
    [app run];      // returns after stopApp

    // in order: playback, editor instance (with its view), then the window that held the view
    [[NSAppleEventManager sharedAppleEventManager] removeEventHandlerForEventClass: kCoreEventClass andEventID: kAEQuitApplication];
    [delegate teardownEditor];
    [delegate.window orderOut: nil];
    delegate.window.delegate = nil;
    delegate.window = nil;
    delegate.editorHolder = nil;
    app.delegate = nil;
    return S.exitCode;
}
