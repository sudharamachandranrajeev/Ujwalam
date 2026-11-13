// SPDX-License-Identifier: GPL-3.0-or-later
// A square icon-only button. tip is required: it is the tooltip and the accessible name.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Button {
    id: b
    property string iconName: ""
    property string iconToken: "text"
    property string tip: ""
    property int size: 28
    implicitWidth: size
    implicitHeight: size
    padding: 0
    hoverEnabled: true
    focusPolicy: Qt.StrongFocus
    Accessible.name: tip
    ToolTip.visible: tip !== "" && hovered
    ToolTip.text: tip
    ToolTip.delay: 500
    contentItem: Item {
        Image {
            anchors.centerIn: parent
            width: 16
            height: 16
            source: b.iconName !== "" ? Theme.icon(b.iconName, b.enabled ? b.iconToken : "disabled", 16) : ""
        }
    }
    background: Rectangle {
        radius: Theme.radiusSmall
        color: b.down ? Theme.c.border : b.hovered || b.checked ? Theme.c.field : "transparent"
        border.width: b.visualFocus ? 1 : 0
        border.color: Theme.c.accentHi
    }
}
