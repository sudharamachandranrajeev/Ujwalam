// SPDX-License-Identifier: GPL-3.0-or-later
// The two previews (plan Q2): H (16:9) and V (9:16) at the same height, each the host's own window placed over a
// PreviewView (qml_bridge.h). Nothing QML-drawn may lie over them (a native window covers it), so the captions sit
// above and the messages show only while no preview is embedded. Anchors and computed sizes only, no layouts: the
// rectangles are known in a window that is never shown too (hidden test mode), so the host can embed there.
import QtQuick
import Ujwalam.Core

Item {
    id: area
    required property var store
    readonly property int gap: 12
    readonly property int caption: 22
    // the tallest height at which both fit side by side
    readonly property real ph: Math.max(0, Math.min(height - caption, (width - gap) / (16 / 9 + 9 / 16)))
    readonly property real hw: Math.floor(ph * 16 / 9)
    readonly property real vw: Math.floor(ph * 9 / 16)
    readonly property real left0: Math.floor((width - hw - vw - gap) / 2)

    Connections {
        target: area.store
        function onHostRestarted() { prevH.reembed(); prevV.reembed() }
    }

    Repeater {
        model: [
            { canvas: "h", title: "Horizontal", x: area.left0, w: area.hw },
            { canvas: "v", title: "Vertical", x: area.left0 + area.hw + area.gap, w: area.vw }
        ]
        Text {
            required property var modelData
            x: modelData.x
            y: 0
            width: modelData.w
            height: area.caption
            text: modelData.title
            elide: Text.ElideRight
            color: Theme.c.muted
            font.family: "Barlow"
            font.pixelSize: 13
            font.weight: Font.DemiBold
        }
    }

    Rectangle {
        id: frameH
        x: area.left0
        y: area.caption
        width: area.hw
        height: Math.floor(area.ph)
        color: "#0a090e" // the preview surface stays dark in every theme (qml_bridge.cpp)
        radius: 2
        PreviewView { id: prevH; objectName: "previewH"; anchors.fill: parent; canvas: "h" }
        Text {
            anchors.centerIn: parent
            width: parent.width - 24
            visible: !prevH.embedded
            text: prevH.message
            wrapMode: Text.Wrap
            horizontalAlignment: Text.AlignHCenter
            color: "#b8b4c4"
            font.family: Theme.family
            font.pixelSize: 13
        }
    }
    Rectangle {
        id: frameV
        x: area.left0 + area.hw + area.gap
        y: area.caption
        width: area.vw
        height: Math.floor(area.ph)
        color: "#0a090e"
        radius: 2
        PreviewView { id: prevV; objectName: "previewV"; anchors.fill: parent; canvas: "v" }
        Text {
            anchors.centerIn: parent
            width: parent.width - 16
            visible: !prevV.embedded
            text: prevV.message
            wrapMode: Text.Wrap
            horizontalAlignment: Text.AlignHCenter
            color: "#b8b4c4"
            font.family: Theme.family
            font.pixelSize: 12
        }
    }
}
