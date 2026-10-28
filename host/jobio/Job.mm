#include "jobio/Job.h"

#include "common/NSText.h"

#import <Foundation/Foundation.h>

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <sys/stat.h>
#include <unistd.h>

namespace bridge
{
    namespace
    {
        // job.json and result.json come from other processes, so every size and number is range-checked.
        constexpr off_t kMaxFileBytes { 16 * 1024 * 1024 };
        constexpr size_t kMaxStringBytes { 65536 };
        constexpr size_t kMaxMessageBytes { 4096 };     // writeResult shortens a longer message
        constexpr size_t kMaxClips { 16 };
        constexpr double kMaxSeconds { 86400.0 };
        constexpr double kMaxBeats { 1.0e7 };
        constexpr double kMaxTempo { 1.0e4 };
        constexpr double kMaxExactInteger { 9007199254740992.0 };   // 2^53: integers up to here survive a double
        constexpr double kMaxShiftMagnitude { 1.0e12 };                // limit for a shift and a correlation value
        constexpr int kMaxResultSampleRate { 768000 };

        std::string formatNumber (double value)
        {
            char text[32];
            std::snprintf (text, sizeof (text), "%.10g", value);
            return text;
        }

        bool fail (std::string& error, const std::string& message)
        {
            error = message;
            return false;
        }

        // Never nil: text that is not valid UTF-8 is read as Latin-1, which accepts any byte sequence.
        NSString* makeString (const std::string& text)
        {
            return ns (text);
        }

        // 'value' as an instance of T, or nil if it is not one (also for nil).
        template <typename T>
        T* as (NSObject* value)
        {
            return [value isKindOfClass: [T class]] ? static_cast<T*> (value) : nil;
        }

        // Reads a JSON file that must hold an object. The error message names the file.
        NSDictionary* readJsonObject (const std::string& path, std::string& error)
        {
            struct stat info {};
            if (::stat (path.c_str (), &info) != 0 || ! S_ISREG (info.st_mode))
            {
                error = "cannot read " + path;
                return nil;
            }
            if (info.st_size > kMaxFileBytes)
            {
                error = path + " is too large";
                return nil;
            }

            NSData* data = [NSData dataWithContentsOfFile: makeString (path)];
            if (data == nil)
            {
                error = "cannot read " + path;
                return nil;
            }

            NSError* nsError = nil;
            NSDictionary* root = as<NSDictionary> ([NSJSONSerialization JSONObjectWithData: data options: 0 error: &nsError]);
            if (root == nil)
            {
                error = path + " is not a valid JSON object";
                if (const char* reason = nsError != nil ? nsError.localizedDescription.UTF8String : nullptr)
                    error += std::string { " (" } + reason + ")";
                return nil;
            }
            return root;
        }

        // Field readers. An absent (or null) key leaves 'out' at the caller's default unless it is required;
        // a key of the wrong type is an error. 'where' prefixes the key in messages, e.g. "clips[0]".
        NSObject* fieldValue (NSDictionary* dict, const char* key)
        {
            NSObject* value = dict[makeString (key)];
            return (value == nil || value == [NSNull null]) ? nil : value;
        }

        std::string fieldName (const std::string& where, const char* key)
        {
            return "'" + (where.empty () ? std::string { key } : where + "." + key) + "'";
        }

        bool isBoolean (NSObject* value)
        {
            return CFGetTypeID ((__bridge CFTypeRef) value) == CFBooleanGetTypeID ();
        }

        bool readString (NSDictionary* dict, const char* key, const std::string& where, bool required, std::string& out, std::string& error)
        {
            NSObject* value = fieldValue (dict, key);
            if (value == nil)
                return required ? fail (error, "missing " + fieldName (where, key)) : true;
            NSString* string = as<NSString> (value);
            if (string == nil)
                return fail (error, fieldName (where, key) + " must be a string");

            NSData* utf8 = [string dataUsingEncoding: NSUTF8StringEncoding];     // nil for a lone surrogate
            if (utf8 == nil)
                return fail (error, fieldName (where, key) + " is not valid text");
            if (utf8.length > kMaxStringBytes)
                return fail (error, fieldName (where, key) + " is too long");

            std::string text;
            if (utf8.length > 0)
                text.assign (static_cast<const char*> (utf8.bytes), utf8.length);
            if (text.find ('\0') != std::string::npos)
                return fail (error, fieldName (where, key) + " contains a NUL character");
            out = text;
            return true;
        }

