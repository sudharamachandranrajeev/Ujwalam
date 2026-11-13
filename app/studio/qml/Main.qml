// SPDX-License-Identifier: GPL-3.0-or-later
// The Qt Quick studio window (D355, flag studio-qml; plan Q2): the on-air bar on top, scenes on the left, the H and V
// previews in the middle, layers on the right, the mixer below and a status line at the bottom. The frame uses anchors
// only, so it is placed in a window that is never shown too (hidden test mode: the previews embed there).
// qml_studio.cpp calls start() once the window is placed, and probeState() for the tests' probe.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

ApplicationWindow {
    id: win
    title: "Ujwalam Studio"
    width: 1600
    height: 900
    minimumWidth: 1100
    minimumHeight: 680
    color: Theme.c.bg
    font.family: Theme.family

    property bool closeConfirmed: false

    function start() { studioStore.start() }
    function probeState() {
        const s = studioStore.probeState();
        s.settings = settingsDlg.ready ? settingsDlg.probe() : null;
        s.flagsInSettings = settingsDlg.opened;
        s.flags = studioStore.flagList.map(f => ({ id: f.id, on: f.on === true }));
        s.motionMode = Theme.motionMode();
        s.motion = Theme.motion;
        s.effects = Theme.effects();
        return s;
    }
    // Probe actions the C++ side does not know (settings-*): the same names as the widget studio's probe.
    function probeAction(action) {
        if (String(action).startsWith("settings-")) return settingsDlg.probeAction(String(action));
        return false;
    }

    Store {
        id: studioStore
        paused: win.visibility === Window.Minimized
        onConfirmNeeded: (pending) => confirm.ask(pending)
        onAddLayerReady: (sceneId, sceneName) => addLayerDlg.ask(sceneId, sceneName)
        onAddSceneReady: (canvases) => addSceneDlg.ask(canvases)
        onSettingsWanted: (page) => settingsDlg.openAt(page)
    }

    // Tasks still running and not live: ask first (the widget closeEvent). Live: the window closes as before.
    onClosing: (close) => {
        if (!closeConfirmed && studioStore.activeTasks > 0 && !studioStore.live) {
            close.accepted = false;
            closeDlg.open();
            return;
        }
        Qt.callLater(Qt.quit); // a hidden test window is no "last visible window": quit explicitly (exit 0)
    }

    readonly property int pad: 10

    OnAirBar {
        id: bar
        objectName: "onAirBar"
        store: studioStore
        anchors { left: parent.left; right: parent.right; top: parent.top; margins: win.pad }
        height: 56
    }

    ScenesPanel {
        id: scenes
        objectName: "scenesPanel"
        store: studioStore
        anchors { left: parent.left; top: bar.bottom; bottom: mixer.top; margins: win.pad }
        width: 240
    }

    LayersPanel {
        id: layers
        objectName: "layersPanel"
        store: studioStore
        anchors { right: parent.right; top: bar.bottom; bottom: mixer.top; margins: win.pad }
        width: 300
    }

    PreviewArea {
        id: previews
        objectName: "previewArea"
        store: studioStore
        anchors { left: scenes.right; right: layers.left; top: bar.bottom; bottom: mixer.top; margins: win.pad; topMargin: win.pad + 4 }
    }

    MixerPanel {
        id: mixer
        objectName: "mixerPanel"
        store: studioStore
        anchors { left: parent.left; right: parent.right; bottom: statusLine.top; margins: win.pad; bottomMargin: 4 }
        height: 190
    }

    Item {
        id: statusLine
        objectName: "statusLine"
        anchors { left: parent.left; right: parent.right; bottom: parent.bottom; leftMargin: win.pad + 6; rightMargin: win.pad + 6 }
        height: 28
        // The shared tooltip opens as its own window (Qt 6.8), so a preview never covers it.
        Component.onCompleted: ToolTip.toolTip.popupType = studioHidden ? Popup.Item : Popup.Window // hidden mode: nothing on screen
        Text {
            objectName: "note"
            anchors { left: parent.left; right: health.left; rightMargin: 16; verticalCenter: parent.verticalCenter }
            text: studioStore.note
            elide: Text.ElideRight
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: 13
        }
        Text {
            id: health
            objectName: "health"
            anchors { right: parent.right; verticalCenter: parent.verticalCenter }
            text: (studioStore.fake ? "Host: test stand-in" : studioStore.hostUp ? "Host: running" : "Host: not running") +
                  "   ·   " + (studioStore.coreUp ? "Event core: running" : "Event core: not running") +
                  (studioStore.activeTasks > 0 ? "   ·   " + studioStore.activeTasks + (studioStore.activeTasks === 1 ? " task running" : " tasks running") : "")
            color: studioStore.hostUp ? Theme.c.muted : Theme.c.danger
            font.family: Theme.family
            font.pixelSize: 13
        }
    }

    ConfirmDialog { id: confirm; store: studioStore }
    AddLayerDialog { id: addLayerDlg; store: studioStore }
    AddSceneDialog { id: addSceneDlg; store: studioStore }
    SettingsDialog { id: settingsDlg; store: studioStore }

    CloseDialog {
        id: closeDlg
        store: studioStore
        onStopAndClose: {
            Api.log("studio close: stop tasks (" + studioStore.activeTasks + ")");
            win.closeConfirmed = true;
            win.close();
        }
    }
}
