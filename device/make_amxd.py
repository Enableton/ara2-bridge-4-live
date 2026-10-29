#!/usr/bin/env python3
"""Build device/ARABridge.amxd (Max for Live Audio Effect, audio passes through unchanged).

    python3 device/make_amxd.py [out.amxd]      # default: device/ARABridge.amxd
    python3 device/make_amxd.py --install-root /Users/Shared/ARABridge/device out.amxd   # for a package (tools/make_package.sh)
    python3 device/make_amxd.py --single --host /path/to/BridgeHost [out.amxd]           # ONE file, nothing else to install
                                                                                          # (default device/ARABridge-single.amxd)

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
import hashlib
import io
import json
import os
import struct
import subprocess
import sys
import urllib.parse
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
JS_PATH = os.path.join(HERE, "build", "bridge.js")
NODE_PATH = os.path.join(HERE, "src", "runner.js")
HTML_PATH = os.path.join(HERE, "ui", "ara2bridge_ui.html")
HTML_SRC = HTML_PATH
OUT = os.path.join(HERE, "ARABridge.amxd")

VERSION = "0.3.0"   # also shown in ui/ara2bridge_ui.html (test_amxd_container.py compares them)
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


ACTIONS = ["sendMelodyne", "setGuide", "sendVocAlign", "cancel", "refreshPlugins", "installHost"]
# page -> max settings: <name> <live object id that owns the value>
SETTING_TARGETS = [("placement", "obj-menu-place"), ("skip", "obj-t-norealign"), ("preview", "obj-t-preview"),
                   ("sync", "obj-t-sync")]


def build_patch(single=False):
    p = Patch()

    # ---- audio passthrough
    p.newobj("obj-in", "plugin~", [20.0, 700.0, 60.0, 22.0], numinlets=2, numoutlets=2,
             outlettype=["signal", "signal"])
    p.newobj("obj-out", "plugout~", [20.0, 740.0, 60.0, 22.0], numinlets=2, numoutlets=0)
    p.connect("obj-in", 0, "obj-out", 0)
    p.connect("obj-in", 1, "obj-out", 1)

    # ---- the two scripts (absolute paths)
    # single-file device: plain file names, found through the project search path of the unpacked device
    p.newobj("obj-js", "js " + ("bridge.js" if single else JS_PATH), [20.0, 300.0, 520.0, 22.0], numinlets=1,
             numoutlets=3, outlettype=["", "", ""])
    p.newobj("obj-node", "node.script " + ("runner.js" if single else NODE_PATH) + " @autostart 1 @watch 0",
             [620.0, 300.0, 540.0, 22.0],
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
    p.message("obj-msg-readfile", "readfile " + ("ara2bridge_ui.html" if single else HTML_PATH),
              [160.0, 230.0, 560.0, 22.0])
    p.connect("obj-thisdev", 0, "obj-defer", 0)
    p.connect("obj-defer", 0, "obj-tstart", 0)
    p.connect("obj-tstart", 0, "obj-msg-ready", 0)
    p.connect("obj-msg-ready", 0, "obj-js", 0)
    p.connect("obj-tstart", 1, "obj-menu-place", 0)
    if single:
        # CL1B-style: the page is found by its file name in the unpacked device folder (confirmed in Live)
        p.connect("obj-tstart", 2, "obj-msg-readfile", 0)
        p.connect("obj-msg-readfile", 0, "obj-web", 0)
    else:
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
    if not single:
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
    selectors = ["started", "done", "status", "error", "plugins", "copied", "hostinfo", "pong"]
    p.newobj("obj-route-node", "route " + " ".join(selectors), [620.0, 440.0, 340.0, 22.0],
             numinlets=1, numoutlets=len(selectors) + 1, outlettype=[""] * (len(selectors) + 1))
    p.connect("obj-node", 0, "obj-route-node", 0)
    for i, sel in enumerate(selectors):
        x = 620.0 + 110.0 * i
        if sel == "pong":
            pid = p.message("obj-host-pong", "hostPong", [x, 500.0, 70.0, 22.0])
        else:
            msg = "hostInfo" if sel == "hostinfo" else "host" + sel[0].upper() + sel[1:]
            pid = p.newobj("obj-pre-host-" + sel, "prepend " + msg, [x, 500.0, 100.0, 22.0])
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


def patcher_dict(p, single=False):
    d = {"patcher": {
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
    if single:
        d["patcher"]["project"] = FROZEN_PROJECT
        d["patcher"]["autosave"] = 0
    return d


# `project` block of a frozen device (as Max writes it): the folder web_assets is on the search path of the unpacked device
FROZEN_PROJECT = {
    "version": 1, "creationdate": 3970000000, "modificationdate": 3970000000, "viewrect": [0.0, 0.0, 300.0, 500.0],
    "autoorganize": 0, "hideprojectwindow": 0, "showdependencies": 1, "autolocalize": 0,
    "contents": {"patchers": {}}, "layout": {},
    "searchpath": {"0": {"bootpath": "./web_assets", "projectrelativepath": "./web_assets", "label": "Device files",
                         "recursive": 0, "enabled": 0, "includeincollective": 1}},
    "detailsvisible": 0, "amxdtype": 1633771873, "readonly": 0, "devpathtype": 0, "devpath": ".", "sortmode": 0,
    "viewmode": 0,
}


def container(patcher_obj):
    payload = json.dumps(patcher_obj, indent=1).encode("utf-8") + b"\x00"
    return (b"ampf" + struct.pack("<I", 4) + b"aaaa"
            + b"meta" + struct.pack("<I", 4) + struct.pack("<I", 0)
            + b"ptch" + struct.pack("<I", len(payload)) + payload)


def _tag(tag, val):
    return tag + struct.pack(">I", 8 + len(val)) + val


def _dire(typ, fnam, size, offset, flag, mdat):
    # fnam is NUL-terminated and padded to a multiple of 4: ALWAYS at least one NUL (also when the length is a multiple
    # of 4). Without it Max logs "unfreeze complete" but writes nothing.
    name = fnam.encode("utf-8")
    name += b"\0" * (4 - len(name) % 4)
    body = (_tag(b"type", typ) + _tag(b"fnam", name) + _tag(b"sz32", struct.pack(">I", size))
            + _tag(b"of32", struct.pack(">I", offset)) + _tag(b"vers", struct.pack(">I", 0))
            + _tag(b"flag", struct.pack(">I", flag)) + _tag(b"mdat", struct.pack(">I", mdat)))
    return b"dire" + struct.pack(">I", 8 + len(body)) + body


def device_files(host_path):
    """[(path inside web_assets, bytes, unix mode)] of the single-file device, sorted, deterministic."""
    root = os.path.dirname(HERE)
    files = [
        ("bridge.js", os.path.join(HERE, "build", "bridge.js"), 0o644),
        ("runner.js", os.path.join(HERE, "src", "runner.js"), 0o644),
        ("ara2bridge_ui.html", HTML_SRC, 0o644),
        ("BridgeHost", host_path, 0o755),
        ("LICENSE", os.path.join(root, "LICENSE"), 0o644),
        ("THIRD_PARTY_NOTICES.md", os.path.join(root, "THIRD_PARTY_NOTICES.md"), 0o644),
    ]
    lic = os.path.join(root, "docs", "licenses")
    for n in sorted(os.listdir(lic)):
        files.append(("licenses/" + n, os.path.join(lic, n), 0o644))
    out = []
    for name, path, mode in files:
        if not os.path.isfile(path):
            sys.exit("missing file for the single-file device: " + path)
        with open(path, "rb") as f:
            out.append((name, f.read(), mode))
    host = dict((n, b) for n, b, _ in out)["BridgeHost"]
    commit = "unknown"
    try:
        commit = subprocess.run(["git", "-C", root, "rev-parse", "HEAD"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                check=True).stdout.decode().strip()
    except Exception:
        pass
    src = ("ARA2 Bridge 4 Live %s: this device contains BridgeHost, built from the source code of this project.\n"
           "Source (GNU GPL v3 or later): https://github.com/Enableton/ara2-bridge-4-live  commit %s\n"
           "BridgeHost sha256: %s\n"
           "License texts of the components: LICENSE, THIRD_PARTY_NOTICES.md, licenses/\n"
           % (VERSION, commit, hashlib.sha256(host).hexdigest()))
    out.append(("SOURCE.txt", src.encode("utf-8"), 0o644))
    return sorted(out, key=lambda t: t[0])


def frozen_container(patcher_obj, files):
    """A device Max unpacks like a frozen one: patcher JSON + one zip folder `web_assets` (searched at load).
    Layout as in devices frozen by Max (see the Max for Live notes): header, `mx@c` block, JSON, zip, `dlst`; all
    offsets are relative to byte 20."""
    payload = json.dumps(patcher_obj, indent=1).encode("utf-8") + b"\n\x00"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        def add(name, data, mode, is_dir=False):
            zi = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            zi.create_system = 3                      # Unix modes are kept by Max's unzip (the host must stay executable)
            zi.external_attr = (mode << 16) | (0x10 if is_dir else 0)
            z.writestr(zi, data, zipfile.ZIP_STORED if is_dir else zipfile.ZIP_DEFLATED)
        add("web_assets/", b"", 0o40755, True)
        add("web_assets/licenses/", b"", 0o40755, True)
        for name, data, mode in files:
            add("web_assets/" + name, data, 0o100000 | mode)
    zipb = buf.getvalue()
    off_json = 16
    off_zip = off_json + len(payload)
    entries = (_dire(b"JSON", "ARABridge.maxpat", len(payload), off_json, 17, 3875248722)
               + _dire(b"fold", "web_assets/zipfolder", len(zipb), off_zip, 0, 0))
    dlst = b"dlst" + struct.pack(">I", 8 + len(entries)) + entries
    body = (b"mx@c" + struct.pack(">I", 16) + struct.pack(">I", 0) + struct.pack(">I", off_zip + len(zipb))
            + payload + zipb + dlst)
    return b"ampf" + struct.pack("<I", 4) + b"aaaa" + b"ptch" + struct.pack("<I", len(body)) + body


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
    single_host = None
    if args and args[0] == "--single":
        # ONE file: scripts, page, licences and BridgeHost are frozen into the .amxd (Max unpacks them on load)
        if len(args) < 3 or args[1] != "--host":
            sys.exit("usage: make_amxd.py --single --host /path/to/BridgeHost [out.amxd]")
        single_host = os.path.abspath(args[2])
        args = args[3:]
        if not os.path.isfile(single_host) or not os.access(single_host, os.X_OK):
            sys.exit("not an executable file: " + single_host)
    elif args and args[0] == "--install-root":
        # distribution build: the scripts are expected at <root>/bridge.js, <root>/runner.js and <root>/ara2bridge_ui.html (see tools/make_package.sh);
        # they need not exist here, so an output file is required
        if len(args) != 3 or not args[1].startswith("/"):
            sys.exit("usage: make_amxd.py --install-root /absolute/folder out.amxd")
        install_root = args[1].rstrip("/")
        JS_PATH = install_root + "/bridge.js"
        NODE_PATH = install_root + "/runner.js"
        HTML_PATH = install_root + "/ara2bridge_ui.html"
        args = args[2:]
    if single_host is None:
        for pth in (JS_PATH, NODE_PATH, HTML_PATH):
            if " " in pth:
                sys.exit("path contains a space (would split the object box arguments): " + pth)
    run_build()
    if single_host is not None:
        data = frozen_container(patcher_dict(build_patch(single=True), single=True), device_files(single_host))
        out = args[0] if args else os.path.join(HERE, "ARABridge-single.amxd")
    else:
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
