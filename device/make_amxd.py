#!/usr/bin/env python3
"""Build device/ARABridge.amxd (Max for Live Audio Effect, audio passes through unchanged).

    python3 device/make_amxd.py [out.amxd]      # default: device/ARABridge.amxd
    python3 device/make_amxd.py --install-root /Users/Shared/ARABridge/device out.amxd   # for a package (tools/make_package.sh)

Runs device/build.py first (device/build/bridge.js = src/core.js + src/bridge.js), then writes the container.
The js, node.script and jweb objects refer to their files by ABSOLUTE path, resolved from this file's location:
    js           <repo>/device/build/bridge.js
    node.script  <repo>/device/src/runner.js  @autostart 1 @watch 0
    jweb         readfile <repo>/device/ui/ara2bridge_ui.html   (the interface; installed next to bridge.js in a package)
so the repo must not move after building (rebuild with this script if it does). Paths with spaces are refused (they
would split the object box arguments).

Container (same as the probe device that loaded in this user's Live):
    b"ampf" + u32le(4) + b"aaaa"           device type: audio effect
    b"meta" + u32le(4) + u32le(0)
    b"ptch" + u32le(N) + payload           payload = patcher JSON + b"\\x00", N = len(payload)

The output is deterministic: no timestamps, fixed ids, fixed ordering (two builds are byte-identical).

Interface. The only object in presentation mode is ONE [jweb] (DEVICE_W x DEVICE_H) showing ui/ara2bridge_ui.html. The
live.menu / live.toggle objects stay in the patch (not presented) because THEY own the saved state: Live stores and
restores them with the set; the page only mirrors them. Signal flow (all message flow is plain Max objects; names are
the box ids):
  startup   live.thisdevice -> deferlow -> [t b b b] fires right to left: `readfile <html>` to jweb, bang the Placement
            menu (a live.menu re-outputs its restored value on bang), then the `ready` message to js. The toggles are
            NOT banged (a bang FLIPS a live.toggle); Live outputs their restored values itself. Those values and js's
            first status lines can come before the page exists: the page sends ui_loaded when its handlers are bound,
            which becomes `uiRefresh` to js, and js re-emits its settings, state and last status (see bridge.js).
  page->max jweb outlet 0 also carries load notifications (onloadstart, url, title ...), so everything goes through a
            whitelist [route ui_action ui_set ui_loaded]; the rest is dropped.
            ui_action <name> -> [route sendMelodyne setGuide sendVocAlign cancel refreshPlugins] -> message box -> js
            ui_set <placement|skip|preview|sync> <int> -> [route ...] -> the live.menu / live.toggle inlet (it outputs)
            ui_loaded -> message `uiRefresh` -> js
  settings  Placement menu index -> [prepend settings placement] -> js; Skip-realign toggle -> [expr 1-$i1] ->
            [prepend settings realign] -> js; Preview / Sync transport toggles -> [prepend settings preview|sync] -> js.
            The same outputs are tapped to jweb as `ui_state setting <name> <value>` (the raw toggle value for skip), so
            the page follows Live's restore, automation-free changes and a page click alike.
  node      node.script outlet 0 -> [route started done status error plugins copied pong] -> [prepend hostStarted] ...
            [prepend hostCopied], pong -> message hostPong -> js. node.script's dump outlet (right) ->
            [route terminated restarted] -> [prepend nodeLifecycle terminated|restarted] -> js.
            js outlet 1 -> node.script. js outlet 0 -> [prepend ui_status] -> jweb. js outlet 2 (busy, cancel, plugins,
            host, guide, setting) -> [prepend ui_state] -> jweb ONLY: never to a live.* object (greying them made a
            button fire by itself); busy and refusals are enforced in bridge.js.
"""
import json
import os
import struct
import subprocess
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
JS_PATH = os.path.join(HERE, "build", "bridge.js")
NODE_PATH = os.path.join(HERE, "src", "runner.js")
HTML_PATH = os.path.join(HERE, "ui", "ara2bridge_ui.html")
OUT = os.path.join(HERE, "ARABridge.amxd")

VERSION = "0.2"   # also shown in ui/ara2bridge_ui.html (test_amxd_container.py compares them)
DEVICE_W = 800
DEVICE_H = 169

# parameter_invisible: 1 = Stored Only (saved with the set, not automatable), 2 = Hidden (not stored).
STORED_ONLY = 1
HIDDEN = 2

PLACEMENT_ITEMS = ["Take lane", "New track", "Replace in place"]


