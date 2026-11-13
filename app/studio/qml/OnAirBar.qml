// SPDX-License-Identifier: GPL-3.0-or-later
// The on-air bar (plan Q2): LIVE state with its timer, the stream bitrate, recording with its timer, dropped frames and
// load, and the two labelled controls. Go live and Record use the widget studio's paths (store.hostAction: one click,
// D332; the server holds an action only for readiness problems).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Rectangle {
    id: bar
    required property var store
    color: Theme.c.panel
    border.width: 1
    border.color: Theme.c.border
    radius: Theme.radiusLarge

    // Timers tick every second between the 2 s status polls.
    property real now: Date.now()
    property real stamp: Date.now()
    Connections { target: bar.store; function onOnAirChanged() { bar.stamp = Date.now(); bar.now = bar.stamp } }
    Timer { interval: 1000; repeat: true; running: bar.store.live || bar.store.recording; onTriggered: bar.now = Date.now() }

    function clock(ms) {
        if (typeof ms !== "number" || ms < 0) return "0:00:00";
        const t = Math.floor((ms + (now - stamp)) / 1000);
        const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
        return h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
    }
    readonly property var oa: store.onAir || {}
    readonly property string mbps: typeof oa.kbps === "number" && oa.kbps > 0 ? (oa.kbps / 1000).toFixed(1) + " Mbps" : ""
    readonly property string sinkTip: Array.isArray(oa.sinks) ? oa.sinks.map(s => (s.platform || s.id) + ": " + s.state +
        (typeof s.kbps === "number" && s.kbps > 0 ? ", " + (s.kbps / 1000).toFixed(1) + " Mbps" : "")).join("\n") : ""

    Text {
        id: brand
        anchors { left: parent.left; leftMargin: 16; verticalCenter: parent.verticalCenter }
        text: "Ujwalam"
        color: Theme.c.text
        font.family: "Barlow"
        font.pixelSize: 20
        font.weight: Font.Bold
    }
    Text {
        id: sceneName
        objectName: "barScene"
        anchors { left: brand.right; leftMargin: 14; verticalCenter: parent.verticalCenter }
        width: Math.max(0, chips.x - x - 16)
        elide: Text.ElideRight
        text: bar.store.activeSceneObj ? bar.store.activeSceneObj.name : ""
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: 14
    }

    Row {
        id: chips
        anchors { right: controls.left; rightMargin: 16; verticalCenter: parent.verticalCenter }
        spacing: 8
        UChip {
            objectName: "chipLive"
            on: bar.store.live
            text: bar.store.live ? "LIVE  " + bar.clock(bar.oa.liveForMs) : "Offline"
            tip: bar.store.live ? bar.sinkTip : "Not streaming"
        }
        UChip {
            objectName: "chipBitrate"
            visible: bar.store.live && bar.mbps !== ""
            text: bar.mbps
            tip: bar.sinkTip
        }
        UChip {
            objectName: "chipRec"
            on: bar.store.recording
            text: bar.store.recording ? "REC  " + bar.clock(bar.oa.recordForMs) : "Not recording"
        }
        UChip {
            objectName: "chipStats"
            text: "Dropped " + bar.store.dropped + "  ·  " + bar.store.fps.toFixed(0) + " fps  ·  CPU " + bar.store.cpu.toFixed(0) + "%  ·  GPU " + bar.store.gpu.toFixed(0) + "%"
            on: bar.store.dropped > 0 && bar.store.live
            token: "danger"
            tip: "Frames dropped since the start, frames per second, and the load of this computer"
        }
    }

    Row {
        id: controls
        anchors { right: parent.right; rightMargin: 12; verticalCenter: parent.verticalCenter }
        spacing: 8
        UButton {
            objectName: "settingsBtn"
            text: "Settings"
            iconName: "gear"
            onClicked: bar.store.settingsWanted("")
        }
        UButton {
            objectName: "recordBtn"
            text: bar.store.recording ? "Stop recording" : "Record"
            iconName: bar.store.recording ? "stop" : "record"
            kind: bar.store.recording ? "danger" : "normal"
            enabled: bar.store.canRecord && !bar.store.actionBusy
            tip: enabled ? (bar.store.recording ? "Stop recording." : "Start recording to a file.") : "No recording output is set up in this start."
            onClicked: bar.store.toggleRecord()
        }
        UButton {
            objectName: "streamBtn"
            text: bar.store.live ? "End stream" : "Go live"
            iconName: bar.store.live ? "stop" : "play"
            kind: bar.store.live ? "danger" : "primary"
            enabled: bar.store.canStream && !bar.store.actionBusy
            // Say why the button is off (D281): no stream target unless Ujwalam was started for live.
            tip: enabled ? (bar.store.live ? "Stop the stream." : "Go live.")
                         : "Streaming needs the LIVE start: the \"Ujwalam (alpha)\" shortcut (not the practice one), or Ujwalam.cmd --live."
            onClicked: bar.store.toggleStream()
        }
    }
}
