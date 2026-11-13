// SPDX-License-Identifier: GPL-3.0-or-later
// A one-line text field in theme tokens (plan: Style). label is the accessible name when no placeholder says it.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

TextField {
    id: f
    property string label: ""
    implicitHeight: 34
    leftPadding: 10
    rightPadding: 10
    color: Theme.c.text
    placeholderTextColor: Theme.c.muted
    selectionColor: Theme.c.accent
    selectedTextColor: Theme.c.onAccent
    font.family: Theme.family
    font.pixelSize: 14
    selectByMouse: true
    Accessible.name: label !== "" ? label : placeholderText
    background: Rectangle {
        radius: Theme.radiusSmall
        color: Theme.c.field
        border.width: 1
        border.color: f.activeFocus ? Theme.c.accentHi : Theme.c.border
    }
}