        bool readNumber (NSDictionary* dict, const char* key, const std::string& where, bool required, double lowest, double highest, double& out, std::string& error)
        {
            NSObject* value = fieldValue (dict, key);
            if (value == nil)
                return required ? fail (error, "missing " + fieldName (where, key)) : true;
            NSNumber* numberValue = as<NSNumber> (value);
            if (numberValue == nil || isBoolean (value))
                return fail (error, fieldName (where, key) + " must be a number");

            const double number { numberValue.doubleValue };
            if (! std::isfinite (number) || number < lowest || number > highest)
                return fail (error, fieldName (where, key) + " is out of range");
            out = number;
            return true;
        }

        bool readInteger (NSDictionary* dict, const char* key, const std::string& where, int64_t& out, std::string& error)
        {
            double number { 0.0 };
            if (! readNumber (dict, key, where, true, -kMaxExactInteger, kMaxExactInteger, number, error))
                return false;
            if (number != std::floor (number))
                return fail (error, fieldName (where, key) + " must be a whole number");
            out = static_cast<int64_t> (number);
            return true;
        }

        // An optional whole number in [minimum, maximum]; 'out' keeps its value if the key is absent.
        bool readOptionalInteger (NSDictionary* dict, const char* key, double minimum, double maximum, int64_t& out, std::string& error)
        {
            double number { static_cast<double> (out) };
            if (! readNumber (dict, key, "", false, minimum, maximum, number, error))
                return false;
            if (number != std::floor (number))
                return fail (error, fieldName ("", key) + " must be a whole number");
            out = static_cast<int64_t> (number);
            return true;
        }

        bool readBool (NSDictionary* dict, const char* key, const std::string& where, bool& out, std::string& error)
        {
            NSObject* value = fieldValue (dict, key);
            if (value == nil)
                return true;
            NSNumber* boolean = as<NSNumber> (value);
            if (boolean == nil || ! isBoolean (value))
                return fail (error, fieldName (where, key) + " must be true or false");
            out = boolean.boolValue;
            return true;
        }

        // An optional object: nil if absent; sets 'ok' to false (and the error) if it has another type.
        NSDictionary* readObject (NSDictionary* dict, const char* key, const std::string& where, bool& ok, std::string& error)
        {
            NSObject* value = fieldValue (dict, key);
            ok = true;
            if (value == nil)
                return nil;
            NSDictionary* object = as<NSDictionary> (value);
            if (object == nil)
                ok = fail (error, fieldName (where, key) + " must be an object");
            return object;
        }

        int countRole (const std::vector<JobClip>& clips, const char* role)
        {
            return static_cast<int> (std::count_if (clips.begin (), clips.end (), [role] (const JobClip& c) { return c.role == role; }));
        }

        // A vocalign job needs every clip's position: guide and dub keep their relative timing only if both have it.
        bool parseClip (NSDictionary* item, const std::string& where, bool requireBeats, JobClip& clip, std::string& error)
        {
            if (! readString (item, "role", where, true, clip.role, error)
                || ! readString (item, "path", where, true, clip.path, error)
                || ! readString (item, "name", where, false, clip.name, error)
                || ! readNumber (item, "startSec", where, false, 0.0, kMaxSeconds, clip.startSec, error)
                || ! readNumber (item, "endSec", where, true, 0.0, kMaxSeconds, clip.endSec, error)
                || ! readNumber (item, "startBeats", where, requireBeats, 0.0, kMaxBeats, clip.startBeats, error))
                return false;

            if (clip.name.empty ())
                clip.name = clip.role;
            if (clip.path.empty ())
                return fail (error, fieldName (where, "path") + " is empty");
            // the host runs with an unknown working folder: a relative path would point somewhere else
            if (clip.path[0] != '/')
                return fail (error, fieldName (where, "path") + " must be an absolute path (starting with '/')");
            if (! (clip.endSec > clip.startSec))
                return fail (error, "clip '" + clip.name + "' has an invalid time range");
            return true;
        }

