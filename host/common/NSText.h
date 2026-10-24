#pragma once

// UTF-8 text between std::string and NSString (Objective-C++ only).
//
// Never put a std::string or char* into an NSString with [NSString stringWithFormat: @"%s", ...]: %s reads
// the bytes in the system encoding (Mac Roman), not UTF-8, so "Müller" shows as "M√ºller". Use
// [NSString stringWithFormat: @"%@", ns (text)] or ns (text) directly.

#import <Foundation/Foundation.h>

#include <string>

namespace bridge
{
    // Never nil: text that is not valid UTF-8 is read as Latin-1, which accepts any byte sequence.
    inline NSString* ns (const std::string& text)
    {
        NSString* string = [[NSString alloc] initWithBytes: text.data () length: text.size () encoding: NSUTF8StringEncoding];
        if (string == nil)
            string = [[NSString alloc] initWithBytes: text.data () length: text.size () encoding: NSISOLatin1StringEncoding];
        return string != nil ? string : @"";
    }

    // A C string (nullptr gives an empty string).
    inline NSString* ns (const char* text)
    {
        return ns (std::string { text != nullptr ? text : "" });
    }

    // UTF-8 bytes of 'text' (nil gives an empty string).
    inline std::string utf8 (NSString* text)
    {
        const char* bytes { text != nil ? text.UTF8String : nullptr };
        return bytes != nullptr ? std::string { bytes } : std::string {};
    }
}
