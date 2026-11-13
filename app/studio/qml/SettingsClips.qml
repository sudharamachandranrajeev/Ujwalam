// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Clips (the widget's Clips page, D284/D334/D350/D352/RP1): when to make clips, record while live, which matches
// get clips, and per reel type its length, its opening and the join between its pieces. Every control edits the dialog's
// draft; Save sends only what the widget window would send.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Column {
    id: cp
    required property var box
    width: parent ? parent.width : 0
    spacing: 12
    readonly property var d: box.draft
    readonly property var reelInfo: box.info.reelLengths || {}
    readonly property var hookInfo: box.info.reelHooks || {}
    readonly property var clipsState: box.info.clips || {}

    component Words: Text {
        color: Theme.c.text
        font.family: Theme.family
        font.pixelSize: 14
    }
    component Quiet: Text {
        width: parent ? parent.width : 0
        wrapMode: Text.Wrap
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: 13
    }

    UCard {
        title: "WHEN TO MAKE CLIPS"
        Repeater {
            model: [{ key: "recording", name: "settingsRecording", label: "When I record:" }, { key: "live", name: "settingsLive", label: "When I stream live:" }]
            delegate: Column {
                id: mr
                required property var modelData
                width: parent.width
                spacing: 4
                Words { text: mr.modelData.label }
                UCombo {
                    objectName: mr.modelData.name
                    width: Math.min(parent.width, 520)
                    label: mr.modelData.label
                    model: cp.box.modes.map(m => ({ value: m.value, text: mr.modelData.key === "live" ? m.live : m.rec }))
                    currentIndex: Math.max(0, cp.box.modes.findIndex(m => m.value === cp.d[mr.modelData.key]))
                    onChose: (v) => cp.box.set(mr.modelData.key, v)
                }
            }
        }
        Text {
            objectName: "settingsClipsUnavailable"
            visible: cp.clipsState.available === false
            width: parent.width
            wrapMode: Text.Wrap
            text: "Clips can't be made on this PC yet: " + (cp.clipsState.reason || "") + (cp.clipsState.fix ? ". " + cp.clipsState.fix : "")
            color: Theme.c.danger
            font.family: Theme.family
            font.pixelSize: 13
        }
    }

    UCard {
        title: "WHILE I STREAM"
        USwitch {
            objectName: "settingsRecordLive"
            width: parent.width
            text: "Record while live"
            hint: "Records the stream (H and V) to your recordings folder so reels can be made after it ends. Uses about 10 GB per hour."
            checked: cp.d.recordLive === true
            onToggled: cp.box.set("recordLive", checked)
        }
    }

    UCard {
        title: "WHICH MATCHES GET CLIPS"
        USwitch {
            objectName: "settingsTop3"
            width: parent.width
            text: "Only make clips from matches where I finish in the top 3"
            checked: cp.d.top3 === true
            onToggled: cp.box.set("top3", checked)
        }
        Row {
            spacing: 10
            USwitch {
                objectName: "settingsKillsOn"
                wrap: false
                anchors.verticalCenter: parent.verticalCenter
                text: "...or where I get at least"
                checked: cp.d.killsOn === true
                onToggled: cp.box.set("killsOn", checked)
            }
            USpin {
                objectName: "settingsKills"
                anchors.verticalCenter: parent.verticalCenter
                label: "Kills"
                from: 1
                to: 99
                suffix: " kills"
                enabled: cp.d.killsOn === true
                value: cp.d.kills || 5
                onValueModified: cp.box.set("kills", value)
            }
        }
    }

    UCard {
        title: "REEL LENGTH"
        visible: (cp.reelInfo.types || []).length > 0
        Quiet {
            text: "A reel longer than its maximum is split into parts (part 1 of 2, part 2 of 2) between clips. The maximum is at most " +
                  (cp.reelInfo.limitMaxSec || 60) + " seconds for now."
        }
        Repeater {
            model: cp.reelInfo.types || []
            delegate: Column {
                id: rr
                required property var modelData
                readonly property var v: (cp.d.reel || {})[modelData.id] || { lo: 0, hi: 5 }
                readonly property int limit: cp.reelInfo.limitMaxSec || 60
                width: parent.width
                spacing: 4
                Words { text: rr.modelData.label }
                Row {
                    spacing: 8
                    Words { text: "Shortest"; anchors.verticalCenter: parent.verticalCenter }
                    USpin {
                        objectName: "reelMin_" + rr.modelData.id
                        label: rr.modelData.label + " shortest"
                        from: 0
                        to: rr.limit
                        suffix: " s"
                        value: rr.v.lo
                        onValueModified: cp.box.setIn("reel", rr.modelData.id, "lo", value)
                    }
                    Words { text: "Longest"; anchors.verticalCenter: parent.verticalCenter }
                    USpin {
                        objectName: "reelMax_" + rr.modelData.id
                        label: rr.modelData.label + " longest"
                        from: 5
                        to: rr.limit
                        suffix: " s"
                        value: rr.v.hi
                        onValueModified: cp.box.setIn("reel", rr.modelData.id, "hi", value)
                    }
                }
                Quiet { visible: !!rr.modelData.hint; text: rr.modelData.hint || "" }
            }
        }
        Text {
            objectName: "settingsReelError"
            visible: cp.box.reelError !== ""
            width: parent.width
            wrapMode: Text.Wrap
            text: cp.box.reelError
            color: Theme.c.danger
            font.family: Theme.family
            font.pixelSize: 13
        }
        UButton {
            objectName: "settingsReelReset"
            text: "Reset to defaults"
            onClicked: {
                const m = {};
                for (const t of (cp.reelInfo.types || [])) m[t.id] = { lo: Math.round(t.defaultMinSec), hi: Math.round(t.defaultMaxSec) };
                cp.box.set("reel", m);
            }
        }
    }

    UCard {
        title: "REEL OPENING"
        visible: (cp.hookInfo.types || []).length > 0
        Quiet {
            text: "Opens each reel on its best moment (the best kill or the multi-kill) in the first seconds, then plays it in order. " +
                  "A short teaser of that moment plays first where the reel tells a story. The teaser counts toward the longest length. " +
                  "Works while the " + cp.box.flagLabel("reel-hook") + " switch is on."
        }
        Repeater {
            model: cp.hookInfo.types || []
            delegate: Column {
                id: hr
                required property var modelData
                readonly property var v: (cp.d.hooks || {})[modelData.id] || { on: true, sec: 2 }
                width: parent.width
                spacing: 4
                Words { text: hr.modelData.label }
                Quiet {
                    text: hr.modelData.strategy === "reorder" ? "The clip with the best moment moves to the front; a teaser only when that moment is deep inside it."
                                                              : "A teaser of the best moment plays first, then the reel from its start."
                }
                Row {
                    spacing: 10
                    USwitch {
                        objectName: "hookOn_" + hr.modelData.id
                        wrap: false
                        anchors.verticalCenter: parent.verticalCenter
                        text: "Open with the best moment"
                        Accessible.name: hr.modelData.label + " open with the best moment"
                        checked: hr.v.on === true
                        onToggled: cp.box.setIn("hooks", hr.modelData.id, "on", checked)
                    }
                    Words { text: "Teaser"; anchors.verticalCenter: parent.verticalCenter }
                    USpin {
                        objectName: "hookSec_" + hr.modelData.id
                        anchors.verticalCenter: parent.verticalCenter
                        label: hr.modelData.label + " teaser length"
                        from: cp.hookInfo.teaserMin || 1
                        to: cp.hookInfo.teaserMax || 3
                        suffix: " s"
                        enabled: hr.v.on === true
                        value: hr.v.sec
                        onValueModified: cp.box.setIn("hooks", hr.modelData.id, "sec", value)
                    }
                }
            }
        }
        UButton {
            objectName: "settingsHookReset"
            text: "Reset to defaults"
            onClicked: {
                const m = {};
                for (const t of (cp.hookInfo.types || [])) m[t.id] = { on: t.defaultOn !== false, sec: typeof t.defaultTeaserSec === "number" ? t.defaultTeaserSec : 2 };
                cp.box.set("hooks", m);
            }
        }
    }

    UCard {
        title: "REEL TRANSITION"
        visible: cp.box.transKinds().length > 0
        Quiet {
            text: "How one piece of a reel joins the next. A cross fade overlaps the two pieces, so each join makes the reel that much shorter. " +
                  "A reel with burned-in captions keeps the cut. Works while the " + cp.box.flagLabel("reel-transitions") + " switch is on."
        }
        Words { text: "Transition between pieces" }
        Row {
            spacing: 8
            UCombo {
                id: kind
                objectName: "settingsTransKind"
                width: 220
                label: "Transition between pieces"
                model: cp.box.transKinds().map(k => ({ value: k.id, text: k.label }))
                currentIndex: Math.max(0, cp.box.transKinds().findIndex(k => k.id === cp.d.transKind))
                onChose: (v) => cp.box.pickKind(v)
            }
            Words { text: "Length"; anchors.verticalCenter: parent.verticalCenter }
            USpin {
                readonly property var range: cp.box.kindRange(cp.d.transKind)
                objectName: "settingsTransMs"
                anchors.verticalCenter: parent.verticalCenter
                label: "Transition length"
                enabled: !!range
                from: range ? range.min : 0
                to: range ? range.max : 0
                stepSize: 50
                suffix: " ms"
                value: range ? cp.d.transMs : 0
                onValueModified: cp.box.set("transMs", value)
            }
        }
        Quiet {
            readonly property var k: cp.box.transKinds().find(x => x.id === cp.d.transKind)
            visible: !!k && !!k.about
            text: k && k.about ? k.about : ""
        }
    }
}