        bool parseJob (NSDictionary* root, Job& parsed, std::string& error)
        {
            double version { 0.0 };
            if (! readNumber (root, "version", "", true, -1.0e6, 1.0e6, version, error))
                return false;
            if (version != 1.0)
                return fail (error, "unsupported job version " + formatNumber (version));
            parsed.version = 1;

            if (! readString (root, "id", "", true, parsed.id, error)
                || ! readString (root, "plugin", "", true, parsed.plugin, error)
                || ! readString (root, "placement", "", false, parsed.placement, error)
                || ! readString (root, "output", "", false, parsed.output, error)
                || ! readBool (root, "realign", "", parsed.realign, error)
                || ! readBool (root, "preview", "", parsed.preview, error)
                || ! readBool (root, "sync", "", parsed.sync, error))
                return false;

            bool ok { true };
            NSDictionary* song = readObject (root, "song", "", ok, error);
            if (! ok)
                return false;
            // Beats are converted with the tempo, so a vocalign job without it would lose the clips' relative timing.
            const bool requireTiming { parsed.plugin == "vocalign" };
            if (song != nil && ! readNumber (song, "tempo", "song", requireTiming, 0.0, kMaxTempo, parsed.tempo, error))
                return false;
            if (song == nil && requireTiming)
                return fail (error, "missing 'song.tempo'");

            if (parsed.id.empty ())
                return fail (error, "job has no id");
            if (parsed.plugin != "melodyne" && parsed.plugin != "vocalign")
                return fail (error, "unknown plug-in '" + parsed.plugin + "'");
            if (parsed.placement != "takeLane" && parsed.placement != "newTrack" && parsed.placement != "replace")
                return fail (error, "unknown placement '" + parsed.placement + "'");
            if (parsed.output != "dub" && parsed.output != "guide")
                return fail (error, "unknown output '" + parsed.output + "' (\"dub\" or \"guide\")");
            if (parsed.output == "guide" && parsed.plugin != "vocalign")
                return fail (error, "'output' \"guide\" needs a vocalign job");
            if (! (parsed.tempo > 0.0))
                return fail (error, "'song.tempo' must be positive");

            NSObject* clipsValue = fieldValue (root, "clips");
            if (clipsValue == nil)
                return fail (error, "missing 'clips'");
            NSArray* clips = as<NSArray> (clipsValue);
            if (clips == nil)
                return fail (error, "'clips' must be an array");
            if (clips.count == 0)
                return fail (error, "job has no clips");
            if (clips.count > kMaxClips)
                return fail (error, "job has too many clips");

            NSUInteger index { 0 };
            for (NSObject* item in clips)
            {
                const std::string where { "clips[" + std::to_string (index++) + "]" };
                NSDictionary* clipObject = as<NSDictionary> (item);
                if (clipObject == nil)
                    return fail (error, "'" + where + "' must be an object");
                JobClip clip;
                if (! parseClip (clipObject, where, requireTiming, clip, error))
                    return false;
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
            return true;
        }

        bool validStatus (const std::string& status)
        {
            return status == "ok" || status == "cancelled" || status == "error";
        }

        bool validPlaceAt (const std::string& placeAt)
        {
            return placeAt == "guide" || placeAt == "dub";
        }

        std::string withReason (const std::string& what, int code)
        {
            return what + ": " + std::strerror (code);
        }

        // temp file in the same folder, flushed to disk, then renamed over 'finalPath' (rename is atomic on one volume);
        // 'exclusive' publishes with link() instead, which never replaces an existing file.
        bool writeFileAtomically (const std::string& finalPath, const void* bytes, size_t size, std::string& error, bool exclusive)
        {
            const std::string tmp { finalPath + ".tmp" };
            errno = 0;
            FILE* file { std::fopen (tmp.c_str (), "wb") };
            if (file == nullptr)
                return fail (error, withReason ("cannot write " + tmp, errno));

            // errno is kept from the first step that fails.
            int code { 0 };
            if (std::fwrite (bytes, 1, size, file) != size)
                code = errno != 0 ? errno : EIO;
            if (std::fflush (file) != 0 && code == 0)
                code = errno;
            if (::fsync (::fileno (file)) != 0 && code == 0)
                code = errno;
            if (std::fclose (file) != 0 && code == 0)
                code = errno;
            if (code != 0)
            {
                std::remove (tmp.c_str ());
                return fail (error, withReason ("cannot write " + tmp, code));
            }
            if (exclusive)
            {
                const bool linked { ::link (tmp.c_str (), finalPath.c_str ()) == 0 };
                const int linkError { errno };
                std::remove (tmp.c_str ());
                if (! linked)
                    return fail (error, linkError == EEXIST ? finalPath + " already exists" : withReason ("cannot publish " + finalPath, linkError));
                return true;
            }
            if (std::rename (tmp.c_str (), finalPath.c_str ()) != 0)
            {
                const int renameError { errno };
                std::remove (tmp.c_str ());
                return fail (error, withReason ("cannot rename " + tmp + " to " + finalPath, renameError));
            }
            return true;
        }

        // Text for result.json that readResult will accept again: no NUL (for message it is dropped), and not
        // longer than 'maxBytes' once encoded as UTF-8. 'truncate' cuts a longer text on a character boundary;
        // otherwise it is an error.
        bool encodeText (const std::string& text, const char* key, size_t maxBytes, bool truncate, NSString* __strong& out, std::string& error)
        {
            std::string clean { text };
            const bool hasNul { clean.find ('\0') != std::string::npos };
            if (hasNul && ! truncate)
                return fail (error, std::string { "'" } + key + "' contains a NUL character");
            clean.erase (std::remove (clean.begin (), clean.end (), '\0'), clean.end ());

            out = makeString (clean);
            NSData* utf8 = [out dataUsingEncoding: NSUTF8StringEncoding];       // longer than 'clean' if it was read as Latin-1
            if (utf8 != nil && utf8.length > maxBytes && truncate)
            {
                const auto* bytes { static_cast<const unsigned char*> (utf8.bytes) };
                size_t cut { maxBytes };
                while (cut > 0 && (bytes[cut] & 0xC0) == 0x80)                  // never end inside a character
                    --cut;
                out = [[NSString alloc] initWithBytes: bytes length: cut encoding: NSUTF8StringEncoding];
                utf8 = [out dataUsingEncoding: NSUTF8StringEncoding];
            }
            if (utf8 == nil || utf8.length > maxBytes)
                return fail (error, std::string { "'" } + key + "' is too long");
            return true;
        }
    }

