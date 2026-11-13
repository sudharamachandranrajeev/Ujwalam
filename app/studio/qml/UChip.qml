// SPDX-License-Identifier: GPL-3.0-or-later
// A status chip: plain text on the field colour; "on" fills it (LIVE, recording) in the given token colour.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Rectangle {
    id: c
    property string text: ""
    property bool on: false
    property string token: "danger"
    property string tip: ""
    implicitWidth: label.implicitWidth + 20
    implicitHeight: 26
    radius: height / 2
    color: on ? Theme.c[token] : Theme.c.field
    border.width: on ? 0 : 1
    border.color: Theme.c.border
    Accessible.role: Accessible.StaticText
    Accessible.name: text
    Text {
        id: label
        anchors.centerIn: parent
        text: c.text
        color: c.on ? Theme.c.onAccent : Theme.c.text
        font.family: "Barlow"
        font.pixelSize: 13
        font.weight: c.on ? Font.Bold : Font.Medium
    }
    HoverHandler { id: hov }
    ToolTip.visible: c.tip !== "" && hov.hovered
    ToolTip.text: c.tip
    ToolTip.delay: 500
}
