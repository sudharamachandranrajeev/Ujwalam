// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Stream (the widget's StreamPage, D327/D378; plan Q3 slice 2): canvas mode, video, audio and the outputs list
// with Add, Edit and Delete. It loads ui/api/stream/setup when Settings opens (flag stream-settings on), checks every
// change with ui/api/stream/check after 250 ms, and Save sends ui/api/stream/setup, so both studios write the same
// stream-setup.json. The Edit output window is OutputDialog.qml (sp.editor).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Column {
    id: sp
    required property var box
    property var editor: null            // the Edit output window
    width: parent ? parent.width : 0
    spacing: 12

    // ---- state ----
    property bool loaded: false
    property var setup: ({})             // the draft: what Save sends
    property var options: ({})
    property var canvases: ({})
    property string orig: ""             // the setup as loaded, to see a change
    property string problemsLine: ""
    property bool connectOn: false       // flag platform-connect: ui/api/connect answers
    property var connectRows: ({})
    property int selected: -1
    property int gen: 0                  // a newer load or reset drops older answers
    property bool started: false         // the load is on its way or done (Settings starts it as soon as the flags are known)
    readonly property bool active: box.ready && box.flagOn("stream-settings")
    readonly property bool dirty: loaded && JSON.stringify(setup) !== orig
    readonly property bool blocksSave: dirty && problemsLine !== ""
    readonly property var video: setup.video || ({})
    readonly property bool multi: setup.canvasMode === "multi"
    readonly property var kb: options.videoBitrateKbps || ({ min: 500, max: 100000, step: 500 })

    readonly property var resModel: opts(options.resolutions)
    readonly property var portraitModel: opts(options.portraitResolutions)
    readonly property var qualityModel: opts(options.qualityPresets)
    readonly property var fpsModel: (options.frameRates || []).map(n => ({ value: n, text: n + " fps" }))
    readonly property var audioModel: (options.audioBitratesKbps || []).map(n => ({ value: n, text: n + " kbps" }))
    readonly property string canvasInfo: {
        const h = canvases.H || {}, v = canvases.V || {};
        if (!canvases.H) return "Set by the scene project (read-only here)";
        return "Main " + h.w + "x" + h.h + ", portrait " + v.w + "x" + v.h + " (from the scene project, read-only here)";
    }

    onActiveChanged: { if (!active) reset(); else if (!started) load() }
    visible: active
    enabled: loaded

    function opts(list) { return (list || []).map(x => ({ value: x.id, text: x.label })) }
    function idx(model, v) { return Math.max(0, model.findIndex(m => m.value === v)) }
    function problemsText(arr) { return (arr || []).map(p => p.message).join("\n") }
    function platformOf(id) { return (options.platforms || []).find(p => p.id === id) || ({}) }
    function stateText(row) {
        const key = row.key || ({});
        let t = row.state === "connected" ? "Connected" : row.state === "token-expired" ? "Sign-in expired" : "Not connected";
        if (key.present === true && key.last4 !== undefined) t += "  (key ...." + key.last4 + ")";
        return t;
    }

    function reset() {
        gen++;
        started = false;
        loaded = false;
        setup = ({});
        options = ({});
        canvases = ({});
        orig = "";
        problemsLine = "";
        connectOn = false;
        connectRows = ({});
        selected = -1;
    }

    // A value the page's boxes could not show is what the boxes would show (the widget loads through its boxes).
    function pickId(list, cur) { return list.some(x => x.id === cur) ? cur : (list.length ? list[0].id : cur) }
    function clampKbps(n) { return Math.max(kb.min, Math.min(kb.max, typeof n === "number" ? n : 0)) }
    function normalize(s) {
        const o = Object.assign({}, s), v = Object.assign({}, s.video || {});
        v.output = pickId(options.resolutions || [], v.output);
        if ((options.portraitResolutions || []).length) v.portraitOutput = pickId(options.portraitResolutions, v.portraitOutput);
        const fr = options.frameRates || [];
        v.fps = fr.includes(v.fps) ? v.fps : (fr.length ? fr[0] : v.fps);
        v.quality = pickId(options.qualityPresets || [], v.quality);
        const ab = options.audioBitratesKbps || [];
        v.audioKbps = ab.includes(v.audioKbps) ? v.audioKbps : (ab.length ? ab[0] : v.audioKbps);
        v.bitrateKbps = clampKbps(v.bitrateKbps);
        v.portraitBitrateKbps = clampKbps(v.portraitBitrateKbps);
        v.hardware = v.hardware !== false;
        o.video = v;
        return o;
    }

    function load() {
        const g = ++gen;
        started = true;
        Api.get("ui/api/stream/setup", (ok, b, err) => {
            if (g !== gen) return; // closed, or opened again, before the answer came
            if (!ok) { problemsLine = "Stream settings not available: " + err; return }
            options = b.options || {};
            canvases = b.canvases || {};
            setup = normalize(b.setup || {});
            orig = JSON.stringify(setup);
            loaded = true;
            problemsLine = problemsText(b.problems);
            refreshConnect();
        });
    }

    // The connection state per output (flag platform-connect: the route answers 404 while it is off; then nothing about
    // connections is shown). Rows hold presence and at most the last 4 characters of a key, never a key.
    function takeConnect(ok, b) {
        const rows = {};
        if (ok) for (const x of (b.outputs || [])) rows[x.id] = x;
        connectOn = ok;
        connectRows = rows;
        return rows;
    }
    function refreshConnect() {
        const g = gen;
        Api.get("ui/api/connect", (ok, b) => { if (g === gen) takeConnect(ok, b) });
    }

    // ---- changes ----
    function changed() { if (loaded) checkTimer.restart() }
    function setVideo(k, v) {
        const s = Object.assign({}, setup), vv = Object.assign({}, s.video);
        vv[k] = v;
        s.video = vv;
        setup = s;
        changed();
    }
    function setKbps(k, n) { setVideo(k, clampKbps(n)) }
    function setMode(id) {
        const s = Object.assign({}, setup);
        s.canvasMode = id;
        setup = s;
        changed();
    }
    function setOutputs(list) {
        const s = Object.assign({}, setup);
        s.outputs = list;
        setup = s;
        if (selected >= list.length) selected = -1;
    }

    function check() {
        const g = gen;
        Api.post("ui/api/stream/check", { setup: setup }, (ok, b, err) => {
            if (g !== gen) return;
            problemsLine = ok ? problemsText(b.problems) : err;
        });
    }

    function newId(outs, platform) {
        const used = ["record"].concat(outs.map(o => o.id));
        if (!used.includes(platform)) return platform;
        for (let n = 2; n < 100; n++) if (!used.includes(platform + "-" + n)) return platform + "-" + n;
        return "";
    }

    // Fresh connection state first (it may have changed in Settings > Connections), then the window.
    function openEditor(index) {
        const outs = setup.outputs || [];
        if (index >= outs.length || !editor) return;
        Api.get("ui/api/connect", (ok, b) => {
            if (!loaded) return;
            const rows = takeConnect(ok, b);
            const conn = { on: ok };
            if (index >= 0 && index < outs.length) conn.row = rows[outs[index].id] || {};
            editor.ask(index, conn);
        });
    }

    function applyOutput(index, o) {
        const outs = (setup.outputs || []).slice();
        if (index < 0) {
            const id = newId(outs, o.platform);
            if (id === "") return;
            o.id = id;
            outs.push(o);
        } else {
            outs[index] = o;
        }
        setOutputs(outs);
        check();
    }

    // The click acts (the draft changes; Save writes it). The stored key is left alone.
    function deleteOutput(index) {
        const outs = (setup.outputs || []).slice();
        if (index < 0 || index >= outs.length) return;
        outs.splice(index, 1);
        setOutputs(outs);
        check();
    }

    // What Save sends: nothing when the page did not change.
    function save() {
        if (!loaded || !dirty) return;
        Api.post("ui/api/stream/setup", { setup: setup }, (ok, b, err) => {
            if (ok) return box.store.say("Stream settings saved; they apply the next time you go live.");
            const why = problemsText(b ? b.problems : []);
            box.store.say("Stream settings not saved: " + (why !== "" ? why : err));
        });
    }

    function rowSub(o) {
        const v = o.video || {};
        const kbps = o.canvas === "V" ? video.portraitBitrateKbps : (typeof v.bitrateKbps === "number" ? v.bitrateKbps : video.bitrateKbps);
        let t = kbps + " kbps" + (o.enabled !== false ? "" : " · switched off");
        if (connectOn && connectRows[o.id]) t += " - " + stateText(connectRows[o.id]);
        return t;
    }

    Timer { id: checkTimer; interval: 250; repeat: false; onTriggered: sp.check() }

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
    component ModeCard: Button {
        id: mc
        property string heading: ""
        property string words: ""
        property bool current: false
        checkable: false
        checked: current
        hoverEnabled: true
        focusPolicy: Qt.StrongFocus
        padding: 12
        Accessible.name: heading + ". " + words
        contentItem: Column {
            spacing: 2
            Text {
                width: mc.availableWidth
                text: mc.heading
                wrapMode: Text.Wrap
                color: Theme.c.text
                font.family: Theme.family
                font.pixelSize: 14
                font.weight: Font.DemiBold
            }
            Text {
                width: mc.availableWidth
                text: mc.words
                wrapMode: Text.Wrap
                color: Theme.c.muted
                font.family: Theme.family
                font.pixelSize: 13
            }
        }
        background: Rectangle {
            radius: Theme.radiusMedium
            color: mc.current ? Theme.c.field : "transparent"
            border.width: mc.current || mc.visualFocus ? 2 : 1
            border.color: mc.current ? Theme.c.accent : mc.visualFocus ? Theme.c.accentHi : Theme.c.border
        }
    }

    UCard {
        title: "CANVAS"
        Row {
            width: parent.width
            spacing: 10
            ModeCard {
                objectName: "streamMode:main"
                width: (parent.width - parent.spacing) / 2
                heading: "Main canvas only"
                words: "One 16:9 picture for every platform"
                current: sp.setup.canvasMode === "main"
                onClicked: sp.setMode("main")
            }
            ModeCard {
                objectName: "streamMode:multi"
                width: (parent.width - parent.spacing) / 2
                heading: "Main + portrait canvas"
                words: "16:9 and a separate 9:16 for portrait outputs"
                current: sp.multi
                onClicked: sp.setMode("multi")
            }
        }
    }

    UCard {
        title: "VIDEO"
        Text {
            objectName: "streamCanvasInfo"
            width: parent.width
            text: "Canvas resolution: " + sp.canvasInfo
            wrapMode: Text.Wrap
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: 13
        }
        Flow {
            width: parent.width
            spacing: 14
            Field {
                label: "Output resolution"
                UCombo {
                    objectName: "streamResolution"
                    width: parent.width
                    label: "Output resolution"
                    model: sp.resModel
                    currentIndex: sp.idx(sp.resModel, sp.video.output)
                    onChose: (v) => sp.setVideo("output", v)
                }
            }
            Field {
                label: "Portrait output resolution"
                UCombo {
                    objectName: "streamPortraitOutput"
                    width: parent.width
                    label: "Portrait output resolution"
                    enabled: sp.portraitModel.length > 0
                    model: sp.portraitModel
                    currentIndex: sp.idx(sp.portraitModel, sp.video.portraitOutput)
                    onChose: (v) => sp.setVideo("portraitOutput", v)
                }
            }
            Field {
                label: "Frame rate"
                UCombo {
                    objectName: "streamFps"
                    width: parent.width
                    label: "Frame rate"
                    model: sp.fpsModel
                    currentIndex: sp.idx(sp.fpsModel, sp.video.fps)
                    onChose: (v) => sp.setVideo("fps", v)
                }
            }
            Field {
                label: "Quality"
                UCombo {
                    objectName: "streamQuality"
                    width: parent.width
                    label: "Quality"
                    model: sp.qualityModel
                    currentIndex: sp.idx(sp.qualityModel, sp.video.quality)
                    onChose: (v) => sp.setVideo("quality", v)
                }
            }
            Field {
                label: "Main canvas bitrate"
                USpin {
                    objectName: "streamKbps"
                    label: "Main canvas bitrate"
                    suffix: " kbps"
                    from: sp.kb.min
                    to: sp.kb.max
                    stepSize: sp.kb.step
                    value: sp.loaded ? sp.video.bitrateKbps : from
                    onValueModified: sp.setKbps("bitrateKbps", value)
                }
            }
            Field {
                label: "Portrait canvas bitrate"
                USpin {
                    objectName: "streamPortraitKbps"
                    label: "Portrait canvas bitrate"
                    suffix: " kbps"
                    enabled: sp.multi
                    from: sp.kb.min
                    to: sp.kb.max
                    stepSize: sp.kb.step
                    value: sp.loaded ? sp.video.portraitBitrateKbps : from
                    onValueModified: sp.setKbps("portraitBitrateKbps", value)
                }
            }
        }
        USwitch {
            objectName: "streamHardware"
            width: parent.width
            text: "Hardware encoder (NVIDIA)"
            hint: "Off: the processor (x264) makes the video instead."
            checked: sp.video.hardware !== false
            onToggled: sp.setVideo("hardware", checked)
        }
    }

    UCard {
        title: "AUDIO"
        Field {
            label: "Audio bitrate"
            UCombo {
                objectName: "streamAudio"
                width: parent.width
                label: "Audio bitrate"
                model: sp.audioModel
                currentIndex: sp.idx(sp.audioModel, sp.video.audioKbps)
                onChose: (v) => sp.setVideo("audioKbps", v)
            }
        }
    }

    UCard {
        title: "OUTPUTS"
        Quiet {
            objectName: "streamNoOutputs"
            visible: (sp.setup.outputs || []).length === 0
            text: "No outputs yet. Click Add output to choose where to stream."
        }
        Repeater {
            model: sp.setup.outputs || []
            delegate: Rectangle {
                id: orow
                required property var modelData
                required property int index
                objectName: "streamOutput:" + modelData.id
                width: parent.width
                height: 52
                radius: Theme.radiusSmall
                color: sp.selected === index ? Theme.c.field : "transparent"
                border.width: 1
                border.color: sp.selected === index ? Theme.c.accent : Theme.c.border
                MouseArea {
                    anchors.fill: parent
                    onClicked: sp.selected = orow.index
                    onDoubleClicked: { sp.selected = orow.index; sp.openEditor(orow.index) }
                }
                Row {
                    anchors { left: parent.left; right: parent.right; verticalCenter: parent.verticalCenter; margins: 8 }
                    spacing: 10
                    Rectangle {
                        width: 30
                        height: 22
                        radius: 6
                        anchors.verticalCenter: parent.verticalCenter
                        color: Theme.c.accent
                        Text {
                            anchors.centerIn: parent
                            text: sp.platformOf(orow.modelData.platform).badge || String(orow.modelData.platform).slice(0, 2).toUpperCase()
                            color: Theme.c.onAccent
                            font.family: Theme.family
                            font.pixelSize: 12
                            font.weight: Font.DemiBold
                        }
                    }
                    Column {
                        width: parent.width - 40
                        anchors.verticalCenter: parent.verticalCenter
                        Text {
                            width: parent.width
                            text: orow.modelData.name + "  " + (orow.modelData.canvas === "V" ? "Portrait" : "Main")
                            textFormat: Text.PlainText
                            elide: Text.ElideRight
                            color: Theme.c.text
                            font.family: Theme.family
                            font.pixelSize: 14
                            font.weight: Font.DemiBold
                        }
                        Text {
                            objectName: "outputRowText:" + orow.modelData.id
                            width: parent.width
                            text: sp.rowSub(orow.modelData)
                            elide: Text.ElideRight
                            color: Theme.c.muted
                            font.family: Theme.family
                            font.pixelSize: 13
                        }
                    }
                }
            }
        }
        Row {
            spacing: 8
            UButton { objectName: "streamAdd"; text: "Add output"; onClicked: sp.openEditor(-1) }
            UButton { objectName: "streamEdit"; text: "Edit"; enabled: sp.selected >= 0; onClicked: sp.openEditor(sp.selected) }
            UButton { objectName: "streamDelete"; text: "Delete"; enabled: sp.selected >= 0; onClicked: sp.deleteOutput(sp.selected) }
        }
    }

    Text {
        objectName: "streamProblems"
        visible: sp.problemsLine !== ""
        width: parent.width
        wrapMode: Text.Wrap
        text: sp.problemsLine
        textFormat: Text.PlainText
        color: Theme.c.danger
        font.family: Theme.family
        font.pixelSize: 13
    }
    Quiet { text: "Changes apply the next time you go live. Values over a platform's limit are refused with the limit shown." }

    // ---- probe (tests): the same names and values as the widget page's probe ----
    function probe() {
        const outs = setup.outputs || [];
        const o = { loaded: loaded, setup: setup, outputs: outs.map(x => x.id), problems: problemsLine, connectOn: connectOn,
            rowStatus: outs.filter(x => connectOn && connectRows[x.id]).map(x => x.name + "  " + (x.canvas === "V" ? "Portrait" : "Main") + " " + rowSub(x)),
            portraitOutput: { choices: portraitModel.map(m => m.value), value: video.portraitOutput, enabled: portraitModel.length > 0 } };
        if (editor) Object.assign(o, editor.probe());
        return o;
    }

    function probeAction(p) {
        if (!loaded) return false;
        const n = parseInt(p[1], 10);
        switch (p[0]) {
        case "stream-mode": if (p[1] !== "main" && p[1] !== "multi") return false; setMode(p[1]); return true;
        case "stream-kbps": setKbps("bitrateKbps", n); return video.bitrateKbps === n;
        case "stream-pkbps": setKbps("portraitBitrateKbps", n); return video.portraitBitrateKbps === n;
        case "stream-res": if (!resModel.some(m => m.value === p[1])) return false; setVideo("output", p[1]); return true;
        case "stream-portrait": if (!portraitModel.some(m => m.value === p[1])) return false; setVideo("portraitOutput", p[1]); return true;
        case "stream-fps": if (!fpsModel.some(m => m.value === n)) return false; setVideo("fps", n); return true;
        case "stream-quality": if (!qualityModel.some(m => m.value === p[1])) return false; setVideo("quality", p[1]); return true;
        case "stream-audio": if (!audioModel.some(m => m.value === n)) return false; setVideo("audioKbps", n); return true;
        case "stream-hardware": setVideo("hardware", p[1] === "on" || p[1] === "1"); return true;
        case "stream-output-delete-now": // Delete (it asks nothing: the draft changes, Save writes it)
            if (n < 0 || n >= (setup.outputs || []).length) return false;
            deleteOutput(n);
            return true;
        case "stream-output-add": openEditor(-1); return true;
        case "stream-output-edit":
            if (n < 0 || n >= (setup.outputs || []).length) return false;
            selected = n;
            openEditor(n);
            return true;
        case "stream-output-connect": return !!editor && editor.connectClick();
        case "stream-output-own": return !!editor && editor.setOwn(p[1] === "1");
        }
        return false;
    }
}
