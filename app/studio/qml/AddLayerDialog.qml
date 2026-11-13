// SPDX-License-Identifier: GPL-3.0-or-later
// Add layer (the widget's AddLayerDialog, D274/D292): the kinds on the left with what each one is (a kind the project
// cannot supply is greyed and says why), on the right a searchable list of what it can be made from, or a text or colour
// field. The window only builds the layer.add body; Store.structureEdit sends it. The lists follow the project while the
// window is open (a device plugged in or out, D329). A refusal stays in the window, where it can be seen.
// Its own window (Popup.Window), so the native previews never cover it.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "addLayerBox"
    required property var store
    property string scene: ""
    property string sceneName: ""
    property string kind: ""
    property string pick: ""
    property string message: ""
    // Hidden test mode (never on screen): drawn inside the never-shown window, not as a window of its own.
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: true
    anchors.centerIn: parent
    width: 660
    height: 440
    title: "Add layer to “" + sceneName + "”"
    closePolicy: Popup.CloseOnEscape

    readonly property var kinds: [
        { label: "Copy of layer", kind: "copy", about: "The same source again, placed on its own. A camera or capture card shown twice is opened once." },
        { label: "Colour", kind: "color", about: "A solid colour fill." },
        { label: "Text", kind: "text", about: "A line of text." },
        { label: "Capture device", kind: "capture", about: "A camera or capture card from the project's devices." },
        { label: "Overlay", kind: "overlay", about: "A page from the project's overlays (alerts, chat, counters)." },
        { label: "Image", kind: "image", about: "A picture from the stream assets folder." },
        { label: "Video", kind: "media", about: "A video from the stream assets folder." }
    ]
    readonly property bool typed: kind === "color" || kind === "text"
    readonly property var kindObj: kinds.find(k => k.kind === kind) || null
    readonly property var choices: choicesFor(store.structure, kind)
    readonly property var shown: {
        const q = search.text.toLowerCase();
        return q === "" ? choices : choices.filter(c => c.label.toLowerCase().includes(q));
    }
    readonly property bool colourOk: /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(field.text.trim())

    // What each kind can be made from (add_dialogs.cpp addChoices).
    function choicesFor(st, k) {
        const out = [];
        if (!st) return out;
        if (k === "copy") {
            for (const l of st.layers || []) out.push({ label: (l.sceneName || "") + " / " + (l.name || l.id), id: l.id });
        } else if (k === "capture" || k === "overlay") {
            for (const d of (k === "capture" ? st.devices : st.overlays) || []) {
                // Devices list only with devices allowed; each says whether it is plugged in (D329). A layer for an
                // unplugged device can still be added: it waits and connects by itself.
                const off = typeof d.connected === "boolean" && !d.connected;
                out.push({ label: (d.name || d.id) + (off ? " (not connected)" : ""), id: d.id });
            }
        } else if (k === "image" || k === "media") {
            for (const a of st.assets || []) if (a.kind === k) out.push({ label: a.rel, id: a.rel });
        }
        return out;
    }
    function canAdd(k) { return k === "color" || k === "text" || choicesFor(store.structure, k).length > 0 }

    function ask(sceneId, name) {
        scene = sceneId;
        sceneName = name;
        message = "";
        search.text = "";
        field.text = "";
        kind = "";
        for (const k of kinds) if (canAdd(k.kind)) { kind = k.kind; break; }
        store.addOpen = true;
        open();
    }
    onClosed: store.addOpen = false

    // A choice hidden by the search or gone from the project is not sent: the first one shown is picked instead.
    onShownChanged: if (!shown.some(c => c.id === pick)) pick = shown.length ? shown[0].id : ""
    onKindChanged: { search.text = ""; message = ""; pick = shown.length ? shown[0].id : "" }

    function send() {
        if (!kindObj) { message = "Pick a kind first."; return; }
        const b = { op: "layer.add", scene: scene, kind: kind };
        if (typed) {
            const t = field.text;
            if (t.trim() === "") { message = kind === "color" ? "Type a colour as #RRGGBB." : "Type the text."; return; }
            if (kind === "color" && !colourOk) { message = "Colour must look like #RRGGBB."; return; }
            b[kind] = kind === "color" ? t.trim() : t;
        } else {
            if (!pick) { message = "Nothing to pick for this kind."; return; }
            b[kind === "copy" ? "of" : kind === "capture" ? "device" : kind === "overlay" ? "overlay" : "file"] = pick;
        }
        close();
        store.structureEdit(b);
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
        elide: Text.ElideRight
        color: Theme.c.text
        font.family: "Barlow"
        font.pixelSize: 18
        font.weight: Font.DemiBold
    }
    contentItem: Item {
        ListView {
            id: kindList
            objectName: "addKinds"
            anchors { left: parent.left; top: parent.top; bottom: parent.bottom }
            width: 180
            clip: true
            spacing: 2
            model: dlg.kinds
            boundsBehavior: Flickable.StopAtBounds
            Accessible.role: Accessible.List
            Accessible.name: "Kinds of layer"
            delegate: ItemDelegate {
                id: kd
                required property var modelData
                readonly property bool can: dlg.canAdd(modelData.kind)
                readonly property bool cur: modelData.kind === dlg.kind
                objectName: "kind:" + modelData.kind
                width: ListView.view.width
                height: 34
                enabled: can
                hoverEnabled: true
                Accessible.name: modelData.label + (can ? "" : ", nothing to pick")
                ToolTip.visible: hovered
                ToolTip.text: modelData.about + (can ? "" : "\nNothing to pick: the project has none.")
                ToolTip.delay: 500
                onClicked: dlg.kind = modelData.kind
                background: Rectangle {
                    radius: Theme.radiusSmall
                    color: kd.cur ? Qt.alpha(Theme.c.accent, 0.2) : kd.hovered ? Theme.c.field : "transparent"
                    border.width: kd.cur || kd.visualFocus ? 1 : 0
                    border.color: kd.visualFocus ? Theme.c.accentHi : Theme.c.accent
                }
                contentItem: Text {
                    text: kd.modelData.label
                    verticalAlignment: Text.AlignVCenter
                    elide: Text.ElideRight
                    color: kd.can ? Theme.c.text : Theme.c.disabled
                    font.family: Theme.family
                    font.pixelSize: 14
                }
            }
        }
        Item {
            id: right
            anchors { left: kindList.right; leftMargin: 16; right: parent.right; top: parent.top; bottom: parent.bottom }
            Text {
                id: about
                objectName: "addAbout"
                anchors { left: parent.left; right: parent.right; top: parent.top }
                text: dlg.message !== "" ? dlg.message : dlg.kindObj ? dlg.kindObj.about : ""
                wrapMode: Text.Wrap
                color: dlg.message !== "" ? Theme.c.danger : Theme.c.muted
                font.family: Theme.family
                font.pixelSize: 13
            }
            UField {
                id: search
                objectName: "addSearch"
                visible: !dlg.typed
                anchors { left: parent.left; right: parent.right; top: about.bottom; topMargin: 10 }
                placeholderText: "Search"
            }
            ListView {
                id: choiceList
                objectName: "addChoices"
                visible: !dlg.typed
                anchors { left: parent.left; right: parent.right; top: search.bottom; topMargin: 8; bottom: parent.bottom }
                clip: true
                spacing: 2
                model: dlg.shown
                boundsBehavior: Flickable.StopAtBounds
                ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
                Accessible.role: Accessible.List
                Accessible.name: "What to add"
                delegate: ItemDelegate {
                    id: cd
                    required property var modelData
                    required property int index
                    readonly property bool cur: modelData.id === dlg.pick
                    objectName: "choice:" + index
                    width: ListView.view.width - 4
                    height: 32
                    hoverEnabled: true
                    Accessible.name: modelData.label
                    onClicked: dlg.pick = modelData.id
                    onDoubleClicked: { dlg.pick = modelData.id; dlg.send() }
                    background: Rectangle {
                        radius: Theme.radiusSmall
                        color: cd.cur ? Qt.alpha(Theme.c.accent, 0.2) : cd.hovered ? Theme.c.field : "transparent"
                        border.width: cd.cur || cd.visualFocus ? 1 : 0
                        border.color: cd.visualFocus ? Theme.c.accentHi : Theme.c.accent
                    }
                    contentItem: Text {
                        text: cd.modelData.label
                        verticalAlignment: Text.AlignVCenter
                        elide: Text.ElideMiddle
                        color: Theme.c.text
                        font.family: Theme.family
                        font.pixelSize: 14
                    }
                }
            }
            Text {
                anchors.centerIn: choiceList
                visible: !dlg.typed && dlg.shown.length === 0 && dlg.choices.length > 0
                text: "Nothing matches the search"
                color: Theme.c.muted
                font.family: Theme.family
                font.pixelSize: 13
            }
            UField {
                id: field
                objectName: "addText"
                visible: dlg.typed
                anchors { left: parent.left; right: swatch.visible ? swatch.left : parent.right; rightMargin: swatch.visible ? 8 : 0; top: about.bottom; topMargin: 10 }
                maximumLength: 2000
                placeholderText: dlg.kind === "color" ? "#RRGGBB" : "Text"
                onAccepted: dlg.send()
            }
            Rectangle { // the colour as typed, or an empty frame while it is not a colour yet
                id: swatch
                visible: dlg.kind === "color"
                anchors { right: parent.right; verticalCenter: field.verticalCenter }
                width: 34
                height: 34
                radius: Theme.radiusSmall
                // #RRGGBBAA as typed; Qt reads eight digits as #AARRGGBB, so the alpha moves to the front.
                readonly property string typedHex: field.text.trim()
                color: !dlg.colourOk ? "transparent" : typedHex.length === 9 ? "#" + typedHex.slice(7) + typedHex.slice(1, 7) : typedHex
                border.width: 1
                border.color: Theme.c.border
                Accessible.role: Accessible.Graphic
                Accessible.name: dlg.colourOk ? "Colour " + field.text.trim() : "No colour yet"
            }
        }
    }
    footer: Item {
        implicitHeight: 64
        Row {
            anchors { right: parent.right; rightMargin: 18; verticalCenter: parent.verticalCenter }
            spacing: 10
            UButton {
                objectName: "addLayerCancel"
                text: "Close"
                onClicked: dlg.close()
            }
            UButton {
                objectName: "addLayerOk"
                text: "Add"
                kind: "primary"
                enabled: dlg.kindObj !== null
                onClicked: dlg.send()
            }
        }
    }
}
