// SPDX-License-Identifier: GPL-3.0-or-later
// A settings card (the widget's QGroupBox): a small capital heading and its rows in a column, as wide as the page.
import QtQuick
import Ujwalam.Core

Rectangle {
    id: card
    property string title: ""
    default property alias content: body.data
    width: parent ? parent.width : 0
    implicitHeight: body.implicitHeight + head.height + 30
    height: implicitHeight
    color: Theme.c.panel
    radius: Theme.radiusMedium
    border.width: 1
    border.color: Theme.c.border
    Text {
        id: head
        x: 14
        y: 12
        text: card.title
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: 11
        font.weight: Font.Bold
        font.letterSpacing: 1
    }
    Column {
        id: body
        x: 14
        y: head.y + head.height + 10
        width: card.width - 28
        spacing: 10
    }
}
