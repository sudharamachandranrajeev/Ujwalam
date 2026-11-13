// SPDX-License-Identifier: GPL-3.0-or-later
// One surface per panel (plan: Style): the panel colour, one border, a heading row with optional tools on the right.
// Anchors only (no layout), so the frame is placed even in a window that is never shown (hidden test mode).
import QtQuick
import Ujwalam.Core

Rectangle {
    id: p
    property string title: ""
    default property alias content: body.data
    property alias tools: toolRow.data
    color: Theme.c.panel
    radius: Theme.radiusLarge
    border.width: 1
    border.color: Theme.c.border

    Item {
        id: head
        anchors { left: parent.left; right: parent.right; top: parent.top; leftMargin: 14; rightMargin: 10; topMargin: 8 }
        height: p.title !== "" ? 30 : 0
        visible: p.title !== ""
        Text {
            anchors { left: parent.left; verticalCenter: parent.verticalCenter }
            text: p.title
            color: Theme.c.text
            font.family: "Barlow"
            font.pixelSize: 15
            font.weight: Font.DemiBold
        }
        Row {
            id: toolRow
            anchors { right: parent.right; verticalCenter: parent.verticalCenter }
            spacing: 4
        }
    }
    Item {
        id: body
        anchors { left: parent.left; right: parent.right; top: head.bottom; bottom: parent.bottom; margins: 10; topMargin: p.title !== "" ? 6 : 10 }
    }
}