    bool loadJob (const std::string& jobDir, Job& job, std::string& error)
    {
        @autoreleasepool
        {
            error.clear ();
            NSDictionary* root = readJsonObject (jobDir + "/job.json", error);
            if (root == nil)
                return false;

            Job parsed;
            parsed.dir = jobDir;
            if (! parseJob (root, parsed, error))
            {
                error = "job.json: " + error;
                return false;
            }

            job = parsed;
            return true;
        }
    }

    bool writeResult (const std::string& jobDir, const std::string& jobId, const ResultInfo& info, std::string& error, bool exclusive)
    {
        @autoreleasepool
        {
            error.clear ();
            if (! validStatus (info.status))
                return fail (error, "unknown result status '" + info.status + "'");

            NSString* jobIdText { nil };
            NSString* message { nil };
            NSString* diagnostics { nil };
            NSString* resultPath { nil };
            if (! encodeText (jobId, "id", kMaxStringBytes, false, jobIdText, error)
                || ! encodeText (info.message, "message", kMaxMessageBytes, true, message, error)
                || ! encodeText (info.diagnostics, "diagnostics", kMaxMessageBytes, true, diagnostics, error)
                || ! encodeText (info.resultPath, "resultPath", kMaxStringBytes, false, resultPath, error))
                return false;

            if (! info.realignReason.empty () && ! isRealignReason (info.realignReason))
                return fail (error, "unknown realign reason '" + info.realignReason + "'");
            if (info.sourceStartFrame < 0 || static_cast<double> (info.sourceStartFrame) > kMaxExactInteger
                || info.frames < 0 || static_cast<double> (info.frames) > kMaxExactInteger
                || info.sampleRate < 0 || info.sampleRate > kMaxResultSampleRate)
                return fail (error, "the result's frame range or sample rate is out of range");
            if (! info.placeAt.empty () && ! validPlaceAt (info.placeAt))
                return fail (error, "unknown result placeAt '" + info.placeAt + "'");
            if (info.offsetFrames < 0 || static_cast<double> (info.offsetFrames) > kMaxExactInteger
                || info.droppedFrames < 0 || static_cast<double> (info.droppedFrames) > kMaxExactInteger)
                return fail (error, "the result's offsetFrames or droppedFrames is out of range");

            // What readResult accepts: whole numbers up to 2^53 for the positions, magnitudes up to 1e12 for the rest.
            NSMutableArray* shifts = [NSMutableArray array];
            for (const auto& s : info.shifts)
            {
                if (std::fabs (static_cast<double> (s.start)) > kMaxExactInteger || std::fabs (static_cast<double> (s.end)) > kMaxExactInteger)
                    return fail (error, "a realign segment position is out of range");
                if (! std::isfinite (s.shift) || ! std::isfinite (s.correlation) || std::fabs (s.shift) > kMaxShiftMagnitude || std::fabs (s.correlation) > kMaxShiftMagnitude)
                    return fail (error, "a realign shift is not a finite number in range");
                [shifts addObject: @{ @"start": @(s.start), @"end": @(s.end), @"shift": @(s.shift), @"correlation": @(s.correlation) }];
            }

            NSMutableDictionary* realign = [NSMutableDictionary dictionaryWithDictionary: @{ @"applied": @(info.realignApplied), @"shifts": shifts }];
            if (! info.realignReason.empty ())
                realign[@"reason"] = makeString (info.realignReason);
            NSMutableDictionary* root = [NSMutableDictionary dictionaryWithDictionary: @{ @"version": @1,
                                                                                            @"id": jobIdText,
                                                                                            @"status": makeString (info.status),
                                                                                            @"message": message,
                                                                                            @"diagnostics": diagnostics,
                                                                                            @"sourceStartFrame": @(info.sourceStartFrame),
                                                                                            @"frames": @(info.frames),
                                                                                            @"sampleRate": @(info.sampleRate),
                                                                                            @"resultPath": resultPath,
                                                                                            @"realign": realign }];
            if (! info.placeAt.empty ())
            {
                root[@"placeAt"] = makeString (info.placeAt);
                root[@"offsetFrames"] = @(info.offsetFrames);
                root[@"droppedFrames"] = @(info.droppedFrames);
            }

            // Foundation raises an exception (not an error) for values it cannot encode, so check first and catch anyway.
            NSData* data = nil;
            if ([NSJSONSerialization isValidJSONObject: root])
            {
                @try
                {
                    data = [NSJSONSerialization dataWithJSONObject: root
                                                           options: NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys | NSJSONWritingWithoutEscapingSlashes
                                                             error: nil];
                }
                @catch (NSException*)
                {
                    data = nil;
                }
            }
            if (data == nil)
                return fail (error, "cannot encode result.json");

            return writeFileAtomically (jobDir + "/result.json", data.bytes, data.length, error, exclusive);
        }
    }