class Patch(object):
    def __init__(self):
        self.boxes = []
        self.lines = []
        self.parameters = {}

    def add(self, box):
        self.boxes.append({"box": box})
        return box["id"]

    def connect(self, src, src_outlet, dst, dst_inlet=0):
        self.lines.append({"patchline": {"source": [src, src_outlet], "destination": [dst, dst_inlet]}})

    def newobj(self, id_, text, rect, numinlets=1, numoutlets=1, outlettype=None):
        return self.add({
            "id": id_, "maxclass": "newobj", "text": text, "patching_rect": rect,
            "numinlets": numinlets, "numoutlets": numoutlets,
            "outlettype": outlettype if outlettype is not None else [""] * numoutlets,
        })

    def message(self, id_, text, rect):
        return self.add({"id": id_, "maxclass": "message", "text": text, "patching_rect": rect,
                         "numinlets": 2, "numoutlets": 1, "outlettype": [""]})

    def jweb(self, id_, rect, presentation_rect):
        # Shape of the jweb boxes in Max 9's own help patch (maxclass jweb, ONE outlet: it carries the page's
        # max.outlet messages AND the load notifications onloadstart/onloadend/url/title).
        return self.add({
            "id": id_, "maxclass": "jweb", "disablefind": 0, "numinlets": 1, "numoutlets": 1, "outlettype": [""],
            "patching_rect": rect, "presentation": 1, "presentation_rect": presentation_rect,
        })

    def live_toggle(self, id_, longname, shortname, patch_xy, initial):
        # Not in presentation: the jweb page shows it. The object still owns the saved value (Stored Only).
        self.parameters[id_] = [longname, shortname, 0]
        return self.add({
            "annotation": longname, "id": id_, "maxclass": "live.toggle",
            "numinlets": 1, "numoutlets": 1, "outlettype": [""],
            "parameter_enable": 1, "patching_rect": [patch_xy[0], patch_xy[1], 24.0, 24.0],
            "presentation": 0, "rounded": 32.0,
            "saved_attribute_attributes": {"valueof": {
                "parameter_linknames": 1, "parameter_longname": longname, "parameter_shortname": shortname,
                "parameter_type": 2, "parameter_mmax": 1.0, "parameter_enum": ["off", "on"],
                "parameter_initial_enable": 1, "parameter_initial": [initial],
                "parameter_invisible": STORED_ONLY}},
            "varname": longname,
        })

    def live_menu(self, id_, longname, shortname, items, patch_xy, initial=0):
        # JSON shape of the factory live.menu objects (PitchCrusher, CamelPhat): enum parameter with its item list.
        self.parameters[id_] = [longname, shortname, 0]
        return self.add({
            "annotation": longname, "id": id_, "maxclass": "live.menu",
            "numinlets": 1, "numoutlets": 3, "outlettype": ["", "", ""],
            "parameter_enable": 1, "patching_rect": [patch_xy[0], patch_xy[1], 110.0, 18.0],
            "presentation": 0,
            "saved_attribute_attributes": {"valueof": {
                "parameter_linknames": 1, "parameter_longname": longname, "parameter_shortname": shortname,
                "parameter_type": 2, "parameter_mmax": float(len(items) - 1), "parameter_enum": list(items),
                "parameter_initial_enable": 1, "parameter_initial": [float(initial)],
                "parameter_invisible": STORED_ONLY}},
            "varname": longname,
        })


LOAD_FALLBACK_MS = 5000


def html_url():
    return "file://" + urllib.parse.quote(HTML_PATH)


ACTIONS = ["sendMelodyne", "setGuide", "sendVocAlign", "cancel", "refreshPlugins"]
# page -> max settings: <name> <live object id that owns the value>
SETTING_TARGETS = [("placement", "obj-menu-place"), ("skip", "obj-t-norealign"), ("preview", "obj-t-preview"),
                   ("sync", "obj-t-sync")]


