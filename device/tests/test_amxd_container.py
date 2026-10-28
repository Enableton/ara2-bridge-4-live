#!/usr/bin/env python3
"""Independent check of device/ARABridge.amxd: parses the raw bytes (does not import make_amxd.py).

Checks, without Live or Max:
  - container layout (header bytes, payload length, trailing NUL), JSON validity;
  - boxes: unique ids, strict port declarations (numinlets/numoutlets/outlettype on EVERY box, counts consistent with
    the object text and with the scripts: js `outlets = 3` in src/bridge.js), every patchline endpoint exists;
  - parameters: unique long names, stored/hidden visibility, menu enums, initial values;
  - presentation: every UI object is in presentation mode and inside the device rectangle;
  - message flow: a small simulator walks the patch (message boxes, [t], [prepend], [route], [deferlow], [pak],
    [unpack], [expr]) and checks what reaches the js object and node.script for every button, setting, startup,
    node.script outlet message and js outlet message;
  - nothing reaches js except messages js has a handler for (handler names are read from src/bridge.js);
  - the build is deterministic and the committed .amxd is not stale (byte-identical to a fresh build).

Run: python3 -I device/tests/test_amxd_container.py      (plain unittest, no pytest)
"""
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
DEVICE = os.path.dirname(HERE)
AMXD = os.path.join(DEVICE, "ARABridge.amxd")
MAKE = os.path.join(DEVICE, "make_amxd.py")
BRIDGE_SRC = os.path.join(DEVICE, "src", "bridge.js")
EXPECTED_JS = os.path.join(DEVICE, "build", "bridge.js")
EXPECTED_NODE = os.path.join(DEVICE, "src", "runner.js")
PROBE_AMXD = os.path.join(DEVICE, "probe", "ARABridgeProbe.amxd")
EXPECTED_HEADER_HEX = "616d706604000000616161616d6574610400000000000000" + "70746368"
PAYLOAD_SELECTORS = ["started", "done", "status", "error", "plugins", "copied"]


def parse(data):
    assert len(data) >= 32, "file too short"
    if data[0:4] != b"ampf":
        raise ValueError("no ampf magic")
    ptch = data.find(b"ptch")
    n = struct.unpack("<I", data[ptch + 4:ptch + 8])[0]
    return {"ptch_offset": ptch, "length": n, "payload": data[ptch + 8:ptch + 8 + n], "rest": data[ptch + 8 + n:]}


def handler_names():
    """Top-level function names of bridge.js = the messages js accepts (inlet 0)."""
    with open(BRIDGE_SRC, "r", encoding="utf-8") as f:
        src = f.read()
    names = set(re.findall(r"^function (\w+)\(", src, re.M))
    return names - {"anything", "bang"}   # catch-alls: unknown messages there only show an error on the status line


def js_outlet_count():
    with open(BRIDGE_SRC, "r", encoding="utf-8") as f:
        return int(re.search(r"^outlets = (\d+);", f.read(), re.M).group(1))


def atoms(text):
    out = []
    for t in text.split():
        try:
            out.append(int(t))
        except ValueError:
            out.append(t)
    return tuple(out)