    bool readResult (const std::string& jobDir, ResultInfo& info, std::string& error)
    {
        @autoreleasepool
        {
            error.clear ();
            NSDictionary* root = readJsonObject (jobDir + "/result.json", error);
            if (root == nil)
                return false;

            ResultInfo parsed;
            int64_t sampleRate { 0 };
            bool ok { true };
            NSDictionary* realign { nil };
            const auto readRealign = [&] { realign = readObject (root, "realign", "", ok, error); return ok; };
            if (! readString (root, "id", "", false, parsed.id, error)
                || ! readString (root, "status", "", true, parsed.status, error)
                || ! readString (root, "message", "", false, parsed.message, error)
                || ! readString (root, "diagnostics", "", false, parsed.diagnostics, error)
                || ! readOptionalInteger (root, "sourceStartFrame", 0.0, kMaxExactInteger, parsed.sourceStartFrame, error)
                || ! readOptionalInteger (root, "frames", 0.0, kMaxExactInteger, parsed.frames, error)
                || ! readOptionalInteger (root, "sampleRate", 0.0, kMaxResultSampleRate, sampleRate, error)
                || ! readString (root, "resultPath", "", false, parsed.resultPath, error)
                || ! readString (root, "placeAt", "", false, parsed.placeAt, error)
                || ! readOptionalInteger (root, "offsetFrames", 0.0, kMaxExactInteger, parsed.offsetFrames, error)
                || ! readOptionalInteger (root, "droppedFrames", 0.0, kMaxExactInteger, parsed.droppedFrames, error)
                || ! readRealign ()
                || (realign != nil && ! readBool (realign, "applied", "realign", parsed.realignApplied, error))
                || (realign != nil && ! readString (realign, "reason", "realign", false, parsed.realignReason, error)))
            {
                error = "result.json: " + error;
                return false;
            }
            if (! validStatus (parsed.status))
            {
                error = "result.json: unknown status '" + parsed.status + "'";
                return false;
            }
            if (! parsed.realignReason.empty () && ! isRealignReason (parsed.realignReason))
            {
                error = "result.json: unknown 'realign.reason' '" + parsed.realignReason + "'";
                return false;
            }
            if (! parsed.placeAt.empty () && ! validPlaceAt (parsed.placeAt))
            {
                error = "result.json: unknown 'placeAt' '" + parsed.placeAt + "'";
                return false;
            }
            parsed.sampleRate = static_cast<int> (sampleRate);

            NSObject* shiftsValue = realign != nil ? fieldValue (realign, "shifts") : nil;
            NSArray* shifts = as<NSArray> (shiftsValue);
            if (shiftsValue != nil && shifts == nil)
            {
                error = "result.json: 'realign.shifts' must be an array";
                return false;
            }

            NSUInteger index { 0 };
            for (NSObject* item in shifts)
            {
                const std::string where { "realign.shifts[" + std::to_string (index++) + "]" };
                ShiftSegment s;
                NSDictionary* segment = as<NSDictionary> (item);
                if (segment == nil)
                    error = "'" + where + "' must be an object";
                else if (readInteger (segment, "start", where, s.start, error)
                         && readInteger (segment, "end", where, s.end, error)
                         && readNumber (segment, "shift", where, true, -kMaxShiftMagnitude, kMaxShiftMagnitude, s.shift, error)           // fractional samples
                         && readNumber (segment, "correlation", where, false, -kMaxShiftMagnitude, kMaxShiftMagnitude, s.correlation, error))
                {
                    parsed.shifts.push_back (s);
                    continue;
                }
                error = "result.json: " + error;
                return false;
            }

            info = parsed;
            return true;
        }
    }