def build_patch():
    p = Patch()

    # ---- audio passthrough
    p.newobj("obj-in", "plugin~", [20.0, 700.0, 60.0, 22.0], numinlets=2, numoutlets=2,
             outlettype=["signal", "signal"])
    p.newobj("obj-out", "plugout~", [20.0, 740.0, 60.0, 22.0], numinlets=2, numoutlets=0)
    p.connect("obj-in", 0, "obj-out", 0)
    p.connect("obj-in", 1, "obj-out", 1)

    # ---- the two scripts (absolute paths)
    p.newobj("obj-js", "js " + JS_PATH, [20.0, 300.0, 520.0, 22.0], numinlets=1, numoutlets=3,
             outlettype=["", "", ""])
    p.newobj("obj-node", "node.script " + NODE_PATH + " @autostart 1 @watch 0", [620.0, 300.0, 540.0, 22.0],
             numinlets=1, numoutlets=2, outlettype=["", ""])
    p.connect("obj-js", 1, "obj-node", 0)

    # ---- presentation: the page, and nothing else
    p.jweb("obj-web", [900.0, 40.0, float(DEVICE_W), float(DEVICE_H)], [0.0, 0.0, float(DEVICE_W), float(DEVICE_H)])

    # ---- saved state: not presented, the page mirrors it
    p.live_menu("obj-menu-place", "Placement", "Placement", PLACEMENT_ITEMS, [20.0, 80.0])
    p.live_toggle("obj-t-norealign", "Skip realign", "NoRealign", [160.0, 80.0], 0)
    # Live preview (Melodyne): after every edit in the host window the result is placed on a Preview track
    p.live_toggle("obj-t-preview", "Live preview", "Preview", [200.0, 80.0], 1)
    # Sync transport (Melodyne): the host window follows Live's Play/Stop/position and the other way round
    p.live_toggle("obj-t-sync", "Sync transport", "Sync", [240.0, 80.0], 1)

    # ---- startup: live.thisdevice -> deferlow -> [t b b b]; right to left: load the page, Placement menu bang,
    # then `ready` to js. NOT the toggles: a bang flips a live.toggle.
    p.newobj("obj-thisdev", "live.thisdevice", [20.0, 140.0, 100.0, 22.0], numinlets=1, numoutlets=3,
             outlettype=["bang", "int", "int"])
    p.newobj("obj-defer", "deferlow", [20.0, 170.0, 70.0, 22.0])
    p.newobj("obj-tstart", "t b b b", [20.0, 200.0, 70.0, 22.0], numinlets=1, numoutlets=3,
             outlettype=["bang", "bang", "bang"])
    p.message("obj-msg-ready", "ready", [20.0, 250.0, 50.0, 22.0])
    p.message("obj-msg-readfile", "readfile " + HTML_PATH, [160.0, 230.0, 560.0, 22.0])
    p.connect("obj-thisdev", 0, "obj-defer", 0)
    p.connect("obj-defer", 0, "obj-tstart", 0)
    p.connect("obj-tstart", 0, "obj-msg-ready", 0)
    p.connect("obj-msg-ready", 0, "obj-js", 0)
    p.connect("obj-tstart", 1, "obj-menu-place", 0)
    # Whether [jweb] resolves an absolute path in `readfile` could not be tried in Live: if the page has not said
    # ui_loaded after LOAD_FALLBACK_MS, load it once more with a file:// URL. ui_loaded stops the timer.
    p.newobj("obj-tload", "t b b", [160.0, 200.0, 50.0, 22.0], numinlets=1, numoutlets=2, outlettype=["bang", "bang"])
    p.newobj("obj-load-delay", "delay %d" % LOAD_FALLBACK_MS, [260.0, 200.0, 80.0, 22.0], numinlets=2,
             numoutlets=1, outlettype=["bang"])
    p.message("obj-msg-loadstop", "stop", [260.0, 140.0, 40.0, 22.0])
    p.message("obj-msg-url", "url " + html_url(), [360.0, 200.0, 560.0, 22.0])
    p.connect("obj-tstart", 2, "obj-tload", 0)
    p.connect("obj-tload", 1, "obj-msg-readfile", 0)
    p.connect("obj-tload", 0, "obj-load-delay", 0)
    p.connect("obj-msg-readfile", 0, "obj-web", 0)
    p.connect("obj-load-delay", 0, "obj-msg-url", 0)
    p.connect("obj-msg-url", 0, "obj-web", 0)
    p.connect("obj-msg-loadstop", 0, "obj-load-delay", 0)

    # ---- page -> max. jweb's outlet also says onloadstart/onloadend/url/title: only these three selectors pass.
    p.newobj("obj-route-ui", "route ui_action ui_set ui_loaded", [900.0, 240.0, 260.0, 22.0], numinlets=1,
             numoutlets=4, outlettype=["", "", "", ""])
    p.connect("obj-web", 0, "obj-route-ui", 0)

    # buttons: route -> message box -> js (a lone selector leaves [route] as a bang, which fires the message box)
    p.newobj("obj-route-act", "route " + " ".join(ACTIONS), [900.0, 290.0, 330.0, 22.0], numinlets=1,
             numoutlets=len(ACTIONS) + 1, outlettype=[""] * (len(ACTIONS) + 1))
    p.connect("obj-route-ui", 0, "obj-route-act", 0)
    for i, msg in enumerate(ACTIONS):
        x = 900.0 + 100.0 * i
        mid = p.message("obj-act-" + msg + "-msg", msg, [x, 330.0, 96.0, 22.0])
        p.connect("obj-route-act", i, mid, 0)
        p.connect(mid, 0, "obj-js", 0)

    # settings: route -> the live object that owns the value (an int into it sets and outputs it)
    p.newobj("obj-route-set", "route " + " ".join(n for n, _ in SETTING_TARGETS), [900.0, 380.0, 260.0, 22.0],
             numinlets=1, numoutlets=len(SETTING_TARGETS) + 1, outlettype=[""] * (len(SETTING_TARGETS) + 1))
    p.connect("obj-route-ui", 1, "obj-route-set", 0)
    for i, (_, target) in enumerate(SETTING_TARGETS):
        p.connect("obj-route-set", i, target, 0)

    # the page is up: ask js for everything it said before
    p.message("obj-msg-uirefresh", "uiRefresh", [1180.0, 380.0, 70.0, 22.0])
    p.connect("obj-route-ui", 2, "obj-msg-uirefresh", 0)
    p.connect("obj-route-ui", 2, "obj-msg-loadstop", 0)
    p.connect("obj-msg-uirefresh", 0, "obj-js", 0)

    # ---- settings -> js
    p.newobj("obj-pre-place", "prepend settings placement", [20.0, 400.0, 170.0, 22.0])
    p.connect("obj-menu-place", 0, "obj-pre-place", 0)
    p.connect("obj-pre-place", 0, "obj-js", 0)
    # The toggle is inverted ("Skip realign", default 0 = off) so realign is ON by default whatever Live restores
    # for parameter_initial: js gets realign = 1 - toggle.
    p.newobj("obj-inv-realign", "expr 1-$i1", [200.0, 360.0, 90.0, 22.0], numinlets=1, numoutlets=1)
    p.newobj("obj-pre-realign", "prepend settings realign", [200.0, 400.0, 160.0, 22.0])
    p.connect("obj-t-norealign", 0, "obj-inv-realign", 0)
    p.connect("obj-inv-realign", 0, "obj-pre-realign", 0)
    p.connect("obj-pre-realign", 0, "obj-js", 0)

    # Live preview toggle (default 1 = on for a new device; a saved set keeps its own value): js gets preview = toggle
    p.newobj("obj-pre-preview", "prepend settings preview", [380.0, 400.0, 160.0, 22.0])
    p.connect("obj-t-preview", 0, "obj-pre-preview", 0)
    p.connect("obj-pre-preview", 0, "obj-js", 0)

    # Sync transport toggle (default 1 = on for a new device): js gets sync = toggle
    p.newobj("obj-pre-sync", "prepend settings sync", [560.0, 400.0, 160.0, 22.0])
    p.connect("obj-t-sync", 0, "obj-pre-sync", 0)
    p.connect("obj-pre-sync", 0, "obj-js", 0)

    # ---- the same values on their way to the page: ui_state setting <name> <value> (skip = the raw toggle value)
    for name, src, x in (("placement", "obj-menu-place", 20.0), ("skip", "obj-t-norealign", 200.0),
                         ("preview", "obj-t-preview", 380.0), ("sync", "obj-t-sync", 560.0)):
        tap = p.newobj("obj-tap-" + name, "prepend ui_state setting " + name, [x, 450.0, 190.0, 22.0])
        p.connect(src, 0, tap, 0)
        p.connect(tap, 0, "obj-web", 0)

    # ---- node.script outlet 0 -> route -> prepend host* -> js
    selectors = ["started", "done", "status", "error", "plugins", "copied", "pong"]
    p.newobj("obj-route-node", "route " + " ".join(selectors), [620.0, 440.0, 340.0, 22.0],
             numinlets=1, numoutlets=len(selectors) + 1, outlettype=[""] * (len(selectors) + 1))
    p.connect("obj-node", 0, "obj-route-node", 0)
    for i, sel in enumerate(selectors):
        x = 620.0 + 110.0 * i
        if sel == "pong":
            pid = p.message("obj-host-pong", "hostPong", [x, 500.0, 70.0, 22.0])
        else:
            pid = p.newobj("obj-pre-host-" + sel, "prepend host" + sel[0].upper() + sel[1:],
                           [x, 500.0, 100.0, 22.0])
        p.connect("obj-route-node", i, pid, 0)
        p.connect(pid, 0, "obj-js", 0)

    # ---- node.script lifecycle (dump) outlet -> route -> prepend nodeLifecycle <event> -> js
    p.newobj("obj-route-life", "route terminated restarted", [1200.0, 300.0, 170.0, 22.0],
             numinlets=1, numoutlets=3, outlettype=["", "", ""])
    p.connect("obj-node", 1, "obj-route-life", 0)
    for i, ev in enumerate(["terminated", "restarted"]):
        pid = p.newobj("obj-pre-life-" + ev, "prepend nodeLifecycle " + ev, [1200.0 + 150.0 * i, 340.0, 150.0, 22.0])
        p.connect("obj-route-life", i, pid, 0)
        p.connect(pid, 0, "obj-js", 0)

    # ---- js -> page: outlet 0 status text, outlet 2 UI state (busy cancel plugins host guide setting). The UI state
    # goes to the jweb ONLY, never to a live.* object.
    p.newobj("obj-pre-ui-status", "prepend ui_status", [20.0, 560.0, 110.0, 22.0])
    p.connect("obj-js", 0, "obj-pre-ui-status", 0)
    p.connect("obj-pre-ui-status", 0, "obj-web", 0)
    p.newobj("obj-pre-ui-state", "prepend ui_state", [160.0, 560.0, 110.0, 22.0])
    p.connect("obj-js", 2, "obj-pre-ui-state", 0)
    p.connect("obj-pre-ui-state", 0, "obj-web", 0)
    return p


