// SPDX-License-Identifier: GPL-3.0-or-later
// Layers of the active scene (plan Q2), top layer first. Each row: a real eye icon that shows or hides the layer (its
// own button, with a tooltip and an accessible name), the name in full width, and a second line when a capture
// layer's device is waiting or connecting (D329, the host's sentence as the tooltip). A click selects the layer; the
// preview's mouse then edits it (D335 F8). H and V switch the canvas when the scene has both. Add and Delete sit in the
// heading (one place, plan Q2); Del deletes the selected layer too. Neither needs a flag, only "not live" (D330).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

UPanel {
    id: panel
    required property var store
    title: "Layers"
    tools: [
        UToggle {
            objectName: "canvasH"
            visible: panel.store.bothCanvases
            text: "H"
            checked: panel.store.canvas === "h"
            tip: "Layers of the horizontal canvas"
            onClicked: { checked = Qt.binding(() => panel.store.canvas === "h"); panel.store.showCanvas("h") }
        },
        UToggle {
            objectName: "canvasV"
            visible: panel.store.bothCanvases
            text: "V"
            checked: panel.store.canvas === "v"
            tip: "Layers of the vertical canvas"
            onClicked: { checked = Qt.binding(() => panel.store.canvas === "v"); panel.store.showCanvas("v") }
        },
        UIconButton {
            objectName: "addLayer"
            iconName: "plus"
            tip: panel.store.live ? "Add layer (not while live)" : "Add layer"
            onClicked: panel.store.addLayer("")
        },
        UIconButton {
            objectName: "deleteLayer"
            iconName: "trash"
            iconToken: "danger"
            enabled: panel.store.selectedLayer !== null
            tip: panel.store.live ? "Delete layer (not while live)" : "Delete the selected layer (Del)"
            onClicked: panel.store.deleteLayer()
        }
    ]

    ListView {
        id: list
        objectName: "layerList"
        anchors.fill: parent
        clip: true
        spacing: 2
        model: panel.store.layers.slice().reverse()
        boundsBehavior: Flickable.StopAtBounds
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
        Accessible.role: Accessible.List
        Accessible.name: "Layers"
        Keys.onDeletePressed: panel.store.deleteLayer() // from a focused row too: unhandled keys reach the list
        delegate: ItemDelegate {
            id: row
            required property var modelData
            readonly property bool sel: modelData.id === panel.store.selected
            readonly property var dev: modelData.device || {}
            readonly property bool waiting: dev.state === "waiting"
            readonly property bool connecting: dev.state === "connecting"
            objectName: "layer:" + modelData.id
            width: ListView.view.width - 4
            height: waiting || connecting ? 48 : 36
            hoverEnabled: true
            Accessible.name: modelData.name + (modelData.visible ? "" : ", hidden") + (sel ? ", selected" : "")
            onClicked: panel.store.select(modelData.id)
            ToolTip.visible: (waiting || connecting) && hovered && !!dev.message
            ToolTip.text: dev.message || ""
            ToolTip.delay: 500
            background: Rectangle {
                radius: Theme.radiusSmall
                color: row.sel ? Qt.alpha(Theme.c.accent, 0.2) : row.hovered ? Theme.c.field : "transparent"
                border.width: row.sel ? 1 : 0
                border.color: Theme.c.accent
            }
            contentItem: Item {
                UIconButton {
                    id: eye
                    objectName: "eye:" + row.modelData.id
                    anchors { left: parent.left; verticalCenter: parent.verticalCenter }
                    iconName: row.modelData.visible ? "eye" : "eye-off"
                    iconToken: row.modelData.visible ? "text" : "muted"
                    tip: row.modelData.visible ? "Hide this layer" : "Show this layer"
                    onClicked: panel.store.setVisible(row.modelData.id, !row.modelData.visible)
                }
                Text {
                    id: name
                    anchors { left: eye.right; leftMargin: 8; right: parent.right; top: parent.top; topMargin: row.waiting || row.connecting ? 4 : 0 }
                    height: row.waiting || row.connecting ? implicitHeight : parent.height
                    verticalAlignment: Text.AlignVCenter
                    text: row.modelData.name
                    elide: Text.ElideRight
                    color: row.modelData.visible && !row.waiting ? Theme.c.text : Theme.c.muted
                    font.family: Theme.family
                    font.pixelSize: 14
                }
                Text {
                    visible: row.waiting || row.connecting
                    anchors { left: name.left; right: parent.right; top: name.bottom; topMargin: 1 }
                    text: row.waiting ? "Waiting for the device" : "Connecting to the device"
                    elide: Text.ElideRight
                    color: row.waiting ? Theme.c.danger : Theme.c.muted
                    font.family: Theme.family
                    font.pixelSize: 12
                }
            }
        }
    }
    Text {
        anchors.centerIn: parent
        visible: panel.store.layers.length === 0 && panel.store.activeScene !== ""
        text: "This scene has no layers"
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: 13
    }
}
