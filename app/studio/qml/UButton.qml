// SPDX-License-Identifier: GPL-3.0-or-later
// A labelled button in theme tokens (plan: Style). kind: "normal" | "primary" (accent fill) | "danger" (danger fill,
// for the controls that are on: LIVE, recording). An optional icon from the shared icon set (icons.cpp) sits before
// the label.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Button {
    id: b
    property string kind: "normal"
    property string iconName: ""
    property string tip: ""
    readonly property color fill: kind === "primary" ? Theme.c.accent : kind === "danger" ? Theme.c.danger : Theme.c.field
    readonly property color ink: kind === "normal" ? Theme.c.text : Theme.c.onAccent

    implicitHeight: 34
    leftPadding: 14
    rightPadding: 14
    font.family: Theme.family
    font.pixelSize: 14
    font.weight: kind === "normal" ? Font.Normal : Font.DemiBold
    hoverEnabled: true
    focusPolicy: Qt.StrongFocus
    Accessible.name: text
    ToolTip.visible: tip !== "" && hovered
    ToolTip.text: tip
    ToolTip.delay: 500

    contentItem: Row {
        spacing: 8
        Image {
            visible: b.iconName !== ""
            anchors.verticalCenter: parent.verticalCenter
            source: b.iconName !== "" ? Theme.icon(b.iconName, b.enabled ? b.ink.toString() : Theme.c.disabled.toString(), 16) : ""
            width: 16
            height: 16
        }
        Text {
            anchors.verticalCenter: parent.verticalCenter
            text: b.text
            font: b.font
            color: b.enabled ? b.ink : Theme.c.disabled
        }
    }
    background: Rectangle {
        radius: Theme.radiusMedium
        color: !b.enabled ? Theme.c.field : b.down ? Qt.darker(b.fill, 1.15) : b.hovered ? Qt.lighter(b.fill, 1.12) : b.fill
        border.width: b.kind === "normal" || b.visualFocus ? 1 : 0
        border.color: b.visualFocus ? Theme.c.accentHi : Theme.c.border
        opacity: b.enabled ? 1 : 0.6
        Behavior on color { enabled: Theme.motion; ColorAnimation { duration: Theme.fast } }
    }
}