def patcher_dict(p):
    return {"patcher": {
        "fileversion": 1,
        "appversion": {"major": 9, "minor": 0, "revision": 7, "architecture": "arm64", "modernui": 1},
        "classnamespace": "box",
        "rect": [50.0, 80.0, 1420.0, 800.0],
        "openrect": [0.0, 0.0, float(DEVICE_W), float(DEVICE_H)],
        "openinpresentation": 1,
        "default_fontsize": 10.0, "default_fontface": 0, "default_fontname": "Arial",
        "gridonopen": 1, "gridsize": [8.0, 8.0], "statusbarvisible": 0, "toolbarvisible": 1,
        "devicewidth": float(DEVICE_W),
        "description": "ARA2 Bridge 4 Live: sends the selected Arrangement clip to Melodyne or VocAlign and puts the result back.",
        "digest": "", "tags": "", "style": "",
        "boxes": p.boxes,
        "lines": p.lines,
        "parameters": p.parameters,
        "dependency_cache": [],
        "latency": 0,
    }}


def container(patcher_obj):
    payload = json.dumps(patcher_obj, indent=1).encode("utf-8") + b"\x00"
    return (b"ampf" + struct.pack("<I", 4) + b"aaaa"
            + b"meta" + struct.pack("<I", 4) + struct.pack("<I", 0)
            + b"ptch" + struct.pack("<I", len(payload)) + payload)


