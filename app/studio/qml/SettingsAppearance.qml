// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Appearance (the widget's appearance::Page, D293): the themes as cards drawn in their own colours, the effects
// level (High performance, Reduce effects) and the animation choice. A card click and the effects switches are tried
// live; Save keeps them, Cancel puts the old look back.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Column {
    id: ap
    required property var box
    width: parent ? parent.width : 0
    spacing: 12
    readonly property var d: box.draft
    readonly property var themes: Theme.themes()

    UCard {
        title: "THEME"
        Text {
            width: parent.width
            wrapMode: Text.Wrap
            text: "A theme changes the whole window: colours, type, corners, shadows, glow and motion. Click one to try it; Save keeps it. " +
                  "Your own theme files go in the themes folder next to the program."
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: 13
        }
        Flow {
            width: parent.width
            spacing: 10
            Repeater {
                model: ap.themes
                delegate: Button {
                    id: card
                    required property var modelData
                    readonly property bool chosen: ap.d.theme === modelData.id
                    objectName: "themeCard:" + modelData.id
                    width: 136
                    height: 112
                    checkable: false
                    hoverEnabled: true
                    focusPolicy: Qt.StrongFocus
                    text: modelData.name
                    Accessible.name: modelData.name
                    Accessible.description: modelData.topic || ""
                    ToolTip.visible: hovered && !!modelData.topic
                    ToolTip.text: modelData.topic || ""
                    ToolTip.delay: 500
                    onClicked: ap.box.pickTheme(modelData.id)
                    contentItem: Item {}
                    background: Rectangle {
                        radius: 10
                        color: card.modelData.bg
                        border.width: card.chosen ? 2.2 : card.hovered || card.visualFocus ? 1.6 : 1
                        border.color: card.chosen ? Theme.c.accentHi : card.hovered || card.visualFocus ? card.modelData.accent : Theme.c.border
                        // a miniature window: a panel with a field and a primary button in the theme's own colours
                        Rectangle {
                            x: 8; y: 8
                            width: parent.width - 16
                            height: parent.height - 48
                            radius: 6
                            color: card.modelData.panel
                            Rectangle { x: 8; y: 9; width: parent.width * 0.45; height: 10; radius: 3; color: card.modelData.bg; opacity: 0.8 }
                            Rectangle { x: 8; y: parent.height - 20; width: 50; height: 13; radius: 5; color: card.modelData.accent }
                            Rectangle { x: parent.width * 0.58; y: 11; width: parent.width * 0.3; height: 3; radius: 1.5; color: card.modelData.text; opacity: 0.55 }
                            Rectangle { x: parent.width * 0.58; y: 18; width: parent.width * 0.2; height: 3; radius: 1.5; color: card.modelData.text; opacity: 0.55 }
                        }
                        Text {
                            x: 10
                            y: parent.height - 34
                            width: parent.width - 34
                            text: card.modelData.name
                            elide: Text.ElideRight
                            color: card.modelData.text
                            font.family: Theme.family
                            font.pixelSize: 12
                            font.weight: Font.Bold
                        }
                        Rectangle {
                            visible: card.chosen
                            x: parent.width - 24
                            y: parent.height - 32
                            width: 16
                            height: 16
                            radius: 8
                            color: card.modelData.accent
                            Text { anchors.centerIn: parent; text: "✓"; color: "white"; font.pixelSize: 11; font.weight: Font.Bold }
                        }
                    }
                }
            }
        }
    }

    UCard {
        title: "EFFECTS"
        USwitch {
            objectName: "settingsPerformance"
            width: parent.width
            text: "High performance (flat look: no shadows, glow, gradients or animation)"
            hint: "Less to draw. Colours, type and corners stay as the theme says."
            checked: ap.d.effects === "performance"
            onToggled: ap.box.setPerformance(checked)
        }
        USwitch {
            objectName: "settingsReduceEffects"
            width: parent.width
            text: "Reduce effects (no shadows, glow or 3D edges)"
            hint: "Turn this on if the window feels slow on this PC. Gradients and animations stay."
            enabled: ap.d.effects !== "performance"
            checked: ap.d.effects !== "full"
            onToggled: ap.box.setReduce(checked)
        }
    }

    UCard {
        title: "ANIMATIONS"
        Text {
            text: "Motion in the window:"
            color: Theme.c.text
            font.family: Theme.family
            font.pixelSize: 14
        }
        UCombo {
            objectName: "settingsMotion"
            width: 260
            label: "Motion in the window"
            model: ap.box.motionChoices
            currentIndex: Math.max(0, ap.box.motionChoices.findIndex(m => m.value === ap.d.motion))
            onChose: (v) => ap.box.set("motion", v)
        }
    }
}
