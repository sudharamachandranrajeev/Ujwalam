// SPDX-License-Identifier: GPL-3.0-or-later
// Closing with tasks still running or waiting (D311 proposed, as the widget closeEvent): nothing may go on unseen after
// the window is gone, so the user picks: stop them and close, or keep the window. (Keeping them in the tray comes with
// the tray in Q4.) Stop: the window ends with exit 0 and the launcher ends every task's whole process tree.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "closeTasks"
    required property var store
    signal stopAndClose()
    // Hidden test mode (never on screen): drawn inside the never-shown window, not as a window of its own.
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: true
    anchors.centerIn: parent
    width: Math.min(560, parent ? parent.width - 80 : 560)
    title: "Close Ujwalam"
    closePolicy: Popup.CloseOnEscape

    readonly property var running: store.tasks.filter(t => t.state === "running" || t.state === "waiting")

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
    contentItem: Text {
        text: (dlg.running.length === 1 ? "1 task is still running:\n" : dlg.running.length + " tasks are still running:\n") +
              dlg.running.slice(0, 8).map(t => "- " + (t.title || t.id)).join("\n") +
              "\n\nClosing stops " + (dlg.running.length === 1 ? "it" : "them") + "."
        wrapMode: Text.Wrap
        color: Theme.c.text
        font.family: Theme.family
        font.pixelSize: 14
        lineHeight: 1.2
    }
    footer: Item {
        implicitHeight: 64
        Row {
            anchors { right: parent.right; rightMargin: 18; verticalCenter: parent.verticalCenter }
            spacing: 10
            UButton {
                id: keep
                objectName: "closeCancel"
                text: "Do not close"
                onClicked: { dlg.close(); dlg.store.say("Ujwalam was not closed; the tasks keep running.") }
            }
            UButton {
                objectName: "closeStop"
                text: "Stop them and close"
                kind: "danger"
                onClicked: { dlg.close(); dlg.stopAndClose() }
            }
        }
    }
    onOpened: keep.forceActiveFocus()
}
