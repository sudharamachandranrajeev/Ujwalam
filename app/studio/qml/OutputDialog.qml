// SPDX-License-Identifier: GPL-3.0-or-later
// Add / Edit output (the widget's OutputDialog, D327/D377): platform, name, canvas and, for a main-canvas output, its own
// bitrate. Bitrate and Resolution show what the output really sends: its own values when "Its own bitrate" is on, else the
// canvas encoder it shares (greyed out) with a line that says so. OK hands the output to the Stream page (draft); Save in
// Settings writes it.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: od
    objectName: "outputBox"
    required property var stream          // SettingsStream
    // Hidden test mode (never on screen): drawn inside the never-shown window, not as a window of its own.
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: true
    anchors.centerIn: parent
    width: 540
    title: adding ? "Add output" : "Edit output"
    closePolicy: Popup.CloseOnEscape

    property bool adding: true
    property int index: -1
    property var out: ({})
    property var conn: ({ on: false })
    property bool multi: false
    property var shared: ({})             // the canvas encoders this output uses unless it has its own: {kbps, pkbps, output}
    property string platformId: ""
    property string canvasId: "H"
    property string nameText: ""
    property bool own: false
    property int mineKbps: 0
    property string mineRes: ""

    readonly property var options: stream.options
    readonly property var platforms: options.platforms || []
    readonly property var platform: platforms.find(p => p.id === platformId) || ({})
    readonly property bool h: canvasId === "H"
    readonly property bool mine: h && own
    readonly property int sharedKbps: (h ? shared.kbps : shared.pkbps) || 0
    readonly property bool connectOn: conn.on === true
    readonly property bool hasRow: !!conn.row && Object.keys(conn.row).length > 0
    readonly property var kb: stream.kb
    readonly property var platformModel: platforms.map(p => ({ value: p.id, text: p.label }))
    readonly property var canvasModel: (platform.canvases || []).map(c => ({ value: c,
        text: c === "V" ? "Portrait canvas (9:16)" + (multi ? "" : ", needs Main + portrait") : "Main canvas (16:9)" }))
    readonly property var resModel: stream.resModel
    readonly property string bitrateNote: mine ? "This output gets its own encoder at this bitrate (one more encoder session while live)."
        : h ? "Sends the main canvas stream: " + sharedKbps + " kbps, set under VIDEO (Main canvas bitrate). Tick \"Its own bitrate\" to give this output a different one."
        : "Sends the portrait canvas stream: " + sharedKbps + " kbps, set under VIDEO (Portrait canvas bitrate)."
    readonly property string connectLabel: box().flagLabel("platform-connect")
    readonly property string connectTip: !connectOn ? "Switch on " + connectLabel + " (Settings > Connections) to sign in or paste the stream key from Ujwalam."
        : !hasRow ? "Save this output first (click OK, then Save in Settings), then open it again to connect it."
        : "Sign in to the platform, or paste the stream key, for this output."
    readonly property string connectStatus: !connectOn
        ? "Sign-in and connection status need " + connectLabel + " (Settings > Connections). The stream key is kept in Windows Credential Manager under the name shown below."
        : !hasRow ? "Not connected. Save this output first (click OK, then Save in Settings), then open it again to connect it."
        : stream.stateText(conn.row)

    component Words: Text {
        color: Theme.c.text
        font.family: Theme.family
        font.pixelSize: 14
    }
    component Quiet: Text {
        width: parent ? parent.width : 0
        wrapMode: Text.Wrap
        textFormat: Text.PlainText
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: 13
    }

    function box() { return stream.box }

    function ask(i, c) {
        const outs = stream.setup.outputs || [];
        index = i;
        adding = i < 0;
        out = adding ? {} : outs[i];
        conn = c;
        multi = stream.multi;
        const v = stream.video;
        shared = { kbps: v.bitrateKbps, pkbps: v.portraitBitrateKbps, output: v.output };
        const ov = out.video || {};
        own = Object.keys(ov).length > 0;
        // Its own values when it has them; otherwise the shared ones are where ticking the box starts (never a made-up
        // default: the box once showed 6000 for an output that streams at the main canvas bitrate).
        mineKbps = typeof ov.bitrateKbps === "number" ? ov.bitrateKbps : (typeof shared.kbps === "number" ? shared.kbps : 6000);
        mineRes = ov.output || shared.output || "1080p";
        platformId = out.platform || (platforms.length ? platforms[0].id : "");
        canvasId = out.canvas || "H";
        fixCanvas();
        nameText = out.name !== undefined && out.name !== "" ? out.name : (platform.label || "");
        open();
    }

    function fixCanvas() {
        const list = platform.canvases || [];
        if (!list.includes(canvasId)) canvasId = list.length ? list[0] : "H";
    }
    function setPlatform(id) {
        platformId = id;
        fixCanvas();
        nameText = platform.label || ""; // only a new output can change its platform: the name follows it
    }

    // The output as the setup holds it; id stays for an edit, a new one gets one from the page.
    function value() {
        const o = Object.assign({}, out);
        o.platform = platformId;
        const nm = nameText.trim();
        o.name = nm === "" ? (platform.label || platformId) : nm.slice(0, 60);
        o.canvas = canvasId;
        if (o.enabled === undefined) o.enabled = true;
        if (own && canvasId === "H") o.video = { output: mineRes, bitrateKbps: mineKbps };
        else delete o.video;
        return o;
    }
    function commit() {
        const o = value();
        close();
        stream.applyOutput(index, o);
    }

    // Connect: the sign-in flow is in Settings > Connections.
    function connectClick() {
        if (!visible || !connectButton.enabled) return false;
        close();
        box().page = "Connections";
        return true;
    }
    function setOwn(on) {
        if (!visible || !ownSwitch.enabled) return false;
        own = on;
        return true;
    }
    function probe() {
        if (!visible) return {};
        return {
            connectButton: { enabled: connectButton.enabled, tooltip: connectButton.tip, status: connectStatusText.text },
            outputBitrate: { kbps: bitrate.value, enabled: bitrate.enabled, own: ownSwitch.checked, note: bitrateNoteText.text }
        };
    }

    background: Rectangle {
        color: Theme.c.panel
        radius: Theme.radiusLarge
        border.width: 1
        border.color: Theme.c.border
    }
    header: Text {
        text: od.title
        padding: 18
        bottomPadding: 6
        color: Theme.c.text
        font.family: "Barlow"
        font.pixelSize: 18
        font.weight: Font.DemiBold
    }
    contentItem: Column {
        spacing: 8
        Words { text: "Platform" }
        UCombo {
            objectName: "outputPlatform"
            width: parent.width
            label: "Platform"
            enabled: od.adding // the output's id and its stored key follow the platform: a new output for another one
            model: od.platformModel
            currentIndex: Math.max(0, od.platformModel.findIndex(m => m.value === od.platformId))
            onChose: (v) => od.setPlatform(v)
        }
        Words { text: "Name" }
        UField {
            objectName: "outputName"
            width: parent.width
            label: "Name"
            maximumLength: 60
            text: od.nameText
            onTextEdited: od.nameText = text
        }
        Words { text: "Canvas" }
        UCombo {
            objectName: "outputCanvas"
            width: parent.width
            label: "Canvas"
            model: od.canvasModel
            currentIndex: Math.max(0, od.canvasModel.findIndex(m => m.value === od.canvasId))
            onChose: (v) => od.canvasId = v
        }
        USwitch {
            id: ownSwitch
            objectName: "outputOwnBitrate"
            width: parent.width
            text: "Its own bitrate (an extra encoder, from the main canvas)"
            enabled: od.h
            checked: od.own
            onToggled: od.own = checked
        }
        Words { visible: od.h; text: "Resolution" }
        UCombo {
            objectName: "outputResolution"
            visible: od.h // the portrait canvas has its own size; this list holds the main canvas sizes
            width: parent.width
            label: "Resolution"
            enabled: od.mine
            model: od.resModel
            currentIndex: Math.max(0, od.resModel.findIndex(m => m.value === (od.mine ? od.mineRes : (od.shared.output || od.mineRes))))
            onChose: (v) => { if (od.mine) od.mineRes = v }
        }
        Words { text: "Bitrate" }
        USpin {
            id: bitrate
            objectName: "outputBitrate"
            label: "Bitrate"
            suffix: " kbps"
            enabled: od.mine
            from: od.kb.min
            to: od.kb.max
            stepSize: od.kb.step
            value: od.mine ? od.mineKbps : od.sharedKbps
            onValueModified: { if (od.mine) od.mineKbps = value }
        }
        Quiet { id: bitrateNoteText; objectName: "outputBitrateNote"; text: od.bitrateNote }

        Words { text: "ACCOUNT" ; font.pixelSize: 11; font.weight: Font.Bold; font.letterSpacing: 1; color: Theme.c.muted; topPadding: 6 }
        Row {
            width: parent.width
            spacing: 10
            UButton {
                id: connectButton
                objectName: "outputConnect"
                anchors.verticalCenter: parent.verticalCenter
                text: "Connect"
                enabled: od.connectOn && od.hasRow
                tip: od.connectTip
                onClicked: od.connectClick()
            }
            Quiet {
                id: connectStatusText
                objectName: "outputConnectStatus"
                width: parent.width - connectButton.width - parent.spacing
                anchors.verticalCenter: parent.verticalCenter
                text: od.connectStatus
            }
        }
        Quiet { text: "Key name: Ujwalam/stream/" + (od.out.id !== undefined ? od.out.id : "(new)") }
    }
    footer: Item {
        implicitHeight: 64
        Row {
            anchors { right: parent.right; rightMargin: 18; verticalCenter: parent.verticalCenter }
            spacing: 10
            UButton { objectName: "outputCancel"; text: "Cancel"; onClicked: od.close() }
            UButton { objectName: "outputOk"; text: "OK"; kind: "primary"; onClicked: od.commit() }
        }
    }
}
