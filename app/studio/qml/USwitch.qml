// SPDX-License-Identifier: GPL-3.0-or-later
// A switch with its words beside it (the widget's Switch row, N2): the track says ON or OFF, so the state reads as words,
// not only as a colour (UI feel feedback). text is the label; hint (optional) is a muted line under it.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Switch {
    id: s
    property string hint: ""
    // false: the words keep their own width (a switch inside a row, with no width given); true: they wrap to the width
    property bool wrap: true
    hoverEnabled: true
    focusPolicy: Qt.StrongFocus
    spacing: 12
    padding: 0
    font.family: Theme.family
    font.pixelSize: 14
    Accessible.name: text
    indicator: Rectangle {
        x: s.leftPadding
        y: s.topPadding + 2
        implicitWidth: 52
        implicitHeight: 24
        radius: 12
        color: s.checked ? Theme.c.accent : Theme.c.field
        border.width: s.checked && !s.visualFocus ? 0 : 1
        border.color: s.visualFocus ? Theme.c.accentHi : Theme.c.border
        opacity: s.enabled ? 1 : 0.5
        Text {
            anchors { verticalCenter: parent.verticalCenter; left: s.checked ? parent.left : undefined; right: s.checked ? undefined : parent.right; leftMargin: 8; rightMargin: 7 }
            text: s.checked ? "ON" : "OFF"
            color: s.checked ? Theme.c.onAccent : Theme.c.muted
            font.family: Theme.family
            font.pixelSize: 10
            font.weight: Font.Bold
        }
        Rectangle {
            width: 18
            height: 18
            radius: 9
            y: 3
            x: s.checked ? parent.width - width - 3 : 3
            color: s.checked ? Theme.c.onAccent : Theme.c.muted
            Behavior on x { enabled: Theme.motion; NumberAnimation { duration: Theme.fast } }
        }
    }
    contentItem: Column {
        leftPadding: s.indicator.width + s.spacing
        spacing: 2
        Text {
            width: s.wrap ? Math.max(0, s.availableWidth - parent.leftPadding) : implicitWidth
            text: s.text
            wrapMode: Text.Wrap
            color: s.enabled ? Theme.c.text : Theme.c.disabled
            font: s.font
        }
        Text {
            visible: s.hint !== ""
            width: s.wrap ? Math.max(0, s.availableWidth - parent.leftPadding) : implicitWidth
            text: s.hint
            wrapMode: Text.Wrap
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: 13
        }
    }
}
