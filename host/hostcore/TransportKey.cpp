#include "hostcore/TransportKey.h"

namespace bridge
{
    SpaceAction decideSpaceKey (const SpaceKey& key)
    {
        if (! key.isSpace || key.hasModifiers || key.textEditing)
            return SpaceAction::passOn;
        if (key.isRepeat || ! key.editing || key.sheetShown)
            return SpaceAction::swallow;
        if (key.msSincePlugInRequest >= 0.0 && key.msSincePlugInRequest < kTransportDedupMs)
            return SpaceAction::swallow;
        return SpaceAction::toggle;
    }

    bool ignorePlugInTransportRequest (double msSinceHostToggle)
    {
        return msSinceHostToggle >= 0.0 && msSinceHostToggle < kTransportDedupMs;
    }
}
