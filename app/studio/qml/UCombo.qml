// SPDX-License-Identifier: GPL-3.0-or-later
// A drop-down list in theme tokens (the widget's QComboBox). model: [{value, text}]; value is the chosen item's value.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

ComboBox {
    id: cb
    property string label: ""
    readonly property var value: currentIndex >= 0 && model && model.length > currentIndex ? model[currentIndex].value : undefined
    function pick(v) { for (let i = 0; i < (model ? model.length : 0); i++) if (model[i].value === v) { currentIndex = i; return true } return false }
    // The user picked an item (not a change made by a binding): its value.
    signal chose(var v)
    onActivated: (i) => { if (model && i >= 0 && i < model.length) chose(model[i].value) }
    textRole: "text"
    implicitHeight: 34
    font.family: Theme.family
    font.pixelSize: 14
    Accessible.name: label
    // ComboBox has no "text" property: the probe reads the shown words from displayText through this one.
    readonly property string text: displayText
    contentItem: Text {
        leftPadding: 10
        rightPadding: 28
        text: cb.displayText
        font: cb.font
        color: cb.enabled ? Theme.c.text : Theme.c.disabled
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
    }
    indicator: Text {
        x: cb.width - width - 10
        y: (cb.height - height) / 2
        text: "▾"
        color: Theme.c.muted
        font.pixelSize: 14
    }
    background: Rectangle {
        radius: Theme.radiusSmall
        color: Theme.c.field
        border.width: 1
        border.color: cb.visualFocus || cb.popup.visible ? Theme.c.accentHi : Theme.c.border
    }
    delegate: ItemDelegate {
        required property var modelData
        required property int index
        width: cb.width
        highlighted: cb.highlightedIndex === index
        contentItem: Text {
            text: modelData.text
            font: cb.font
            color: Theme.c.text
            elide: Text.ElideRight
            verticalAlignment: Text.AlignVCenter
        }
        background: Rectangle { color: highlighted ? Theme.c.field : Theme.c.panel }
    }
    popup.background: Rectangle {
        color: Theme.c.panel
        border.width: 1
        border.color: Theme.c.border
        radius: Theme.radiusSmall
    }
}
