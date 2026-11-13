// SPDX-License-Identifier: GPL-3.0-or-later
// A small checkable button with its word on it (CUE, Mute, track names): the state is the fill, not only a shade of
// colour, so it reads at a glance (UI feel feedback: toggles with visible text).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Button {
    id: t
    checkable: true
    property string onToken: "accent"
    property string tip: ""
    implicitHeight: 26
    leftPadding: 10
    rightPadding: 10
    hoverEnabled: true
    focusPolicy: Qt.StrongFocus
    font.family: Theme.family
    font.pixelSize: 12
    font.weight: Font.DemiBold
    Accessible.name: text
    ToolTip.visible: tip !== "" && hovered
    ToolTip.text: tip
    ToolTip.delay: 500
    contentItem: Text {
        text: t.text
        font: t.font
        color: t.checked ? Theme.c.onAccent : t.enabled ? Theme.c.text : Theme.c.disabled
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
    }
    background: Rectangle {
        radius: Theme.radiusSmall
        color: t.checked ? Theme.c[t.onToken] : t.hovered ? Qt.lighter(Theme.c.field, 1.15) : Theme.c.field
        border.width: t.checked ? 0 : 1
        border.color: t.visualFocus ? Theme.c.accentHi : Theme.c.border
    }
}
