#!/usr/bin/env python3
"""Build device/ARABridge.amxd (Max for Live Audio Effect, audio passes through unchanged).

    python3 device/make_amxd.py [out.amxd]      # default: device/ARABridge.amxd
    python3 device/make_amxd.py --install-root /Users/Shared/ARABridge/device out.amxd   # for a package (tools/make_package.sh)

Runs device/build.py first (device/build/bridge.js = src/core.js + src/bridge.js), then writes the container.
The js and node.script objects refer to the scripts by ABSOLUTE path, resolved from this file's location:
    js           <repo>/device/build/bridge.js
    node.script  <repo>/device/src/runner.js  @autostart 1 @watch 0
so the repo must not move after building (rebuild with this script if it does). Paths with spaces are refused (they
would split the object box arguments).

Container (same as the probe device that loaded in this user's Live):
    b"ampf" + u32le(4) + b"aaaa"           device type: audio effect
    b"meta" + u32le(4) + u32le(0)
    b"ptch" + u32le(N) + payload           payload = patcher JSON + b"\\x00", N = len(payload)

The output is deterministic: no timestamps, fixed ids, fixed ordering (two builds are byte-identical).

Signal flow (all message flow is plain Max objects; names are the box ids):
  startup   live.thisdevice -> deferlow -> [t b b] fires right to left: bang the Placement menu (a live.menu re-outputs
            its restored value on bang), then the `ready` message to js. The Skip-realign toggle is NOT banged (a bang
            FLIPS a live.toggle); js defaults to realign on and Live outputs the restored toggle value itself.
            bridge.js does the --find-plugins check by itself on `ready`.
  buttons   live.text (button mode) -> [route bang 1] (bang or 1 pass, 0 is dropped: one message per click whichever
            form Live emits) -> [t b] -> message box -> js: sendMelodyne | setGuide | sendVocAlign | cancel |
            refreshPlugins.
  settings  Placement menu index -> [prepend settings placement] -> js; Skip-realign toggle -> [expr 1-$i1] ->
            [prepend settings realign] -> js.
  node      node.script outlet 0 -> [route started done status error plugins copied pong] -> [prepend hostStarted] ...
            [prepend hostCopied], pong -> message hostPong -> js. node.script's dump outlet (right) ->
            [route terminated restarted] -> [prepend nodeLifecycle terminated|restarted] -> js.
            js outlet 1 -> node.script. js outlet 0 -> [prepend set] -> status comment.
  No UI state is ever sent to a live.* object after load (no `active`, no greying): js outlet 2 (busy/cancel/...)
  is left unconnected; busy and refusals show in the status text and are enforced in bridge.js.
"""
import json
import os
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
JS_PATH = os.path.join(HERE, "build", "bridge.js")
NODE_PATH = os.path.join(HERE, "src", "runner.js")
OUT = os.path.join(HERE, "ARABridge.amxd")