    bool isRealignReason (const std::string& reason)
    {
        return reason == "not-requested" || reason == "nothing-to-do" || reason == "no-confident-match" || reason == "inconsistent-shifts"
               || reason == "applied";
    }

    std::string defaultSettingsPath ()
    {
        @autoreleasepool
        {
            NSString* path = [NSHomeDirectory () stringByAppendingPathComponent: @"Library/Application Support/ARABridge/settings.json"];
            const char* text { path.UTF8String };
            return text != nullptr ? std::string { text } : std::string {};
        }
    }

    std::map<std::string, std::string> loadPlugInOverrides (const std::string& settingsPath, std::string* error)
    {
        std::map<std::string, std::string> overrides;
        if (error != nullptr)
            error->clear ();

        @autoreleasepool
        {
            struct stat info {};
            if (::stat (settingsPath.c_str (), &info) != 0)
                return overrides;                           // no settings file is normal

            std::string problem;
            NSDictionary* root = readJsonObject (settingsPath, problem);
            if (root == nil)
            {
                if (error != nullptr)
                    *error = problem;
                return overrides;
            }

            NSObject* pathsValue = fieldValue (root, "pluginPaths");
            if (pathsValue == nil)
                return overrides;
            NSDictionary* paths = as<NSDictionary> (pathsValue);
            if (paths == nil)
            {
                if (error != nullptr)
                    *error = "settings.json: 'pluginPaths' must be an object";
                return overrides;
            }

            for (NSObject* keyValue in paths)
            {
                NSString* key = as<NSString> (keyValue);
                NSString* value = key != nil ? as<NSString> (paths[key]) : nil;
                if (key == nil || value == nil)
                    continue;

                NSData* name = [key dataUsingEncoding: NSUTF8StringEncoding];
                NSData* path = [value dataUsingEncoding: NSUTF8StringEncoding];
                if (name == nil || path == nil || name.length == 0 || path.length == 0 || path.length > kMaxStringBytes)
                    continue;

                overrides[std::string { static_cast<const char*> (name.bytes), name.length }]
                    = std::string { static_cast<const char*> (path.bytes), path.length };
            }
        }
        return overrides;
    }

