#include "check.h"

#include "hostcore/TransportKey.h"

namespace
{
    bridge::SpaceKey plainSpace ()
    {
        bridge::SpaceKey key;
        key.isSpace = true;
        key.editing = true;
        return key;
    }
}

TEST (space_toggles_when_editing)
{
    CHECK (bridge::decideSpaceKey (plainSpace ()) == bridge::SpaceAction::toggle);
}

TEST (other_keys_and_modified_space_are_not_ours)
{
    bridge::SpaceKey key { plainSpace () };
    key.isSpace = false;
    CHECK (bridge::decideSpaceKey (key) == bridge::SpaceAction::passOn);
    key = plainSpace ();
    key.hasModifiers = true;
    CHECK (bridge::decideSpaceKey (key) == bridge::SpaceAction::passOn);
}

TEST (space_in_a_text_field_is_left_alone_in_every_phase)
{
    bridge::SpaceKey key { plainSpace () };
    key.textEditing = true;
    CHECK (bridge::decideSpaceKey (key) == bridge::SpaceAction::passOn);
    key.editing = false;
    key.sheetShown = true;
    CHECK (bridge::decideSpaceKey (key) == bridge::SpaceAction::passOn);
}

TEST (space_does_nothing_but_is_consumed_during_apply_with_a_sheet_or_on_repeat)
{
    bridge::SpaceKey key { plainSpace () };
    key.editing = false;
    CHECK (bridge::decideSpaceKey (key) == bridge::SpaceAction::swallow);
    key = plainSpace ();
    key.sheetShown = true;
    CHECK (bridge::decideSpaceKey (key) == bridge::SpaceAction::swallow);
    key = plainSpace ();
    key.isRepeat = true;
    CHECK (bridge::decideSpaceKey (key) == bridge::SpaceAction::swallow);
}

TEST (space_does_not_toggle_when_the_plug_in_just_sent_a_transport_request)
{
    bridge::SpaceKey key { plainSpace () };
    key.msSincePlugInRequest = 0.0;
    CHECK (bridge::decideSpaceKey (key) == bridge::SpaceAction::swallow);
    key.msSincePlugInRequest = bridge::kTransportDedupMs - 1.0;
    CHECK (bridge::decideSpaceKey (key) == bridge::SpaceAction::swallow);
    key.msSincePlugInRequest = bridge::kTransportDedupMs;
    CHECK (bridge::decideSpaceKey (key) == bridge::SpaceAction::toggle);
    key.msSincePlugInRequest = 5000.0;
    CHECK (bridge::decideSpaceKey (key) == bridge::SpaceAction::toggle);
}

TEST (plug_in_requests_right_after_a_host_toggle_are_ignored)
{
    CHECK (bridge::ignorePlugInTransportRequest (0.0));
    CHECK (bridge::ignorePlugInTransportRequest (bridge::kTransportDedupMs - 1.0));
    CHECK (! bridge::ignorePlugInTransportRequest (bridge::kTransportDedupMs));
    CHECK (! bridge::ignorePlugInTransportRequest (60000.0));
    CHECK (! bridge::ignorePlugInTransportRequest (-1.0));     // never toggled
}
