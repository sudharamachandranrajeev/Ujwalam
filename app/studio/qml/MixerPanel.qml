// SPDX-License-Identifier: GPL-3.0-or-later
// The mixer (plan Q2): one strip per sound with its full name, CUE (hear it in the headphones), Mute, the track
// buttons when routing is on (D273), the level and the volume. Volume, mute and CUE are saved into the project (D358).
// A sound that is in no stream mix (layer sound off) is listed by name under the strips, as in the widget studio.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

UPanel {
    id: panel
    required property var store
    title: "Audio mixer"

    // With routing on, a sound with a project audio entry stays listed on no track, so it can be put back.
    readonly property var strips: store.mixer.filter(m => (store.routing && typeof m.audioSource === "string") || m.mixers === undefined || m.mixers !== 0)
    readonly property var offMix: store.mixer.filter(m => !strips.includes(m)).map(m => m.name)

    function level(db) { return typeof db === "number" ? Math.max(0, Math.min(1, (db + 60) / 60)) : 0 }

    ListView {
        id: list
        objectName: "mixerStrips"
        anchors { left: parent.left; right: parent.right; top: parent.top; bottom: offText.visible ? offText.top : parent.bottom; bottomMargin: offText.visible ? 4 : 0 }
        orientation: ListView.Horizontal
        clip: true
        spacing: 10
        model: panel.strips
        boundsBehavior: Flickable.StopAtBounds
        ScrollBar.horizontal: ScrollBar { policy: ScrollBar.AsNeeded }
        Accessible.role: Accessible.List
        Accessible.name: "Audio mixer"
        delegate: Rectangle {
            id: strip
            required property var modelData
            readonly property string sid: modelData.id
            readonly property bool routable: panel.store.routing && typeof modelData.audioSource === "string"
            objectName: "strip:" + sid
            width: 280
            height: ListView.view.height - 12
            radius: Theme.radiusMedium
            color: Theme.c.field
            border.width: 1
            border.color: Theme.c.border

            Text {
                id: label
                objectName: "stripName:" + strip.sid
                anchors { left: parent.left; right: buttons.left; top: parent.top; margins: 10; rightMargin: 8 }
                text: strip.modelData.name
                wrapMode: Text.Wrap
                maximumLineCount: 2
                elide: Text.ElideRight
                color: Theme.c.text
                font.family: Theme.family
                font.pixelSize: 14
                font.weight: Font.DemiBold
            }
            Row {
                id: buttons
                anchors { right: parent.right; top: parent.top; margins: 8 }
                spacing: 6
                UToggle {
                    objectName: "cue:" + strip.sid
                    text: "CUE"
                    checked: strip.modelData.cue === true
                    tip: strip.modelData.cueDelayed ? "Hear this in the headphones. This channel has video: its headphone sound is delayed to match the picture."
                                                    : "Hear this in the headphones"
                    onClicked: panel.store.setCue(strip.sid, checked)
                }
                UToggle {
                    objectName: "mute:" + strip.sid
                    text: checked ? "Muted" : "Mute"
                    onToken: "danger"
                    checked: strip.modelData.muted === true
                    tip: checked ? "Unmute: the stream and the recording hear it again" : "Mute: the stream and the recording do not hear it"
                    onClicked: panel.store.setMute(strip.sid, checked)
                }
            }
            Row {
                id: trackRow
                visible: strip.routable
                anchors { left: parent.left; right: parent.right; top: label.bottom; margins: 10; topMargin: 6 }
                spacing: 4
                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: "Tracks"
                    color: Theme.c.muted
                    font.family: Theme.family
                    font.pixelSize: 12
                }
                Repeater {
                    model: strip.routable ? panel.store.tracks : []
                    UToggle {
                        required property var modelData
                        required property int index
                        objectName: "track:" + strip.sid + ":" + modelData.id
                        text: modelData.name
                        checked: (strip.modelData.tracks || []).includes(modelData.id)
                        tip: index === 0 ? "Track 1: what the stream and the recording hear" : "Not used by the outputs yet"
                        onClicked: {
                            const on = strip.modelData.tracks || [];
                            const tid = modelData.id, want = checked;
                            // keep the project's track order
                            panel.store.setTracks(strip.sid, panel.store.tracks.map(t => t.id).filter(x => x === tid ? want : on.includes(x)));
                        }
                    }
                }
            }
            USlider {
                id: vol
                objectName: "vol:" + strip.sid
                anchors { left: parent.left; right: dbText.left; bottom: parent.bottom; margins: 10; rightMargin: 8 }
                from: -60
                to: 0
                stepSize: 1
                value: Math.max(-60, Math.min(0, typeof strip.modelData.volumeDb === "number" ? strip.modelData.volumeDb : 0))
                meter: panel.level(panel.store.peaks[strip.sid])
                Accessible.name: "Volume of " + strip.modelData.name
                onCommitted: (v) => panel.store.setVolume(strip.sid, v)
            }
            Text {
                id: dbText
                anchors { right: parent.right; rightMargin: 10; verticalCenter: vol.verticalCenter }
                width: 54
                horizontalAlignment: Text.AlignRight
                text: Math.round(vol.value) + " dB"
                color: Theme.c.muted
                font.family: "Barlow"
                font.pixelSize: 13
            }
        }
    }
    Text {
        id: offText
        anchors { left: parent.left; right: parent.right; bottom: parent.bottom }
        visible: panel.offMix.length > 0
        text: "Not in the stream mix (layer sound off): " + panel.offMix.join(", ") + "."
        wrapMode: Text.Wrap
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: 12
    }
}
