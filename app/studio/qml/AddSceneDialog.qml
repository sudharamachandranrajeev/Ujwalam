// SPDX-License-Identifier: GPL-3.0-or-later
// Add scene (the widget's AddSceneDialog): a name; the scene is made on every canvas of the project. The window only
// builds the scene.add body; Store.structureEdit sends it. Its own window (Popup.Window), above the native previews.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "addSceneBox"
    required property var store
    property var canvases: []
    // Hidden test mode (never on screen): drawn inside the never-shown window, not as a window of its own.
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: true
    anchors.centerIn: parent
    width: 440
    title: "Add scene"
    closePolicy: Popup.CloseOnEscape

    function ask(list) {
        canvases = Array.isArray(list) ? list : [];
        name.text = "";
        store.addOpen = true;
        open();
        name.forceActiveFocus();
    }
    onClosed: store.addOpen = false

    function send() {
        const n = name.text.trim();
        if (n === "") return;
        close();
        store.structureEdit({ op: "scene.add", name: n.slice(0, 80) });
    }

    background: Rectangle {
        color: Theme.c.panel
        radius: Theme.radiusLarge
        border.width: 1
        border.color: Theme.c.border
    }
    header: Text {
        text: dlg.title
        padding: 18
        bottomPadding: 6
        color: Theme.c.text
        font.family: "Barlow"
        font.pixelSize: 18
        font.weight: Font.DemiBold
    }
    contentItem: Column {
        spacing: 8
        Text {
            text: "Scene name"
            color: Theme.c.text
            font.family: Theme.family
            font.pixelSize: 14
        }
        UField {
            id: name
            objectName: "addSceneName"
            width: parent.width
            label: "Scene name"
            maximumLength: 80
            placeholderText: "For example: Starting soon"
            onAccepted: dlg.send()
        }
        Text {
            objectName: "addSceneWhere"
            width: parent.width
            wrapMode: Text.Wrap
            text: "The scene is made on every canvas of the project: " +
                  (dlg.canvases.length ? dlg.canvases.map(c => String(c).toUpperCase()).join(" + ") : "H") + "."
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: 13
        }
    }
    footer: Item {
        implicitHeight: 64
        Row {
            anchors { right: parent.right; rightMargin: 18; verticalCenter: parent.verticalCenter }
            spacing: 10
            UButton {
                objectName: "addSceneCancel"
                text: "Close"
                onClicked: dlg.close()
            }
            UButton {
                objectName: "addSceneOk"
                text: "Add scene"
                kind: "primary"
                enabled: name.text.trim() !== ""
                onClicked: dlg.send()
            }
        }
    }
}
