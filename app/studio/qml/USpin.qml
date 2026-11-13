// SPDX-License-Identifier: GPL-3.0-or-later
// A whole-number box with - and + (the widget's QSpinBox): suffix is the unit shown after the number (" s", " kills").
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

SpinBox {
    id: sp
    property string suffix: ""
    property string label: ""
    editable: true
    implicitWidth: 132
    implicitHeight: 32
    font.family: Theme.family
    font.pixelSize: 14
    Accessible.name: label
    textFromValue: (v) => v + suffix
    valueFromText: (t) => parseInt(String(t).replace(/[^0-9-]/g, ""), 10) || 0
    contentItem: TextInput {
        text: sp.textFromValue(sp.value, sp.locale)
        font: sp.font
        color: sp.enabled ? Theme.c.text : Theme.c.disabled
        selectionColor: Theme.c.accent
        selectedTextColor: Theme.c.onAccent
        horizontalAlignment: Qt.AlignHCenter
        verticalAlignment: Qt.AlignVCenter
        readOnly: !sp.editable
        validator: sp.validator
        inputMethodHints: Qt.ImhFormattedNumbersOnly
    }
    up.indicator: Rectangle {
        x: sp.width - width
        height: sp.height
        implicitWidth: 30
        color: sp.up.pressed ? Qt.darker(Theme.c.field, 1.2) : Theme.c.field
        border.width: 1
        border.color: Theme.c.border
        radius: Theme.radiusSmall
        Text { anchors.centerIn: parent; text: "+"; color: sp.enabled ? Theme.c.text : Theme.c.disabled; font.pixelSize: 16 }
    }
    down.indicator: Rectangle {
        x: 0
        height: sp.height
        implicitWidth: 30
        color: sp.down.pressed ? Qt.darker(Theme.c.field, 1.2) : Theme.c.field
        border.width: 1
        border.color: Theme.c.border
        radius: Theme.radiusSmall
        Text { anchors.centerIn: parent; text: "-"; color: sp.enabled ? Theme.c.text : Theme.c.disabled; font.pixelSize: 16 }
    }
    background: Rectangle {
        radius: Theme.radiusSmall
        color: Theme.c.field
        border.width: 1
        border.color: sp.activeFocus ? Theme.c.accentHi : Theme.c.border
        opacity: sp.enabled ? 1 : 0.6
    }
}
