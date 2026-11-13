// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Transitions (the widget's TransitionsPage, D327; plan Q3 slice 3): type, easing and duration per canvas, the
// portrait canvas can mirror the main one, and Force complete ends a running transition. It loads ui/api/project/transitions
// when Settings opens (flags stream-settings and transitions on), Save sends ui/api/project/transition per canvas, and Force
// complete posts ui/api/transitions/force, so both studios write the same project file. While live nothing can be changed
// (the host refuses it too); Force complete works any time.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Column {
    id: tp
    required property var box
    width: parent ? parent.width : 0
    spacing: 12

    // ---- state ----
    property bool loaded: false
    property bool started: false          // the load is on its way or done (Settings starts it as soon as the flags are known)
    property int gen: 0                   // a newer load or reset drops older answers
    property var info: ({})               // the answer of ui/api/project/transitions
    property var rows: ({ h: { type: "cut", ease: "linear", ms: 500 }, v: { type: "cut", ease: "linear", ms: 500 } })
    property var kept: ({ h: "", v: "" })  // the type a canvas had when loaded (a stinger is kept as it is unless changed here)
    property bool mirror: false
    property string orig: ""               // the signature as loaded, to see a change
    property string forced: ""
    property string status: ""

    readonly property bool live: box.store.live
    readonly property bool active: box.ready && box.flagOn("stream-settings") && box.flagOn("transitions")
    readonly property bool dirty: !live && loaded && signature() !== orig
    readonly property var easing: info.easing || ({})
    readonly property var range: easing.durationMs || ({})
    readonly property int msMin: typeof range.min === "number" ? range.min : 0
    readonly property int msMax: typeof range.max === "number" ? range.max : 10000
    readonly property var easeModel: opts(easing.easing)

    onActiveChanged: { if (!active) reset(); else if (!started) load() }
    visible: active
    enabled: loaded

    function opts(list) { return (list || []).map(x => ({ value: x.id, text: x.label })) }
    function idx(model, v) { return Math.max(0, model.findIndex(m => m.value === v)) }
    function typeModel(c) {
        const m = opts((easing.types || []).filter(t => t.id !== "stinger"));
        const k = kept[c];
        if (k !== "" && !m.some(x => x.value === k)) m.push({ value: k, text: "Stinger (video)" }); // kept as it is unless changed here
        return m;
    }
    function row(c) { return c === "v" ? rows.v : rows.h }
    function signature() {
        const out = [];
        for (const c of ["h", "v"]) out.push(rows[c].type, rows[c].ease, String(rows[c].ms));
        out.push(mirror ? "mirror" : "");
        return out.join("|");
    }

    function reset() {
        gen++;
        started = false;
        loaded = false;
        info = ({});
        rows = ({ h: { type: "cut", ease: "linear", ms: 500 }, v: { type: "cut", ease: "linear", ms: 500 } });
        kept = ({ h: "", v: "" });
        mirror = false;
        orig = "";
        forced = "";
        status = "";
    }

    function load() {
        const g = ++gen;
        started = true;
        Api.get("ui/api/project/transitions", (ok, b, err) => {
            if (g !== gen) return; // closed, or opened again, before the answer came
            if (!ok || b.available !== true) {
                status = ok ? "Transitions need the transitions feature and a loaded scene project." : "Transitions not available: " + err;
                return;
            }
            info = b;
            const e = b.easing || {}, dur = e.durationMs || ({});
            const lo = typeof dur.min === "number" ? dur.min : 0, hi = typeof dur.max === "number" ? dur.max : 10000;
            const def = typeof dur.default === "number" ? dur.default : 500;
            const easeIds = (e.easing || []).map(x => x.id);
            const r = { h: { type: "cut", ease: easeIds.length ? easeIds[0] : "linear", ms: def }, v: { type: "cut", ease: easeIds.length ? easeIds[0] : "linear", ms: def } };
            const k = { h: "", v: "" };
            const known = (e.types || []).map(t => t.id).filter(id => id !== "stinger");
            let mir = false;
            for (const c of (b.canvases || [])) {
                const id = c.id === "v" ? "v" : "h", t = c.transition || ({});
                const type = t.type || "cut";
                k[id] = known.includes(type) ? "" : type;
                r[id] = {
                    type: type,
                    ease: easeIds.includes(t.easing || "linear") ? (t.easing || "linear") : (easeIds.length ? easeIds[0] : "linear"),
                    ms: Math.max(lo, Math.min(hi, typeof t.durationMs === "number" ? t.durationMs : def))
                };
                if (id === "v") mir = t.mirror === true;
            }
            kept = k;
            rows = r;
            mirror = mir;
            loaded = true;
            orig = signature();
        });
    }

    // ---- changes (each is refused while live: the boxes are off, and so is the probe) ----
    function setRow(c, field, v) {
        if (live || !loaded) return false;
        const r = Object.assign({}, rows), x = Object.assign({}, r[c]);
        x[field] = field === "ms" ? Math.max(msMin, Math.min(msMax, typeof v === "number" && !isNaN(v) ? v : msMin)) : v;
        r[c] = x;
        rows = r;
        return true;
    }
    function setMirror(on) {
        if (live || !loaded) return false;
        mirror = on;
        return true;
    }
    // fade has easing and duration; a mirrored portrait canvas follows the main one; nothing changes while live
    function editable(c, field) {
        if (live || !loaded) return false;
        if (field === "type") return c === "h" || !mirror;
        return row(c).type === "fade" && !(c === "v" && mirror);
    }

    // What Save sends: nothing when the page did not change or while live. A stinger stays as the main window's panel set it.
    function save() {
        if (live || !loaded || signature() === orig) return;
        const body = (c) => {
            const x = rows[c], b = { canvas: c, type: x.type };
            if (x.type === "fade") { b.durationMs = x.ms; b.easing = x.ease }
            return b;
        };
        for (const c of (info.canvases || []))
            if (c.id === "v" && (c.transition || ({})).type === "stinger" && rows.v.type === "stinger" && !mirror) return;
        let hb = body("h"), vb = body("v");
        if (mirror) { // the portrait canvas follows the main one; the host uses the main canvas's values
            vb = Object.assign({}, hb, { canvas: "v", mirror: true });
        }
        if (hb.type === "stinger") hb = null; // set in the main window's panel
        // The page goes with the Settings window right after Save: the chain holds only the store.
        const store = box.store;
        const send = (b, next) => {
            if (!b) return next();
            Api.post("ui/api/project/transition", b, (ok, r, err) => {
                if (!ok) store.say("Transition (" + b.canvas.toUpperCase() + ") not saved: " + err);
                next();
            });
        };
        send(hb, () => send(vb, () => store.say("Transitions saved; the host follows within a few seconds.")));
    }

    function force(c) {
        const g = gen;
        Api.post("ui/api/transitions/force", { canvas: c }, (ok, b, err) => {
            if (g !== gen) return;
            const done = ok && b && b.result && b.result.completed === true;
            forced = c + (ok ? (done ? ":completed" : ":idle") : ":error");
            status = !ok ? "Force complete failed: " + err : done ? "The running transition was completed." : "No transition was running on that canvas.";
        });
    }

    component Words: Text {
        color: Theme.c.text
        font.family: Theme.family
        font.pixelSize: 14
    }
    component Quiet: Text {
        width: parent ? parent.width : 0
        wrapMode: Text.Wrap
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: 13
    }
    // a label over its control; a Flow puts as many of them in a row as fit, so the page never needs sideways room
    component Field: Column {
        property string label: ""
        width: 250
        spacing: 4
        Words { text: parent.label }
    }
    // a box that follows the page's value even after the user picked one (a picked value breaks a plain binding)
    component PickBox: UCombo {
        id: pb
        property int want: 0
        Binding { target: pb; property: "currentIndex"; value: pb.want }
    }
    component SpinBox2: USpin {
        id: sb
        property int want: 0
        Binding { target: sb; property: "value"; value: sb.want }
    }

    component CanvasCard: UCard {
        id: cc
        property string canvas: "h"
        readonly property var cur: tp.row(canvas)
        readonly property var types: tp.typeModel(canvas)
        Flow {
            width: parent.width
            spacing: 14
            Field {
                label: "Type"
                PickBox {
                    objectName: "trType:" + cc.canvas
                    width: parent.width
                    label: "Type"
                    enabled: tp.editable(cc.canvas, "type")
                    model: cc.types
                    want: tp.idx(cc.types, cc.cur.type)
                    onChose: (v) => tp.setRow(cc.canvas, "type", v)
                }
            }
            Field {
                label: "Easing"
                PickBox {
                    objectName: "trEase:" + cc.canvas
                    width: parent.width
                    label: "Easing"
                    enabled: tp.editable(cc.canvas, "ease")
                    model: tp.easeModel
                    want: tp.idx(tp.easeModel, cc.cur.ease)
                    onChose: (v) => tp.setRow(cc.canvas, "ease", v)
                }
            }
            Field {
                label: "Duration"
                SpinBox2 {
                    objectName: "trMs:" + cc.canvas
                    label: "Duration"
                    suffix: " ms"
                    enabled: tp.editable(cc.canvas, "ms")
                    from: tp.msMin
                    to: tp.msMax
                    stepSize: 50
                    want: cc.cur.ms
                    onValueModified: tp.setRow(cc.canvas, "ms", value)
                }
            }
        }
        UButton {
            objectName: "trForce:" + cc.canvas
            text: "Force complete transition"
            tip: "Ends a transition that is running on this canvas now (it shows the new scene at once)."
            onClicked: tp.force(cc.canvas)
        }
    }

    CanvasCard { title: "MAIN CANVAS"; canvas: "h" }

    USwitch {
        id: mirrorSw
        objectName: "transitionsMirror"
        width: parent.width
        text: "Mirror main canvas transitions"
        hint: "On: the portrait canvas uses the main canvas's type, easing and duration."
        enabled: !tp.live
        checked: tp.mirror
        onToggled: tp.setMirror(checked)
        Binding { target: mirrorSw; property: "checked"; value: tp.mirror }
    }

    CanvasCard { title: "PORTRAIT CANVAS"; canvas: "v" }

    Quiet { objectName: "transitionsStatus"; visible: tp.status !== ""; text: tp.status }
    Quiet { text: "A stinger video is chosen in the Transitions panel of the main window. Transitions cannot be changed while live; Force complete works any time." }

    // ---- probe (tests): the same names and values as the widget page's probe ----
    function probe() {
        const one = (c) => ({ type: rows[c].type, easing: rows[c].ease, easingChoices: easeModel.length, durationMs: rows[c].ms, easingEnabled: editable(c, "ease") });
        return { loaded: loaded, h: one("h"), v: one("v"), mirror: mirror, forced: forced, status: status, live: live };
    }

    // tr-type:<h|v>:<id> | tr-ease:<h|v>:<id> | tr-ms:<h|v>:<n> | tr-mirror:<on|off> | tr-force:<h|v>
    function probeAction(p) {
        if (!loaded) return false;
        if (p[0] === "tr-force" && p.length === 2) {
            force(p[1] === "v" ? "v" : "h");
            return true;
        }
        if (p[0] === "tr-mirror" && p.length === 2) return setMirror(p[1] === "on" || p[1] === "1");
        if (p.length !== 3 || (p[1] !== "h" && p[1] !== "v")) return false;
        const c = p[1];
        switch (p[0]) {
        case "tr-type": return typeModel(c).some(m => m.value === p[2]) && editable(c, "type") && setRow(c, "type", p[2]);
        case "tr-ease": return easeModel.some(m => m.value === p[2]) && editable(c, "ease") && setRow(c, "ease", p[2]);
        case "tr-ms": return editable(c, "ms") && setRow(c, "ms", parseInt(p[2], 10));
        }
        return false;
    }
}
