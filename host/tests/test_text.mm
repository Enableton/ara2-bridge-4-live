#include "check.h"

#include "common/NSText.h"

#include <string>

TEST (ns_text_keeps_utf8)
{
    const std::string name { "Gesang M\xC3\xBCller \xF0\x9F\x8E\xA4" };     // "Gesang Müller" + microphone emoji
    NSString* string { bridge::ns (name) };
    CHECK ([string isEqualToString: @"Gesang Müller \U0001F3A4"]);
    CHECK (string.length == 16);    // the emoji is two UTF-16 units
    CHECK (bridge::utf8 (string) == name);

    // the bug it replaces: %s reads the bytes in the system encoding
    NSString* formatted { [NSString stringWithFormat: @"Selected the %@ in the editor.", bridge::ns (name)] };
    CHECK (bridge::utf8 (formatted) == "Selected the " + name + " in the editor.");
}

TEST (ns_text_never_returns_nil)
{
    CHECK ([bridge::ns (std::string {}) isEqualToString: @""]);
    CHECK ([bridge::ns (static_cast<const char*> (nullptr)) isEqualToString: @""]);
    CHECK ([bridge::ns ("Melodyne") isEqualToString: @"Melodyne"]);
    // invalid UTF-8 is read as Latin-1
    NSString* latin1 { bridge::ns (std::string { "M\xFCller" }) };
    REQUIRE (latin1 != nil);
    CHECK ([latin1 isEqualToString: @"Müller"]);
    // an embedded NUL is kept
    CHECK (bridge::ns (std::string ("a\0b", 3)).length == 3);
    CHECK (bridge::utf8 (nil).empty ());
}