def run_build():
    build = os.path.join(HERE, "build.py")
    r = subprocess.run([sys.executable, build], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        sys.stderr.write(r.stdout.decode("utf-8", "replace"))
        sys.exit("device/build.py failed")


def main():
    global JS_PATH, NODE_PATH, HTML_PATH
    args = sys.argv[1:]
    install_root = None
    if args and args[0] == "--install-root":
        # distribution build: the scripts are expected at <root>/bridge.js, <root>/runner.js and <root>/ara2bridge_ui.html (see tools/make_package.sh);
        # they need not exist here, so an output file is required
        if len(args) != 3 or not args[1].startswith("/"):
            sys.exit("usage: make_amxd.py --install-root /absolute/folder out.amxd")
        install_root = args[1].rstrip("/")
        JS_PATH = install_root + "/bridge.js"
        NODE_PATH = install_root + "/runner.js"
        HTML_PATH = install_root + "/ara2bridge_ui.html"
        args = args[2:]
    for pth in (JS_PATH, NODE_PATH, HTML_PATH):
        if " " in pth:
            sys.exit("path contains a space (would split the object box arguments): " + pth)
    run_build()
    if install_root is None:
        for pth in (JS_PATH, NODE_PATH, HTML_PATH):
            if not os.path.isfile(pth):
                sys.exit("missing script: " + pth)
    data = container(patcher_dict(build_patch()))
    out = args[0] if args else OUT
    with open(out, "wb") as f:
        f.write(data)
    print("wrote %s (%d bytes)" % (out, len(data)))


if __name__ == "__main__":
    main()
