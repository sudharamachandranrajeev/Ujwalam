// SPDX-License-Identifier: GPL-3.0-or-later
// One Settings page (Q3): its title, its cards in a column and its FEATURES card last. It scrolls up and down only: the
// column is as wide as the view, so nothing ever scrolls sideways. Shown while it is the page picked in the list.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

ScrollView {
    id: pg
    required property var box        // the SettingsDialog: draft, flags, page
    property string title: ""
    property string pageId: ""        // the flags' page id for the FEATURES card ("" = no card)
    property string lead: ""          // a muted line above the cards
    property string note: ""          // a muted line under the FEATURES card
    default property alias content: col.data
    objectName: "settingsPage:" + title
    visible: box.page === title
    clip: true
    contentWidth: availableWidth
    contentHeight: outer.height
    ScrollBar.horizontal.policy: ScrollBar.AlwaysOff

    Column {
        id: outer
        width: pg.availableWidth - 12
        spacing: 12
        Text {
            objectName: "settingsTitle:" + pg.title
            text: pg.title
            color: Theme.c.text
            font.family: "Barlow"
            font.pixelSize: 20
            font.weight: Font.DemiBold
        }
        Text {
            objectName: "settingsLead:" + pg.title
            visible: pg.lead !== ""
            width: parent.width
            text: pg.lead
            wrapMode: Text.Wrap
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: 13
        }
        Column {
            id: col
            width: parent.width
            spacing: 12
        }
        FeaturesCard {
            box: pg.box
            pageId: pg.pageId
        }
        Text {
            objectName: "settingsNote:" + pg.title
            visible: pg.note !== ""
            width: parent.width
            text: pg.note
            wrapMode: Text.Wrap
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: 13
        }
    }
}
