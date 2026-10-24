#pragma once

// The editor window's Space key, SDK-free so the decision can be unit-tested.
//
// Melodyne's editor view passes Space up the responder chain without using it and without asking the host
// to play (measured in the window: the key reaches the window's keyDown: unhandled, the plug-in issues no
// ARA transport request). The window therefore makes Space the Play/Stop key itself, when nobody before it
// used the key. A plug-in that does handle Space issues an ARA playback request (start/stop); the two paths
// must never both toggle for one key press:
//  - a start/stop request that arrived just before the key reached the window means the plug-in acted:
//    the host does not toggle;
//  - a start/stop request that arrives just after the host toggled is dropped (the key already did it).
namespace bridge
{
    // Both directions use the same window.
    constexpr double kTransportDedupMs { 150.0 };

    struct SpaceKey
    {
        bool isSpace { false };             // key code Space, no characters other than " "
        bool hasModifiers { false };        // shift, control, option or command held
        bool isRepeat { false };            // auto-repeat of a held key
        bool editing { false };             // the window is in its editing phase (not Apply, not closing)
        bool sheetShown { false };          // a sheet (the Apply sheet) is attached to the window
        bool textEditing { false };         // the first responder is a text field / text view being edited
        double msSincePlugInRequest { 1e9 };   // since the plug-in's last start/stop request
    };

    enum class SpaceAction
    {
        passOn,     // not ours: leave the event to the responder chain (other keys, modified Space, text editing)
        swallow,    // ours, but nothing to do now (Apply, sheet, key repeat, the plug-in just acted); no beep
        toggle,     // Play/Stop, the same code path as the button
    };

    SpaceAction decideSpaceKey (const SpaceKey& key);

    // A plug-in start/stop request that comes 'msSinceHostToggle' after the host toggled for Space.
    bool ignorePlugInTransportRequest (double msSinceHostToggle);
}
