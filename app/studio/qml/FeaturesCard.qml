// SPDX-License-Identifier: GPL-3.0-or-later
// The FEATURES card of a Settings page (the widget's featuresCard, N2): one switch row per flag whose page this is, A-Z by
// its plain name, with its plain summary under it. Plain words only (Q3): no flag id and no developer description, so no
// decision numbers or file paths. A switch changes a draft; Save applies it.
import QtQuick
import Ujwalam.Core

UCard {
    id: fc
    required property var box
    property string pageId: ""
    readonly property var rows: pageId !== "" ? box.flagRows(pageId) : []
    objectName: "featuresCard:" + pageId
    title: "FEATURES"
    visible: rows.length > 0

    Repeater {
        model: fc.rows
        delegate: Column {
            id: row
            required property var modelData
            objectName: "flagRow:" + modelData.id
            width: parent.width
            spacing: 4
            USwitch {
                objectName: "flag:" + row.modelData.id
                width: parent.width
                text: row.modelData.label
                hint: row.modelData.summary
                checked: fc.box.flagDraft[row.modelData.id] === true
                onToggled: fc.box.setFlagDraft(row.modelData.id, checked)
            }
            Text {
                // the effects only change when the scenes are built again (the widget's hint, same words)
                visible: row.modelData.id === "layer-effects"
                x: 64
                width: parent.width - 64
                text: "The effects appear the next time the scenes are built (start Ujwalam with the rebuild option). " +
                      "To change the look of one layer, select it and use the Look panel in the inspector; that needs no setting."
                wrapMode: Text.Wrap
                color: Theme.c.muted
                font.family: Theme.family
                font.pixelSize: 13
            }
        }
    }
}
