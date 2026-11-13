// SPDX-License-Identifier: GPL-3.0-or-later
// A held action (D332): the server holds one only when it cannot act on the click alone (the readiness check found
// problems: "Go live anyway", logged; or a rule or remote request waits for the user's click). Allow sends only the
// pending id; Cancel drops it. No phrase. Cancel is the default, so Enter never goes live past problems.
// Its own window (Popup.Window), so the native previews never cover it.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "confirmBox"
    required property var store
    property var pending: ({})
    readonly property bool anyway: !!pending.readiness && pending.readiness.ok === false
    // Hidden test mode (never on screen): drawn inside the never-shown window, not as a window of its own.
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: true
    anchors.centerIn: parent
    width: Math.min(560, parent ? parent.width - 80 : 560)
    title: anyway ? "Not started" : "Approve this action"
    closePolicy: Popup.CloseOnEscape

    function ask(p) { pending = p || {}; open(); cancelBtn.forceActiveFocus() }
    onRejected: store.answer(pending.pendingId, false)

    background: Rectangle {
        color: Theme.c.panel
        radius: Theme.radiusLarge
        border.width: 1
        border.color: dlg.anyway ? Theme.c.danger : Theme.c.border
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
        text: dlg.pending.summary || ""
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
                id: cancelBtn
                objectName: "confirmCancel"
                text: "Cancel"
                onClicked: dlg.reject()
            }
            UButton {
                objectName: "confirmOk"
                text: dlg.anyway ? "Go live anyway" : "Allow"
                kind: dlg.anyway ? "danger" : "primary"
                onClicked: { dlg.close(); dlg.store.answer(dlg.pending.pendingId, true) }
            }
        }
    }
}