    bool loadKeepRaw (const std::string& settingsPath, std::string* warning)
    {
        if (warning != nullptr)
            warning->clear ();

        @autoreleasepool
        {
            struct stat info {};
            if (::stat (settingsPath.c_str (), &info) != 0)
                return false;                               // no settings file is normal

            std::string problem;
            NSDictionary* root = readJsonObject (settingsPath, problem);
            if (root == nil)
                return false;                               // loadPlugInOverrides reports a malformed file

            NSObject* value = fieldValue (root, "keepRaw");
            if (value == nil)
                return false;
            NSNumber* boolean = as<NSNumber> (value);
            if (boolean == nil || ! isBoolean (value))
            {
                if (warning != nullptr)
                    *warning = "settings.json: 'keepRaw' must be true or false; ignored";
                return false;
            }
            return boolean.boolValue;
        }
    }

    std::string defaultAudioSettingsPath ()
    {
        @autoreleasepool
        {
            NSString* path = [NSHomeDirectory () stringByAppendingPathComponent: @"Library/Application Support/ARABridge/audio.json"];
            const char* text { path.UTF8String };
            return text != nullptr ? std::string { text } : std::string {};
        }
    }

    bool loadAudioSettings (const std::string& path, AudioSettings& settings, std::string& error)
    {
        settings = {};
        error.clear ();
        @autoreleasepool
        {
            struct stat info {};
            if (::stat (path.c_str (), &info) != 0 && errno == ENOENT)
                return true;                                // no file: the system default

            NSDictionary* root = readJsonObject (path, error);
            if (root == nil)
                return false;
            AudioSettings parsed;
            if (! readString (root, "outputUID", "", false, parsed.outputUID, error)
                || ! readString (root, "outputName", "", false, parsed.outputName, error))
            {
                error = path + ": " + error;
                return false;
            }
            if (parsed.outputUID.empty ())
                parsed.outputName.clear ();
            settings = parsed;
            return true;
        }
    }

    bool saveAudioSettings (const std::string& path, const AudioSettings& settings, std::string& error)
    {
        error.clear ();
        @autoreleasepool
        {
            if (settings.outputUID.find ('\0') != std::string::npos || settings.outputName.find ('\0') != std::string::npos)
                return fail (error, "an audio setting contains a NUL character");
            if (settings.outputUID.size () > kMaxStringBytes || settings.outputName.size () > kMaxStringBytes)
                return fail (error, "an audio setting is too long");

            NSMutableDictionary* root = [NSMutableDictionary dictionary];
            if (! settings.outputUID.empty ())
            {
                root[@"outputUID"] = makeString (settings.outputUID);
                if (! settings.outputName.empty ())
                    root[@"outputName"] = makeString (settings.outputName);
            }
            NSError* nsError = nil;
            NSData* data = [NSJSONSerialization dataWithJSONObject: root options: NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys error: &nsError];
            if (data == nil)
                return fail (error, "cannot encode " + path);

            NSString* folder = [makeString (path) stringByDeletingLastPathComponent];
            if (folder.length > 0 && ! [[NSFileManager defaultManager] createDirectoryAtPath: folder withIntermediateDirectories: YES attributes: nil error: &nsError])
                return fail (error, "cannot create the folder of " + path + (nsError != nil ? " (" + utf8 (nsError.localizedDescription) + ")" : std::string {}));
            return writeFileAtomically (path, data.bytes, data.length, error, false);
        }
    }
}