VERSION = "0.1"
DEVICE_W = 330
DEVICE_H = 169
LABEL_BG = [0.13, 0.13, 0.13, 1.0]
LABEL_FG = [0.95, 0.95, 0.95, 1.0]

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

    def comment(self, id_, text, prect, patch_xy, fontsize=9.0, bold=False, linecount=1):
        return self.add({
            "id": id_, "maxclass": "comment", "text": text,
            "fontname": "Arial Bold" if bold else "Arial", "fontsize": fontsize,
            "numinlets": 1, "numoutlets": 0, "linecount": linecount,
            "bgcolor": LABEL_BG, "textcolor": LABEL_FG,
            "patching_rect": [patch_xy[0], patch_xy[1], prect[2], prect[3]],
            "presentation": 1, "presentation_rect": prect,
        })

    def live_text_button(self, id_, longname, shortname, label, prect, patch_xy):
        # Copied from the probe (itself copied from the factory "Synced Player" ResetLength button): mode 0 = button,
        # parameter hidden. It outputs a *bang* on its left outlet, so each button feeds [t b].
        self.parameters[id_] = [longname, shortname, 0]
        return self.add({
            "annotation": label, "automation": "off", "automationon": "on", "fontsize": 10.0,
            "id": id_, "maxclass": "live.text", "mode": 0,
            "numinlets": 1, "numoutlets": 2, "outlettype": ["", ""],
            "parameter_enable": 1, "patching_rect": [patch_xy[0], patch_xy[1], prect[2], prect[3]],
            "presentation": 1, "presentation_rect": prect,
            "saved_attribute_attributes": {"valueof": {
                "parameter_linknames": 1, "parameter_longname": longname, "parameter_shortname": shortname,
                "parameter_type": 2, "parameter_mmax": 1.0, "parameter_enum": ["off", "on"],
                "parameter_invisible": HIDDEN}},
            "text": label, "texton": label, "varname": longname,
        })

    def live_toggle(self, id_, longname, shortname, prect, patch_xy, initial):
        self.parameters[id_] = [longname, shortname, 0]
        return self.add({
            "annotation": longname, "id": id_, "maxclass": "live.toggle",
            "numinlets": 1, "numoutlets": 1, "outlettype": [""],
            "parameter_enable": 1, "patching_rect": [patch_xy[0], patch_xy[1], prect[2], prect[3]],
            "presentation": 1, "presentation_rect": prect, "rounded": 32.0,
            "saved_attribute_attributes": {"valueof": {
                "parameter_linknames": 1, "parameter_longname": longname, "parameter_shortname": shortname,
                "parameter_type": 2, "parameter_mmax": 1.0, "parameter_enum": ["off", "on"],
                "parameter_initial_enable": 1, "parameter_initial": [initial],
                "parameter_invisible": STORED_ONLY}},
            "varname": longname,
        })

    def live_menu(self, id_, longname, shortname, items, prect, patch_xy, initial=0):
        # JSON shape of the factory live.menu objects (PitchCrusher, CamelPhat): enum parameter with its item list.
        self.parameters[id_] = [longname, shortname, 0]
        return self.add({
            "annotation": longname, "id": id_, "maxclass": "live.menu",
            "numinlets": 1, "numoutlets": 3, "outlettype": ["", "", ""],
            "parameter_enable": 1, "patching_rect": [patch_xy[0], patch_xy[1], prect[2], prect[3]],
            "presentation": 1, "presentation_rect": prect,
            "saved_attribute_attributes": {"valueof": {
                "parameter_linknames": 1, "parameter_longname": longname, "parameter_shortname": shortname,
                "parameter_type": 2, "parameter_mmax": float(len(items) - 1), "parameter_enum": list(items),
                "parameter_initial_enable": 1, "parameter_initial": [float(initial)],
                "parameter_invisible": STORED_ONLY}},
            "varname": longname,
        })


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

    # ---- presentation: title, placement menu
    p.comment("obj-title", "ARA2 Bridge 4 Live  v" + VERSION, [4.0, 2.0, 322.0, 14.0], [20.0, 20.0], fontsize=11.0, bold=True)
    p.comment("obj-lplace", "Placement", [4.0, 18.0, 56.0, 16.0], [20.0, 50.0])
    p.live_menu("obj-menu-place", "Placement", "Placement", PLACEMENT_ITEMS, [62.0, 18.0, 264.0, 16.0],
                [80.0, 50.0])

    # ---- presentation: action buttons
    p.live_text_button("obj-b-mel", "Send to Melodyne", "Melodyne", "Send to Melodyne",
                       [4.0, 37.0, 322.0, 20.0], [20.0, 90.0])
    p.live_text_button("obj-b-guide", "Set guide", "Guide", "Set guide (VocAlign)", [4.0, 59.0, 159.0, 20.0],
                       [180.0, 90.0])
    p.live_text_button("obj-b-voc", "Send to VocAlign", "VocAlign", "Send to VocAlign",
                       [167.0, 59.0, 159.0, 20.0], [340.0, 90.0])
    p.live_text_button("obj-b-cancel", "Cancel", "Cancel", "Cancel", [4.0, 100.0, 159.0, 18.0], [500.0, 90.0])
    p.live_text_button("obj-b-refresh", "Refresh plug-ins", "Refresh", "Refresh plug-ins",
                       [167.0, 100.0, 159.0, 18.0], [660.0, 90.0])

    # ---- presentation: skip-realign toggle, status
    p.live_toggle("obj-t-norealign", "Skip realign", "NoRealign", [4.0, 83.0, 14.0, 14.0], [20.0, 130.0], 0)
    p.comment("obj-lnorealign", "Skip timing correction (Melodyne)", [22.0, 81.0, 200.0, 16.0], [60.0, 130.0])
    p.comment("obj-status", "Starting...", [4.0, 121.0, 322.0, 46.0], [20.0, 170.0], linecount=4)

    # ---- startup: live.thisdevice -> deferlow -> [t b b]; right to left: Placement menu bang, then `ready` to js.
    # NOT the toggle: a bang flips a live.toggle.
    p.newobj("obj-thisdev", "live.thisdevice", [20.0, 200.0, 100.0, 22.0], numinlets=1, numoutlets=3,
             outlettype=["bang", "int", "int"])
    p.newobj("obj-defer", "deferlow", [20.0, 230.0, 70.0, 22.0])
    p.newobj("obj-tstart", "t b b", [20.0, 260.0, 60.0, 22.0], numinlets=1, numoutlets=2, outlettype=["bang", "bang"])
    p.message("obj-msg-ready", "ready", [20.0, 280.0, 50.0, 22.0])
    p.connect("obj-thisdev", 0, "obj-defer", 0)
    p.connect("obj-defer", 0, "obj-tstart", 0)
    p.connect("obj-tstart", 0, "obj-msg-ready", 0)
    p.connect("obj-msg-ready", 0, "obj-js", 0)
    p.connect("obj-tstart", 1, "obj-menu-place", 0)

    # ---- buttons -> [route bang 1] -> [t b] -> message box -> js
    # A live.text button may emit a lone bang, a lone 1, or 1 on press and 0 on release depending on the Live/Max
    # version; [sel 1] drops a bang (dead button), [t b] alone would fire twice on 1/0. [route bang 1] passes a bang
    # and a 1 (as a bang) and sends the 0 to its unused third outlet: exactly one message per click.
    buttons = [
        ("obj-b-mel", "sendMelodyne", 20.0), ("obj-b-guide", "setGuide", 180.0),
        ("obj-b-voc", "sendVocAlign", 340.0), ("obj-b-cancel", "cancel", 500.0),
        ("obj-b-refresh", "refreshPlugins", 660.0),
    ]
    for bid, msg, x in buttons:
        rt = p.newobj(bid + "-gate", "route bang 1", [x, 320.0, 80.0, 22.0], numinlets=1, numoutlets=3,
                      outlettype=["", "", ""])
        trig = p.newobj(bid + "-trig", "t b", [x, 350.0, 30.0, 22.0], numinlets=1, numoutlets=1,
                        outlettype=["bang"])
        m = p.message(bid + "-msg", msg, [x, 380.0, 110.0, 22.0])
        p.connect(bid, 0, rt, 0)
        p.connect(rt, 0, trig, 0)
        p.connect(rt, 1, trig, 0)
        p.connect(trig, 0, m, 0)
        p.connect(m, 0, "obj-js", 0)

    # ---- settings -> js
    p.newobj("obj-pre-place", "prepend settings placement", [260.0, 420.0, 170.0, 22.0])
    p.connect("obj-menu-place", 0, "obj-pre-place", 0)
    p.connect("obj-pre-place", 0, "obj-js", 0)
    # The toggle is inverted ("Skip realign", default 0 = off) so realign is ON by default whatever Live restores
    # for parameter_initial: js gets realign = 1 - toggle.
    p.newobj("obj-inv-realign", "expr 1-$i1", [440.0, 390.0, 90.0, 22.0], numinlets=1, numoutlets=1)
    p.newobj("obj-pre-realign", "prepend settings realign", [440.0, 420.0, 160.0, 22.0])
    p.connect("obj-t-norealign", 0, "obj-inv-realign", 0)
    p.connect("obj-inv-realign", 0, "obj-pre-realign", 0)
    p.connect("obj-pre-realign", 0, "obj-js", 0)

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

    # ---- js outlet 0 -> [prepend set] -> status comment (js outlet 2, the UI state, is deliberately unconnected)
    p.newobj("obj-pre-set", "prepend set", [20.0, 440.0, 80.0, 22.0])
    p.connect("obj-js", 0, "obj-pre-set", 0)
    p.connect("obj-pre-set", 0, "obj-status", 0)
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
    global JS_PATH, NODE_PATH
    args = sys.argv[1:]
    install_root = None
    if args and args[0] == "--install-root":
        # distribution build: the scripts are expected at <root>/bridge.js and <root>/runner.js (see tools/make_package.sh);
        # they need not exist here, so an output file is required
        if len(args) != 3 or not args[1].startswith("/"):
            sys.exit("usage: make_amxd.py --install-root /absolute/folder out.amxd")
        install_root = args[1].rstrip("/")
        JS_PATH = install_root + "/bridge.js"
        NODE_PATH = install_root + "/runner.js"
        args = args[2:]
    for pth in (JS_PATH, NODE_PATH):
        if " " in pth:
            sys.exit("path contains a space (would split the object box arguments): " + pth)
    run_build()
    if install_root is None:
        for pth in (JS_PATH, NODE_PATH):
            if not os.path.isfile(pth):
                sys.exit("missing script: " + pth)
    data = container(patcher_dict(build_patch()))
    out = args[0] if args else OUT
    with open(out, "wb") as f:
        f.write(data)
    print("wrote %s (%d bytes)" % (out, len(data)))


if __name__ == "__main__":
    main()
