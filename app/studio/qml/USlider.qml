// SPDX-License-Identifier: GPL-3.0-or-later
// A themed slider. committed(value) fires once the user is done (released, or 300 ms after the last key), as the
// widget studio's ValueSlider (D330): a drag sends one change, not one per pixel.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Slider {
    id: s
    signal committed(real value)
    property real meter: 0 // 0..1, drawn in the groove (the channel's level)
    implicitHeight: 24
    hoverEnabled: true
    focusPolicy: Qt.StrongFocus
    onPressedChanged: if (!pressed) s.committed(s.value)
    onMoved: if (!pressed) keyTimer.restart()
    Timer { id: keyTimer; interval: 300; onTriggered: s.committed(s.value) }
    background: Rectangle {
        x: s.leftPadding
        y: s.topPadding + s.availableHeight / 2 - height / 2
        width: s.availableWidth
        height: 6
        radius: 3
        color: Theme.c.field
        border.width: 1
        border.color: Theme.c.border
        Rectangle { // level
            width: Math.max(0, Math.min(1, s.meter)) * parent.width
            height: parent.height
            radius: 3
            color: s.meter > 0.95 ? Theme.c.danger : Theme.c.ok
            opacity: 0.85
        }
    }
    handle: Rectangle {
        x: s.leftPadding + s.visualPosition * (s.availableWidth - width)
        y: s.topPadding + s.availableHeight / 2 - height / 2
        width: 16
        height: 16
        radius: 8
        color: s.pressed ? Theme.c.accentHi : Theme.c.accent
        border.width: s.visualFocus ? 2 : 0
        border.color: Theme.c.text
    }
}
