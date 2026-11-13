// SPDX-License-Identifier: GPL-3.0-or-later
// Scenes (plan Q2): one card per scene, the active one marked in words and colour. A click switches to it (scene
// switches stay instant while live, server HOST_CALLS). Add is the + in the heading; each other scene's card has its own
// delete button (the active scene is never deleted: switch first). Rename and duplicate come with the scene builder (Q4).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

UPanel {
    id: panel
    required property var store
    title: "Scenes"
    tools: [
        UIconButton {
            objectName: "addScene"
            iconName: "plus"
            tip: panel.store.live ? "Add scene (not while live)" : "Add scene"
            onClicked: panel.store.addScene()
        }
    ]

    ListView {
        id: list
        objectName: "sceneList"
        anchors.fill: parent
        clip: true
        spacing: 6
        model: panel.store.scenes
        boundsBehavior: Flickable.StopAtBounds
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
        Accessible.role: Accessible.List
        Accessible.name: "Scenes"
        delegate: ItemDelegate {
            id: card
            required property var modelData
            required property int index
            readonly property bool active: modelData.id === panel.store.activeScene
            objectName: "scene:" + modelData.id
            width: ListView.view.width - 4
            height: 52
            hoverEnabled: true
            Accessible.name: modelData.name + (active ? ", active" : "")
            onClicked: if (!active) panel.store.activateScene(modelData.id)
            background: Rectangle {
                radius: Theme.radiusMedium
                color: card.active ? Qt.alpha(Theme.c.accent, 0.18) : card.hovered ? Theme.c.field : "transparent"
                border.width: card.active ? 1 : 0
                border.color: Theme.c.accent
            }
            contentItem: Item {
                UIconButton {
                    id: del
                    objectName: "deleteScene:" + card.modelData.id
                    visible: !card.active && (card.hovered || card.visualFocus || del.hovered || del.visualFocus)
                    anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                    iconName: "trash"
                    iconToken: "danger"
                    // Enabled even when it cannot delete: the click says why in the status line (a disabled button
                    // shows no tooltip).
                    tip: panel.store.live ? "Delete scene (not while live)"
                       : !panel.store.sceneEdit ? "Delete scene (turn on scene editing in Settings > Editing first)"
                       : "Delete “" + card.modelData.name + "”"
                    onClicked: panel.store.deleteScene(card.modelData.id)
                }
                Text {
                    id: nameText
                    anchors { left: parent.left; right: del.visible ? del.left : parent.right; rightMargin: del.visible ? 4 : 0; top: parent.top; topMargin: 2 }
                    text: card.modelData.name
                    elide: Text.ElideRight
                    color: Theme.c.text
                    font.family: Theme.family
                    font.pixelSize: 14
                    font.weight: card.active ? Font.DemiBold : Font.Normal
                }
                Text {
                    anchors { left: parent.left; right: parent.right; top: nameText.bottom; topMargin: 2 }
                    text: (card.active ? "Active  ·  " : "") + card.modelData.canvases.map(c => c.toUpperCase()).join(" + ")
                    elide: Text.ElideRight
                    color: card.active ? Theme.c.accentHi : Theme.c.muted
                    font.family: Theme.family
                    font.pixelSize: 12
                }
            }
        }
    }
    Text {
        anchors.centerIn: parent
        visible: panel.store.scenes.length === 0
        text: panel.store.hostUp ? "No scenes in this project" : "Waiting for the host..."
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: 13
    }
}