class Sim(object):
    """Tiny Max message-flow simulator for exactly the objects this patch uses."""

    def __init__(self, patcher):
        p = patcher["patcher"]
        self.boxes = {b["box"]["id"]: b["box"] for b in p["boxes"]}
        self.out_edges = {}
        for ln in p["lines"]:
            pl = ln["patchline"]
            self.out_edges.setdefault(tuple(pl["source"]), []).append(tuple(pl["destination"]))
        self.js_in = []          # messages received by the js object
        self.node_in = []        # messages received by node.script
        self.live_in = []        # every message a live.* object received: (id, msg)
        self.comments = {}       # last `set` text per comment id
        self.pak = {}            # pak state per id
        self.expr = {}           # expr inlet values per id
        self.value = {}          # current value of live.menu / live.toggle
        for bid, b in self.boxes.items():
            v = b.get("saved_attribute_attributes", {}).get("valueof", {})
            if b["maxclass"] in ("live.menu", "live.toggle"):
                self.value[bid] = int(v["parameter_initial"][0])

    def fire(self, src, outlet, msg):
        for dst, inlet in self.out_edges.get((src, outlet), []):
            self.recv(dst, inlet, msg)

    def recv(self, bid, inlet, msg):
        b = self.boxes[bid]
        cls = b["maxclass"]
        if cls == "message":
            self.fire(bid, 0, atoms(b["text"]))
            return
        if cls == "comment":
            if msg and msg[0] == "set":
                self.comments[bid] = " ".join(str(a) for a in msg[1:])
            return
        if cls in ("live.text", "live.toggle", "live.menu"):
            self.live_in.append((bid, msg))
            if msg == ("bang",) and cls == "live.menu":
                self.fire(bid, 0, (self.value[bid],))           # menu: re-outputs its value
            elif msg == ("bang",) and cls == "live.toggle":
                self.value[bid] = 1 - self.value[bid]           # toggle: a bang FLIPS it and outputs the new value
                self.fire(bid, 0, (self.value[bid],))
            return
        assert cls == "newobj", cls
        text = b["text"].split(" ")
        head, args = text[0], text[1:]
        if head == "js":
            self.js_in.append(msg)
        elif head == "node.script":
            self.node_in.append(msg)
        elif head == "deferlow":
            self.fire(bid, 0, msg)
        elif head == "t":
            for i in range(len(args) - 1, -1, -1):
                self.fire(bid, i, ("bang",))   # only [t b ...] is used here
        elif head == "prepend":
            self.fire(bid, 0, tuple(atoms(" ".join(args))) + msg)
        elif head == "route":
            if msg and msg[0] in atoms(" ".join(args)):
                i = list(atoms(" ".join(args))).index(msg[0])
                self.fire(bid, i, msg[1:] if len(msg) > 1 else ("bang",))
            else:
                self.fire(bid, len(args), msg)
        elif head == "pak":
            st = self.pak.setdefault(bid, [int(a) for a in args])
            st[inlet] = int(msg[0])
            self.fire(bid, 0, tuple(st))
        elif head == "unpack":
            for i in range(len(args) - 1, -1, -1):
                self.fire(bid, i, (msg[i],))
        elif head == "expr":
            st = self.expr.setdefault(bid, {})
            st[inlet + 1] = int(msg[0])
            if inlet == 0:
                code = re.sub(r"\$i(\d)", lambda m: "st[%s]" % m.group(1), " ".join(args)).replace("&&", " and ")
                self.fire(bid, 0, (int(eval(code, {"st": st})),))
        elif head in ("plugin~", "plugout~", "live.thisdevice"):
            pass
        else:
            raise AssertionError("simulator does not know " + b["text"])

    def inject(self, bid, outlet, msg):
        self.fire(bid, outlet, msg)


class AmxdTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # device/ARABridge.amxd is generated (git-ignored, absolute paths of the checkout): without it, build one here
        cls.committed = os.path.exists(AMXD)
        if cls.committed:
            with open(AMXD, "rb") as f:
                cls.data = f.read()
        else:
            with tempfile.TemporaryDirectory() as d:
                out = os.path.join(d, "fresh.amxd")
                r = subprocess.run([sys.executable, MAKE, out], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                assert r.returncode == 0, r.stdout.decode("utf-8", "replace")
                with open(out, "rb") as f:
                    cls.data = f.read()
        cls.c = parse(cls.data)
        cls.patcher = json.loads(cls.c["payload"][:-1].decode("utf-8"))
        cls.p = cls.patcher["patcher"]
        cls.boxes = {b["box"]["id"]: b["box"] for b in cls.p["boxes"]}
        cls.handlers = handler_names()

    def sim(self):
        return Sim(self.patcher)

    # ------------------------------------------------------------------ container
    def test_header_bytes(self):
        self.assertEqual(self.data[:28].hex(), EXPECTED_HEADER_HEX)
        self.assertEqual(self.c["ptch_offset"], 24)

    def test_header_matches_probe_device(self):
        if not os.path.exists(PROBE_AMXD):
            self.skipTest("probe device not present")
        with open(PROBE_AMXD, "rb") as f:
            ref = f.read()
        self.assertEqual(self.data[:28], ref[:28])
        self.assertEqual(ref[-1:], b"\x00")

    def test_payload_length_and_nul(self):
        self.assertEqual(self.c["length"], len(self.data) - 32)
        self.assertEqual(self.c["rest"], b"")
        self.assertEqual(self.c["payload"][-1:], b"\x00")
        self.assertNotIn(b"\x00", self.c["payload"][:-1])

    def test_patcher_basics(self):
        self.assertEqual(self.p["openinpresentation"], 1)
        self.assertEqual(self.p["devicewidth"], 330.0)
        self.assertEqual(self.p["openrect"][2:], [330.0, 169.0])
        self.assertEqual(self.p["appversion"]["major"], 9)

    # ------------------------------------------------------------------ boxes and ports
    def test_unique_ids(self):
        ids = [b["box"]["id"] for b in self.p["boxes"]]
        self.assertEqual(len(ids), len(set(ids)))

    def test_every_box_declares_ports(self):
        for bid, b in self.boxes.items():
            for key in ("numinlets", "numoutlets"):
                self.assertIn(key, b, "%s lacks %s" % (bid, key))
            if b["numoutlets"] > 0:    # comments and plugout~ have no outlets and no outlettype
                self.assertIn("outlettype", b, bid)
                self.assertEqual(len(b["outlettype"]), b["numoutlets"], bid)

    def test_port_counts_match_object_text(self):
        for bid, b in self.boxes.items():
            if b["maxclass"] != "newobj":
                continue
            t = b["text"].split(" ")
            head, args = t[0], t[1:]
            if head == "route":
                self.assertEqual(b["numoutlets"], len(args) + 1, bid)
            elif head == "t":
                self.assertEqual(b["numoutlets"], len(args), bid)
            elif head == "unpack":
                self.assertEqual(b["numoutlets"], len(args), bid)
            elif head == "pak":
                self.assertEqual(b["numinlets"], len(args), bid)
            elif head == "expr":
                n = max(int(m) for m in re.findall(r"\$i(\d)", b["text"]))
                self.assertEqual(b["numinlets"], n, bid)
            elif head in ("prepend", "deferlow"):
                self.assertEqual(b["numoutlets"], 1, bid)
            elif head == "js":
                self.assertEqual(b["numoutlets"], js_outlet_count(), "js outlets in bridge.js")
                self.assertEqual(b["numinlets"], 1)
            elif head == "node.script":
                self.assertEqual((b["numinlets"], b["numoutlets"]), (1, 2))
            elif head == "live.thisdevice":
                self.assertEqual(b["numoutlets"], 3)
            elif head == "plugin~":
                self.assertEqual((b["numinlets"], b["numoutlets"]), (2, 2))
            elif head == "plugout~":
                self.assertEqual(b["numinlets"], 2)
            else:
                self.fail("unexpected object " + b["text"])
        for bid, b in self.boxes.items():
            if b["maxclass"] == "live.menu":
                self.assertEqual(b["numoutlets"], 3)
            if b["maxclass"] == "live.text":
                self.assertEqual(b["numoutlets"], 2)
            if b["maxclass"] == "live.toggle":
                self.assertEqual(b["numoutlets"], 1)

    def test_lines_reference_existing_boxes_and_ports(self):
        self.assertTrue(self.p["lines"])
        for ln in self.p["lines"]:
            src, so = ln["patchline"]["source"]
            dst, di = ln["patchline"]["destination"]
            self.assertIn(src, self.boxes)
            self.assertIn(dst, self.boxes)
            self.assertLess(so, self.boxes[src]["numoutlets"], src)
            self.assertLess(di, self.boxes[dst]["numinlets"], dst)
        seen = [json.dumps(ln["patchline"], sort_keys=True) for ln in self.p["lines"]]
        self.assertEqual(len(seen), len(set(seen)), "duplicate patchline")

    def baked_js_path(self):
        js = [b["text"] for b in self.boxes.values() if b.get("text", "").startswith("js ")]
        self.assertEqual(len(js), 1)
        return js[0][3:]

    def skip_if_built_elsewhere(self):
        """The committed .amxd holds absolute paths of the checkout it was built in."""
        baked = self.baked_js_path()
        if baked != EXPECTED_JS:
            suffix = "/device/build/bridge.js"
            root = baked[:-len(suffix)] if baked.endswith(suffix) else baked
            self.skipTest("committed .amxd was built for %s; rebuild with python3 device/make_amxd.py" % root)

    def test_script_boxes_are_absolute(self):
        js = [b["text"] for b in self.boxes.values() if b.get("text", "").startswith("js ")]
        node = [b["text"] for b in self.boxes.values() if b.get("text", "").startswith("node.script ")]
        self.assertEqual(len(js), 1)
        self.assertEqual(len(node), 1)
        jp = js[0][3:]
        m = re.match(r"^node\.script (\S+) @autostart 1 @watch 0$", node[0])
        self.assertTrue(m, node[0])
        np_ = m.group(1)
        self.assertTrue(jp.startswith("/") and jp.endswith("/device/build/bridge.js"), jp)
        self.assertTrue(np_.startswith("/") and np_.endswith("/device/src/runner.js"), np_)
        self.assertEqual(jp[:-len("/device/build/bridge.js")], np_[:-len("/device/src/runner.js")], "same repo root")
        for pth in (jp, np_):
            self.assertNotIn(" ", pth)

    def test_scripts_exist_in_this_checkout(self):
        self.skip_if_built_elsewhere()
        self.assertEqual(self.baked_js_path(), EXPECTED_JS)
        node = [b["text"] for b in self.boxes.values() if b.get("text", "").startswith("node.script ")]
        self.assertEqual(node[0], "node.script %s @autostart 1 @watch 0" % EXPECTED_NODE)
        for pth in (EXPECTED_JS, EXPECTED_NODE):
            self.assertTrue(os.path.isfile(pth), pth)

    def test_audio_passthrough(self):
        lines = {(l["patchline"]["source"][0], l["patchline"]["source"][1],
                  l["patchline"]["destination"][0], l["patchline"]["destination"][1]) for l in self.p["lines"]}
        ins = [i for i, b in self.boxes.items() if b.get("text") == "plugin~"]
        outs = [i for i, b in self.boxes.items() if b.get("text") == "plugout~"]
        self.assertEqual((len(ins), len(outs)), (1, 1))
        self.assertIn((ins[0], 0, outs[0], 0), lines)
        self.assertIn((ins[0], 1, outs[0], 1), lines)

    # ------------------------------------------------------------------ parameters
    def param_boxes(self):
        return [b for b in self.boxes.values() if b.get("parameter_enable") == 1]

    def test_parameters(self):
        pbs = self.param_boxes()
        self.assertEqual({b["maxclass"] for b in pbs}, {"live.menu", "live.text", "live.toggle"})
        names, varnames = set(), set()
        for b in pbs:
            v = b["saved_attribute_attributes"]["valueof"]
            self.assertEqual(v["parameter_type"], 2, b["id"])
            self.assertEqual(v["parameter_linknames"], 1)
            self.assertNotIn(v["parameter_longname"], names, "long names must be unique")
            names.add(v["parameter_longname"])
            self.assertNotIn(b["varname"], varnames)
            varnames.add(b["varname"])
            self.assertEqual(b["varname"], v["parameter_longname"])
            self.assertIn("parameter_enum", v)
            self.assertEqual(v["parameter_mmax"], float(len(v["parameter_enum"]) - 1), b["id"])
            if b["maxclass"] == "live.text":
                self.assertEqual(b["mode"], 0)
                self.assertEqual(v["parameter_invisible"], 2, "buttons are hidden parameters")
            else:
                self.assertEqual(v["parameter_invisible"], 1, "settings are stored with the set")
                self.assertEqual(v["parameter_initial_enable"], 1)
                self.assertTrue(0 <= v["parameter_initial"][0] <= v["parameter_mmax"])
        self.assertEqual(set(self.p["parameters"]), {b["id"] for b in pbs})
        for b in pbs:
            ln, sn, zero = self.p["parameters"][b["id"]]
            self.assertEqual(ln, b["saved_attribute_attributes"]["valueof"]["parameter_longname"])
            self.assertEqual(zero, 0)

    def test_menu_contents_and_defaults(self):
        def valueof(i):
            return self.boxes[i]["saved_attribute_attributes"]["valueof"]
        self.assertEqual(valueof("obj-menu-place")["parameter_enum"], ["Take lane", "New track", "Replace in place"])
        self.assertEqual(valueof("obj-menu-place")["parameter_initial"], [0.0])    # takeLane, bridge.js default
        self.assertEqual(valueof("obj-t-norealign")["parameter_initial"], [0])      # inverted: 0 = realign ON (bridge default)
        self.assertEqual(valueof("obj-t-norealign")["parameter_longname"], "Skip realign")
        self.assertEqual(valueof("obj-t-norealign")["parameter_shortname"], "NoRealign")
        self.assertEqual(self.boxes["obj-lnorealign"]["text"], "Skip timing fix")
        self.assertEqual(valueof("obj-t-preview")["parameter_initial"], [0])        # Live preview is off by default
        self.assertEqual(valueof("obj-t-preview")["parameter_longname"], "Live preview")
        self.assertEqual(valueof("obj-t-preview")["parameter_shortname"], "Preview")
        self.assertEqual(self.boxes["obj-lpreview"]["text"], "Preview")
        self.assertEqual(valueof("obj-t-sync")["parameter_initial"], [0])           # transport sync is off by default
        self.assertEqual(valueof("obj-t-sync")["parameter_longname"], "Sync transport")
        self.assertEqual(valueof("obj-t-sync")["parameter_shortname"], "Sync")
        self.assertEqual(self.boxes["obj-lsync"]["text"], "Sync transport")
        with open(BRIDGE_SRC, "r", encoding="utf-8") as f:
            src = f.read()
        self.assertIn("var PLACEMENTS = ['takeLane', 'newTrack', 'replace'];", src)
        self.assertIn("realign: true,", src)

    # ------------------------------------------------------------------ presentation
    def test_presentation_fits_device(self):
        w = self.p["devicewidth"]
        h = self.p["openrect"][3]
        shown = []
        for b in self.boxes.values():
            if b["maxclass"] in ("live.text", "live.toggle", "live.menu", "comment"):
                self.assertEqual(b.get("presentation"), 1, b["id"])
            if b.get("presentation") == 1:
                x, y, bw, bh = b["presentation_rect"]
                self.assertGreaterEqual(x, 0, b["id"])
                self.assertGreaterEqual(y, 0, b["id"])
                self.assertLessEqual(x + bw, w, b["id"])
                self.assertLessEqual(y + bh, h, b["id"])
                shown.append(b["id"])
        non_ui = [b["id"] for b in self.boxes.values() if b["maxclass"] == "newobj" and b.get("presentation") == 1]
        self.assertEqual(non_ui, [])
        self.assertEqual(len(shown), 15)

    def test_presentation_objects_do_not_overlap(self):
        rects = [(b["id"], b["presentation_rect"]) for b in self.boxes.values() if b.get("presentation") == 1]
        for i in range(len(rects)):
            for j in range(i + 1, len(rects)):
                (a, ra), (b, rb) = rects[i], rects[j]
                overlap = ra[0] < rb[0] + rb[2] and rb[0] < ra[0] + ra[2] and ra[1] < rb[1] + rb[3] and rb[1] < ra[1] + ra[3]
                self.assertFalse(overlap, "%s overlaps %s" % (a, b))

    def test_title_and_version(self):
        title = self.boxes["obj-title"]
        self.assertTrue(re.match(r"^ARA2 Bridge 4 Live +v\d+\.\d+$", title["text"]), title["text"])
        self.assertEqual(title["presentation"], 1)

    # ------------------------------------------------------------------ message flow
    def test_buttons_send_the_exact_message_to_js(self):
        want = {"obj-b-mel": "sendMelodyne", "obj-b-guide": "setGuide", "obj-b-voc": "sendVocAlign",
                "obj-b-cancel": "cancel", "obj-b-refresh": "refreshPlugins"}
        labels = {"obj-b-mel": "Send to Melodyne", "obj-b-guide": "Set guide (VocAlign)", "obj-b-voc": "Send to VocAlign",
                  "obj-b-cancel": "Cancel", "obj-b-refresh": "Refresh plug-ins"}
        # whichever form Live emits for ONE click: a lone bang, a lone 1, or 1 on press and 0 on release
        clicks = {"bang": [("bang",)], "1": [(1,)], "1 then 0": [(1,), (0,)], "bang then 0": [("bang",), (0,)]}
        for bid, msg in want.items():
            self.assertEqual(self.boxes[bid]["text"], labels[bid])
            for name, seq in clicks.items():
                s = self.sim()
                for m in seq:
                    s.inject(bid, 0, m)
                self.assertEqual(s.js_in, [(msg,)], "%s: one click (%s) must give exactly one message" % (bid, name))
                self.assertEqual(s.node_in, [])
            s = self.sim()
            s.inject(bid, 0, (0,))
            self.assertEqual(s.js_in, [], "a lone release (0) must not send")
            s = self.sim()
            for _ in range(2):          # two clicks, two messages
                s.inject(bid, 0, (1,))
                s.inject(bid, 0, (0,))
            self.assertEqual(s.js_in, [(msg,), (msg,)])
            # the path: live.text -> [route bang 1] -> [t b] -> message box -> js
            self.assertEqual(self.boxes[bid + "-gate"]["text"], "route bang 1")
            self.assertEqual(self.boxes[bid + "-trig"]["text"], "t b")
            self.assertEqual(self.boxes[bid + "-msg"]["maxclass"], "message")
            self.assertEqual(self.boxes[bid + "-msg"]["text"], msg)
        self.assertFalse(any(b.get("text", "").startswith("sel ") for b in self.boxes.values()))

    def test_settings_messages(self):
        s = self.sim()
        s.inject("obj-menu-place", 0, (2,))
        s.inject("obj-menu-place", 0, (1,))
        s.inject("obj-t-norealign", 0, (1,))   # Skip realign on -> realign 0
        s.inject("obj-t-norealign", 0, (0,))
        self.assertEqual(s.js_in, [("settings", "placement", 2), ("settings", "placement", 1),
                                   ("settings", "realign", 0), ("settings", "realign", 1)])

    def test_startup_sends_saved_settings_then_ready(self):
        s = self.sim()
        s.inject("obj-thisdev", 0, ("bang",))
        self.assertEqual(s.js_in, [("settings", "placement", 0), ("ready",)])
        # the only thing that touches a live.* object at startup is the bang to the Placement menu
        self.assertEqual(s.live_in, [("obj-menu-place", ("bang",))])
        self.assertEqual(s.value["obj-t-norealign"], 0, "startup must not flip the toggle")
        # a restored placement is re-sent; a restored toggle stays untouched at startup
        s = self.sim()
        s.value["obj-menu-place"] = 2
        s.value["obj-t-norealign"] = 1
        s.inject("obj-thisdev", 0, ("bang",))
        self.assertEqual(s.js_in, [("settings", "placement", 2), ("ready",)])
        self.assertEqual(s.value["obj-t-norealign"], 1)
        self.assertNotIn(("refreshPlugins",), s.js_in)

    def test_skip_realign_toggle_maps_to_realign(self):
        # Live outputs the (restored or initial) toggle value by itself; 0 -> realign 1, 1 -> realign 0
        for v, want in ((0, 1), (1, 0)):
            s = self.sim()
            s.inject("obj-t-norealign", 0, (v,))
            self.assertEqual(s.js_in, [("settings", "realign", want)])

    def test_live_preview_toggle_maps_to_preview(self):
        # on (1) asks the host for previews, off (0) does not; nothing is sent at startup (the toggle is never banged)
        for v in (1, 0):
            s = self.sim()
            s.inject("obj-t-preview", 0, (v,))
            self.assertEqual(s.js_in, [("settings", "preview", v)])
            self.assertEqual(s.node_in, [])
        s = self.sim()
        s.inject("obj-thisdev", 0, ("bang",))
        self.assertNotIn(("settings", "preview", 0), s.js_in)
        self.assertNotIn(("settings", "preview", 1), s.js_in)

    def test_sync_toggle_maps_to_sync(self):
        for v in (1, 0):
            s = self.sim()
            s.inject("obj-t-sync", 0, (v,))
            self.assertEqual(s.js_in, [("settings", "sync", v)])
            self.assertEqual(s.node_in, [])

    def test_node_outlet0_reaches_host_prepends_with_the_right_selectors(self):
        for sel in PAYLOAD_SELECTORS:
            s = self.sim()
            s.inject("obj-node", 0, (sel, "%7B%22a%22%3A1%7D"))
            self.assertEqual(s.js_in, [("host" + sel[0].upper() + sel[1:], "%7B%22a%22%3A1%7D")], sel)
        s = self.sim()
        s.inject("obj-node", 0, ("pong",))
        self.assertEqual(s.js_in, [("hostPong",)])
        s = self.sim()
        s.inject("obj-node", 0, ("unrelated", "x"))
        self.assertEqual(s.js_in, [], "unmatched node messages are dropped")
        for sel in PAYLOAD_SELECTORS:
            self.assertIn("host" + sel[0].upper() + sel[1:], self.handlers)
        self.assertIn("hostPong", self.handlers)

    def test_node_lifecycle_outlet(self):
        for ev in ("terminated", "restarted"):
            s = self.sim()
            s.inject("obj-node", 1, (ev,))
            # route turns the bare selector into a bang, [prepend] appends it; bridge.js reads only the first argument
            self.assertEqual(s.js_in, [("nodeLifecycle", ev, "bang")])
            s = self.sim()
            s.inject("obj-node", 1, (ev, 1))
            self.assertEqual(s.js_in[0][:2], ("nodeLifecycle", ev))
        for other in (("running", 1), ("stdout", "hello"), ("stderr", "x")):
            s = self.sim()
            s.inject("obj-node", 1, other)
            self.assertEqual(s.js_in, [], other)

    def test_js_outlets(self):
        s = self.sim()
        s.inject("obj-js", 1, ("launch", "%7B%7D"))
        self.assertEqual(s.node_in, [("launch", "%7B%7D")])
        s.inject("obj-js", 1, ("cancel",))
        s.inject("obj-js", 1, ("findplugins",))
        self.assertEqual(s.node_in[1:], [("cancel",), ("findplugins",)])
        s = self.sim()
        s.inject("obj-js", 0, ("Sent", "to", "Melodyne."))
        self.assertEqual(s.comments["obj-status"], "Sent to Melodyne.")
        self.assertEqual(s.js_in, [])

    def test_no_ui_state_reaches_live_objects(self):
        """No `active`/greying anywhere: after load nothing may send a message into a live.* object."""
        self.assertFalse(any("active" in b.get("text", "").split(" ") for b in self.boxes.values()))
        into_live = {(l["patchline"]["source"][0], l["patchline"]["destination"][0]) for l in self.p["lines"]
                     if self.boxes[l["patchline"]["destination"][0]]["maxclass"].startswith("live.")
                     and self.boxes[l["patchline"]["destination"][0]]["maxclass"] != "live.thisdevice"}
        self.assertEqual(into_live, {("obj-tstart", "obj-menu-place")})
        # js outlet 2 (busy/cancel/plugins/host/guide) is not connected to anything
        self.assertFalse([l for l in self.p["lines"] if l["patchline"]["source"] == ["obj-js", 2]])
        s = self.sim()
        s.inject("obj-thisdev", 0, ("bang",))
        n = len(s.live_in)
        for m in (("busy", 1), ("cancel", 1), ("plugins", 1, 0), ("host", 1), ("guide", 1), ("busy", 0)):
            s.inject("obj-js", 2, m)
        self.assertEqual(len(s.live_in), n)
        self.assertEqual(s.node_in, [])

    def test_only_known_messages_reach_js(self):
        """Every edge into js comes from a message box or [prepend]/[route] chain whose selector js handles."""
        into_js = [l["patchline"]["source"][0] for l in self.p["lines"] if l["patchline"]["destination"][0] == "obj-js"]
        self.assertTrue(into_js)
        for src in into_js:
            b = self.boxes[src]
            if b["maxclass"] == "message":
                sel = b["text"].split(" ")[0]
            else:
                self.assertEqual(b["maxclass"], "newobj", src)
                t = b["text"].split(" ")
                self.assertEqual(t[0], "prepend", src)
                sel = t[1]
            self.assertIn(sel, self.handlers, "%s sends %s which bridge.js does not handle" % (src, sel))

    # ------------------------------------------------------------------ determinism and staleness
    def fresh_builds(self):
        with tempfile.TemporaryDirectory() as d:
            outs = []
            for name in ("a.amxd", "b.amxd"):
                out = os.path.join(d, name)
                r = subprocess.run([sys.executable, MAKE, out], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                self.assertEqual(r.returncode, 0, r.stdout.decode("utf-8", "replace"))
                with open(out, "rb") as f:
                    outs.append(f.read())
        return outs

    def test_rebuild_is_deterministic(self):
        da, db = self.fresh_builds()
        self.assertEqual(da, db, "two builds differ")

    def test_committed_file_is_current(self):
        if not self.committed:
            self.skipTest("device/ARABridge.amxd does not exist in this checkout (it is generated)")
        self.skip_if_built_elsewhere()
        da, _ = self.fresh_builds()
        self.assertEqual(da, self.data, "device/ARABridge.amxd is stale: run python3 device/make_amxd.py")


if __name__ == "__main__":
    unittest.main(verbosity=2)
