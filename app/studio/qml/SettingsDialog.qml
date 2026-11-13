// SPDX-License-Identifier: GPL-3.0-or-later
// Settings in the QML studio (plan Q3; the widget's openSettings, D284/D290/D293/D327/D332). One window: a search box and
// the pages in groups on the left (GENERAL, LIVE, STUDIO, CLIPS, then Advanced), the page on the right. Every page is a
// draft: Save applies it (flags included, on and off alike; the click is the decision, no phrase, D332). Cancel or Escape
// with changes asks Save changes / Discard / Cancel. A theme or effects level is tried live; Cancel puts the old one back.
// Same routes and the same rules for what is sent as the widget window, so both write the same settings.json.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "settingsBox"
    required property var store
    // Hidden test mode (never on screen): drawn inside the never-shown window, not as a window of its own.
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: true
    anchors.centerIn: parent
    // implicit sizes: a window popup (Qt 6.8) takes its height from implicitHeight, not from height
    implicitWidth: Math.min(940, parent ? parent.width - 40 : 940)
    implicitHeight: Math.min(780, parent ? parent.height - 30 : 780)
    padding: 0
    title: "Settings"
    closePolicy: Popup.NoAutoClose // Escape asks first when something changed (the Shortcut below)

    // ---- the pages, in the nav's order; words = more words the search box finds the page by ----
    readonly property var groups: [
        { heading: "GENERAL", pages: ["Appearance", "Help & tips"] },
        { heading: "LIVE", pages: ["Stream", "Transitions", "Connections", "Chat & bots"] },
        { heading: "STUDIO", pages: ["Editing", "Preview"] },
        { heading: "CLIPS", pages: ["Clips", "Posting & growth", "Folders"] },
        { heading: "", pages: ["Advanced"] }
    ]
    readonly property var pageIds: ({ "Appearance": "appearance", "Help & tips": "", "Stream": "stream", "Transitions": "transitions",
        "Connections": "connections", "Chat & bots": "chat", "Editing": "editing", "Preview": "preview", "Clips": "clips",
        "Posting & growth": "posting", "Folders": "", "Advanced": "advanced" })
    readonly property var pageWords: ({
        "Appearance": "theme colours colors look dark light effects reduce high performance animations motion",
        "Help & tips": "help tips tour welcome don't show again",
        "Stream": "stream bitrate resolution quality youtube twitch kick output encoder",
        "Transitions": "transitions scene change fade cut stinger",
        "Connections": "connections sign in account key youtube twitch kick",
        "Chat & bots": "chat bots streamer.bot speaker.bot integrations",
        "Editing": "editing scenes layers effects mixer",
        "Preview": "preview snap drag mouse move layers",
        "Clips": "clips reels record live matches top 3 kills length opening teaser transition",
        "Posting & growth": "posting posts auto-post schedule growth",
        "Folders": "folders recordings clips where files saved",
        "Advanced": "advanced developer"
    })
    readonly property var knownPages: ["clips", "posting", "stream", "transitions", "connections", "chat", "editing", "preview", "appearance", "advanced"]
    readonly property var modes: [
        { value: "ask", rec: "Ask me each time I stop recording", live: "Ask me each time a stream ends" },
        { value: "after", rec: "Make clips automatically when I stop recording", live: "Make clips automatically when the stream ends" },
        { value: "while", rec: "Find the best moments while I record, then edit them into clips", live: "Find the best moments while I'm live, then edit them into clips" },
        { value: "off", rec: "Don't make clips", live: "Don't make clips" }
    ]
    readonly property var motionChoices: [{ value: "system", text: "Follow Windows" }, { value: "on", text: "Always on" }, { value: "off", text: "Off" }]

    // ---- loaded and draft state ----
    property bool ready: false
    property bool busy: false        // the settings are on their way: one open at a time
    property var info: ({})          // GET ui/api/settings: {settings, clips, reelLengths, reelHooks, reelTransition}
    property var flagList: []        // GET ui/api/flags
    property var start: ({})
    property var draft: ({})
    property var flagStart: ({})
    property var flagDraft: ({})
    property var guide: ({ tips: true, dismissed: 0, tourDone: false })
    property string page: "Clips"
    property string query: ""
    property bool saving: false      // closed by Save: no revert

    readonly property bool dirty: ready && isDirty()
    readonly property string reelError: ready ? reelProblems() : ""

    function set(k, v) { const d = Object.assign({}, draft); d[k] = v; draft = d }
    function setIn(k, id, field, v) {
        const d = Object.assign({}, draft), m = Object.assign({}, d[k]);
        m[id] = Object.assign({}, m[id]);
        m[id][field] = v;
        d[k] = m;
        draft = d;
    }
    function setFlagDraft(id, on) { const f = Object.assign({}, flagDraft); f[id] = on; flagDraft = f }

    // The flags of one page, A-Z by plain name (a flag with a page this window does not know goes to Advanced).
    function flagRows(pageId) {
        const rows = [];
        for (const f of flagList) {
            const pg = knownPages.includes(f.page) ? f.page : "advanced";
            if (pg === pageId) rows.push({ id: f.id, label: f.label || f.id, summary: f.summary || "", page: pg });
        }
        rows.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
        return rows;
    }
    function flagLabel(id) { const f = flagList.find(x => x.id === id); return f && f.label ? f.label : id }
    function flagOn(id) { return flagStart[id] === true }

    // ---- search: a page shows when its title, its words or one of its feature rows matches every typed word ----
    function pageText(t) {
        let s = t + " " + (pageWords[t] || "");
        const pid = pageIds[t];
        if (pid) for (const r of flagRows(pid)) s += " " + r.label + " " + r.summary;
        return s.toLowerCase();
    }
    function matches(t) {
        const q = query.trim().toLowerCase();
        if (q === "") return true;
        const text = pageText(t);
        return q.split(/\s+/).every(w => text.includes(w));
    }
    readonly property var shownPages: {
        const out = [];
        for (const g of groups) for (const t of g.pages) if (matches(t)) out.push(t);
        return out;
    }
    onShownPagesChanged: if (shownPages.length && !shownPages.includes(page)) page = shownPages[0]

    // ---- open ----
    function openAt(startPage) {
        if (opened) { if (startPage) page = startPage; return }
        if (busy) return;
        busy = true;
        Api.get("ui/api/flags", (fok, fb) => {
            if (fok && Array.isArray(fb.flags)) store.takeFlags(fb.flags);
            Api.get("ui/api/settings", (ok, b, err) => {
                busy = false;
                if (!ok) return store.say("Settings not available: " + err);
                fill(b);
                page = startPage || "Clips";
                query = "";
                saving = false;
                open();
            });
        });
    }

    function fill(b) {
        info = b || {};
        flagList = store.flagList;
        const fs = {};
        for (const f of flagList) fs[f.id] = f.on === true;
        flagStart = fs;
        flagDraft = Object.assign({}, fs);
        const st = info.settings || {}, c = st.clips || {}, f = st.folders || {}, ui = st.ui || {};
        const gate = c.matchGate || {};
        const kills = typeof gate.minKills === "number" ? gate.minKills : -1;
        const reel = {};
        for (const t of ((info.reelLengths || {}).types || [])) reel[t.id] = { lo: Math.round(t.minSec), hi: Math.round(t.maxSec) };
        const hooks = {};
        for (const t of ((info.reelHooks || {}).types || [])) hooks[t.id] = { on: t.on !== false, sec: typeof t.teaserSec === "number" ? t.teaserSec : 2 };
        const tr = info.reelTransition || {};
        const s = {
            recording: modes.some(m => m.value === c.recording) ? c.recording : "ask",
            live: modes.some(m => m.value === c.live) ? c.live : "ask",
            hadRecordLive: c.recordLive !== undefined,
            recordLive: c.recordLive !== false,
            hadGate: c.matchGate !== undefined,
            top3: gate.top3 !== undefined ? gate.top3 === true : true,
            killsN: kills > 0 ? kills : -1,
            killsOn: kills > 0,
            kills: kills > 0 ? kills : 5,
            reel: reel,
            hooks: hooks,
            transKind: tr.kind || "",
            transMs: typeof tr.ms === "number" ? tr.ms : 0,
            recDir: f.recordings || "",
            clipDir: f.clips || "",
            theme: Theme.id,
            effects: Theme.effects(),
            reduceBefore: Theme.effects() === "reduced",
            motion: ["system", "on", "off"].includes(ui.motion) ? ui.motion : "system",
            snap: ui.snap === true
        };
        start = s;
        draft = Object.assign({}, s);
        const g = ui.guide || {};
        guide = { tips: g.tips !== false, dismissed: Array.isArray(g.dismissed) ? g.dismissed.length : 0, tourDone: g.tourDone === true };
        ready = true;
    }

    // ---- the reel transition kinds: the length box follows the kind (its range, or none for Cut) ----
    function transKinds() { return ((info.reelTransition || {}).kinds) || [] }
    function kindRange(k) { const x = transKinds().find(t => t.id === k); return x && x.ms ? x.ms : null }
    function pickKind(k) {
        const r = kindRange(k);
        const d = Object.assign({}, draft);
        d.transKind = k;
        if (r) d.transMs = typeof r.default === "number" ? r.default : r.min;
        draft = d;
    }

    // ---- checks, changes and the body Save sends ----
    function reelProblems() {
        let bad = "";
        for (const t of ((info.reelLengths || {}).types || [])) {
            const r = draft.reel ? draft.reel[t.id] : null;
            if (r && r.lo > r.hi) bad += (bad ? " " : "") + t.id + ": the shortest (" + r.lo + " s) is longer than the longest (" + r.hi + " s).";
        }
        return bad;
    }
    function same(a, b) { return JSON.stringify(a) === JSON.stringify(b) }
    function transMsNow(d) { return kindRange(d.transKind) ? d.transMs : 0 }
    function isDirty() {
        const d = draft, s = start;
        for (const k of ["recording", "live", "recordLive", "top3", "theme", "effects", "motion", "snap", "transKind"])
            if (d[k] !== s[k]) return true;
        if ((d.killsOn ? d.kills : -1) !== s.killsN) return true;
        if (!same(d.reel, s.reel) || !same(d.hooks, s.hooks)) return true;
        if (transMsNow(d) !== (kindRange(d.transKind) ? s.transMs : 0)) return true;
        if (d.recDir.trim() !== s.recDir.trim() || d.clipDir.trim() !== s.clipDir.trim()) return true;
        for (const id in flagDraft) if ((flagStart[id] === true) !== flagDraft[id]) return true;
        return false;
    }
    function body() {
        const d = draft, s = start, out = {};
        const clips = { recording: d.recording, live: d.live };
        const kills = d.killsOn ? d.kills : -1;
        // each newer key is sent only when it matters: an older server refuses a key it does not know
        if (s.hadGate || d.top3 !== s.top3 || kills !== s.killsN) clips.matchGate = { top3: d.top3, minKills: kills > 0 ? kills : null };
        if (s.hadRecordLive || d.recordLive !== s.recordLive) clips.recordLive = d.recordLive;
        const reel = {};
        for (const id in d.reel) if (!same(d.reel[id], s.reel[id])) reel[id] = { minSec: d.reel[id].lo, maxSec: d.reel[id].hi };
        if (Object.keys(reel).length) clips.reelLengths = reel;
        const hooks = {};
        for (const id in d.hooks) if (!same(d.hooks[id], s.hooks[id])) hooks[id] = { on: d.hooks[id].on, teaserSec: d.hooks[id].sec };
        if (Object.keys(hooks).length) clips.reelHooks = hooks;
        if (transKinds().length) {
            const ms = transMsNow(d);
            if (d.transKind !== s.transKind || ms !== (kindRange(d.transKind) ? s.transMs : 0)) clips.reelTransition = { kind: d.transKind, ms: ms };
        }
        out.clips = clips;
        out.folders = { recordings: d.recDir.trim() || null, clips: d.clipDir.trim() || null };
        const ui = {};
        if (d.motion !== s.motion) ui.motion = d.motion;
        if (d.theme !== s.theme) ui.theme = d.theme;
        if (d.effects !== s.effects) ui.effects = d.effects;
        if (d.snap !== s.snap) ui.snap = d.snap;
        if (Object.keys(ui).length) out.ui = ui;
        return out;
    }

    // ---- Save, Cancel, the unsaved question ----
    function save() {
        if (!opened) return false;
        if (reelError) {
            page = "Clips";
            store.say("Not saved: Settings > Clips has a reel whose shortest length is longer than its longest.");
            return false;
        }
        const b = body(), d = draft, s = start;
        const flagChanges = [];
        for (const id in flagDraft) if ((flagStart[id] === true) !== flagDraft[id]) flagChanges.push([id, flagDraft[id], flagLabel(id)]);
        saving = true;
        unsaved.close();
        close();
        store.saveSettings(b);
        if (d.motion !== s.motion) Theme.setMotionMode(d.motion);
        // the flag switches apply now, on and off alike (D332: the Save click is the decision)
        for (const [id, on, label] of flagChanges) store.setFlag(id, on, label);
        return true;
    }
    function cancel() {
        if (!opened) return false;
        if (dirty) { unsaved.open(); return true }
        close();
        return true;
    }
    function discard() { unsaved.close(); close() }
    onClosed: {
        if (!saving && ready) { // a theme or effects level tried on the cards goes back
            if (Theme.id !== start.theme) Theme.setCurrent(start.theme);
            if (Theme.effects() !== start.effects) Theme.setEffects(start.effects);
        }
        ready = false;
    }

    // theme and effects are tried live while Settings is open
    function pickTheme(id) { set("theme", id); Theme.setCurrent(id) }
    function setPerformance(on) {
        const d = Object.assign({}, draft);
        if (on) { d.reduceBefore = d.effects === "reduced"; d.effects = "performance" }
        else d.effects = d.reduceBefore ? "reduced" : "full";
        draft = d;
        Theme.setEffects(d.effects);
    }
    function setReduce(on) {
        if (draft.effects === "performance") return;
        set("effects", on ? "reduced" : "full");
        Theme.setEffects(draft.effects);
    }

    // ---- Help & tips: these act at once, as on the widget page ----
    function guideSave(part, then) {
        Api.post("ui/api/settings", { ui: { guide: part } }, (ok, b, err) => {
            if (!ok) return store.say("Not saved: " + err);
            if (then) then();
        });
    }
    function setTips(on) { guideSave({ tips: on }, () => { guide = Object.assign({}, guide, { tips: on }) }) }
    function resetTips() { guideSave({ dismissed: [], tourDone: false }, () => { guide = Object.assign({}, guide, { dismissed: 0, tourDone: false }) }) }

    Shortcut {
        sequence: "Escape"
        enabled: dlg.opened && !unsaved.opened
        onActivated: dlg.cancel()
    }

    background: Rectangle {
        color: Theme.c.bg
        radius: Theme.radiusLarge
        border.width: 1
        border.color: Theme.c.border
    }

    contentItem: Item {
        // the nav: search box and the pages in groups
        Rectangle {
            id: navBox
            objectName: "settingsNav"
            anchors { left: parent.left; top: parent.top; bottom: parent.bottom; margins: 14; bottomMargin: 0 }
            width: 210
            color: Theme.c.panel
            radius: Theme.radiusMedium
            border.width: 1
            border.color: Theme.c.border
            UField {
                id: search
                objectName: "settingsSearch"
                anchors { left: parent.left; right: parent.right; top: parent.top; margins: 10 }
                label: "Search settings"
                placeholderText: "Search settings"
                text: dlg.query
                onTextChanged: if (text !== dlg.query) dlg.query = text
            }
            Flickable {
                anchors { left: parent.left; right: parent.right; top: search.bottom; bottom: parent.bottom; margins: 6; topMargin: 8 }
                contentHeight: navCol.height
                clip: true
                boundsBehavior: Flickable.StopAtBounds
                Column {
                    id: navCol
                    width: parent.width
                    spacing: 2
                    Repeater {
                        model: dlg.groups
                        delegate: Column {
                            id: grp
                            required property var modelData
                            width: navCol.width
                            readonly property var shown: modelData.pages.filter(t => dlg.shownPages.includes(t))
                            visible: shown.length > 0
                            Text {
                                objectName: "navGroup:" + grp.modelData.heading
                                visible: grp.modelData.heading !== ""
                                height: 30
                                leftPadding: 10
                                verticalAlignment: Text.AlignBottom
                                bottomPadding: 4
                                text: grp.modelData.heading
                                color: Theme.c.muted
                                font.family: Theme.family
                                font.pixelSize: 11
                                font.weight: Font.Bold
                                font.letterSpacing: 1.2
                            }
                            Item { visible: grp.modelData.heading === ""; width: 1; height: 12 }
                            Repeater {
                                model: grp.shown
                                delegate: Button {
                                    id: navBtn
                                    required property string modelData
                                    objectName: "nav:" + modelData
                                    width: navCol.width
                                    height: 32
                                    text: modelData
                                    checkable: false
                                    hoverEnabled: true
                                    focusPolicy: Qt.StrongFocus
                                    Accessible.name: modelData
                                    readonly property bool current: dlg.page === modelData
                                    onClicked: dlg.page = modelData
                                    contentItem: Text {
                                        leftPadding: 4
                                        text: navBtn.text
                                        color: navBtn.current ? Theme.c.text : Theme.c.muted
                                        font.family: Theme.family
                                        font.pixelSize: 14
                                        font.weight: navBtn.current ? Font.DemiBold : Font.Normal
                                        verticalAlignment: Text.AlignVCenter
                                        elide: Text.ElideRight
                                    }
                                    background: Rectangle {
                                        radius: Theme.radiusSmall
                                        color: navBtn.current ? Theme.c.field : navBtn.hovered ? Qt.lighter(Theme.c.panel, 1.15) : "transparent"
                                        border.width: navBtn.visualFocus ? 1 : 0
                                        border.color: Theme.c.accentHi
                                        Rectangle {
                                            visible: navBtn.current
                                            width: 3
                                            height: parent.height - 12
                                            anchors.verticalCenter: parent.verticalCenter
                                            radius: 1.5
                                            color: Theme.c.accent
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Text {
                        objectName: "settingsNothing"
                        visible: dlg.shownPages.length === 0
                        width: navCol.width
                        padding: 10
                        wrapMode: Text.Wrap
                        text: "Nothing found for \"" + dlg.query.trim() + "\"."
                        color: Theme.c.muted
                        font.family: Theme.family
                        font.pixelSize: 13
                    }
                }
            }
        }

        // the pages
        Item {
            id: pages
            anchors { left: navBox.right; right: parent.right; top: parent.top; bottom: parent.bottom; leftMargin: 18; rightMargin: 14; topMargin: 14 }
            visible: dlg.ready && dlg.shownPages.length > 0

            SettingsPage {
                box: dlg
                anchors.fill: parent
                title: "Appearance"
                pageId: "appearance"
                SettingsAppearance { box: dlg }
            }

            SettingsPage {
                box: dlg
                anchors.fill: parent
                title: "Help & tips"
                UCard {
                    title: "TIPS FOR NEW USERS"
                    USwitch {
                        objectName: "guideTips"
                        width: parent.width
                        text: "Show tips for new users"
                        checked: dlg.guide.tips
                        onToggled: dlg.setTips(checked)
                    }
                    Text {
                        width: parent.width
                        wrapMode: Text.Wrap
                        text: "Tips are small cards that explain what Ujwalam is doing, in front of and behind the scenes. These buttons act at once."
                        color: Theme.c.muted
                        font.family: Theme.family
                        font.pixelSize: 13
                    }
                    Text {
                        objectName: "guideStatus"
                        width: parent.width
                        wrapMode: Text.Wrap
                        text: dlg.guide.dismissed + " tip(s) hidden with \"Don't show again\". The welcome tour is " +
                              (dlg.guide.tourDone ? "done or hidden." : "not hidden.")
                        color: Theme.c.text
                        font.family: Theme.family
                        font.pixelSize: 13
                    }
                    UButton {
                        objectName: "guideReset"
                        text: "Reset all \"Don't show again\""
                        onClicked: dlg.resetTips()
                    }
                }
            }

            SettingsPage {
                box: dlg
                anchors.fill: parent
                title: "Stream"
                pageId: "stream"
                lead: !dlg.flagOn("stream-settings") ? "Switch on " + dlg.flagLabel("stream-settings") + " below and click Save to use these settings."
                                                     : "This window does not show the stream settings yet. Use Settings in the classic studio window for now."
            }

            SettingsPage {
                box: dlg
                anchors.fill: parent
                title: "Transitions"
                pageId: "transitions"
                lead: !dlg.flagOn("transitions") ? "Switch on " + dlg.flagLabel("transitions") + " below and click Save to use these settings."
                    : !dlg.flagOn("stream-settings") ? "These settings also need " + dlg.flagLabel("stream-settings") + ": switch it on in Settings > Stream and click Save."
                    : "This window does not show the transition settings yet. Use Settings in the classic studio window for now."
            }

            SettingsPage {
                box: dlg
                anchors.fill: parent
                title: "Connections"
                pageId: "connections"
                lead: "This window does not show sign-in and stream keys yet. Use Settings in the classic studio window for now."
            }

            SettingsPage {
                box: dlg
                anchors.fill: parent
                title: "Chat & bots"
                pageId: "chat"
                lead: !dlg.flagOn("integrations") ? "Switch on " + dlg.flagLabel("integrations") + " below and click Save to use these settings."
                                                  : "This window does not show the chat and bot settings yet. Use Settings in the classic studio window for now."
            }

            SettingsPage {
                box: dlg
                anchors.fill: parent
                title: "Editing"
                pageId: "editing"
            }

            SettingsPage {
                box: dlg
                anchors.fill: parent
                title: "Preview"
                pageId: "preview"
                UCard {
                    title: "MOVING LAYERS WITH THE MOUSE"
                    USwitch {
                        objectName: "settingsSnap"
                        width: parent.width
                        text: "Snap to preview edges and other layers"
                        hint: "On: a layer you drag or resize on the preview jumps into line when it comes close to an edge or the middle of the canvas, " +
                              "or to the edges and middle of another layer; a pink line shows where. Hold Alt while dragging to place it freely. " +
                              "Off: layers go exactly where you drop them. Changes when you click Save."
                        checked: dlg.draft.snap === true
                        onToggled: dlg.set("snap", checked)
                    }
                }
            }

            SettingsPage {
                box: dlg
                anchors.fill: parent
                title: "Clips"
                pageId: "clips"
                SettingsClips { box: dlg }
            }

            SettingsPage {
                box: dlg
                anchors.fill: parent
                title: "Posting & growth"
                pageId: "posting"
                lead: "Posts are reviewed in the Posts window once Posts window is switched on below." +
                      (dlg.flagOn("posting") ? " This window does not show the auto-post settings yet. Use Settings in the classic studio window for now." : "")
            }

            SettingsPage {
                box: dlg
                anchors.fill: parent
                title: "Folders"
                UCard {
                    title: "WHERE FILES ARE SAVED"
                    Repeater {
                        model: [
                            { key: "recDir", name: "Recordings", label: "Recordings:", hint: "Default (Ujwalam's data folder)" },
                            { key: "clipDir", name: "Clips", label: "Finished clips:", hint: (dlg.info.clips || {}).folder || "Default" }
                        ]
                        delegate: Column {
                            id: fr
                            required property var modelData
                            width: parent.width
                            spacing: 4
                            Text {
                                text: fr.modelData.label
                                color: Theme.c.text
                                font.family: Theme.family
                                font.pixelSize: 14
                            }
                            Item {
                                width: parent.width
                                height: 34
                                UField {
                                    objectName: "folder" + fr.modelData.name
                                    anchors { left: parent.left; right: pick.left; rightMargin: 8 }
                                    label: fr.modelData.label
                                    placeholderText: fr.modelData.hint
                                    text: dlg.draft[fr.modelData.key] || ""
                                    onTextChanged: if (dlg.ready && text !== dlg.draft[fr.modelData.key]) dlg.set(fr.modelData.key, text)
                                }
                                UButton {
                                    id: pick
                                    objectName: "folderPick" + fr.modelData.name
                                    anchors.right: reset.left
                                    anchors.rightMargin: 8
                                    text: "Choose..."
                                    onClicked: {
                                        const d = Api.chooseFolder("Choose a folder", dlg.draft[fr.modelData.key] || "");
                                        if (d !== "") dlg.set(fr.modelData.key, d.replace(/\//g, "\\"));
                                    }
                                }
                                UButton {
                                    id: reset
                                    objectName: "folderDefault" + fr.modelData.name
                                    anchors.right: parent.right
                                    text: "Default"
                                    onClicked: dlg.set(fr.modelData.key, "")
                                }
                            }
                        }
                    }
                    Text {
                        width: parent.width
                        wrapMode: Text.Wrap
                        text: "A new recordings folder is used from the next time you start Ujwalam."
                        color: Theme.c.muted
                        font.family: Theme.family
                        font.pixelSize: 13
                    }
                }
            }

            SettingsPage {
                box: dlg
                anchors.fill: parent
                title: "Advanced"
                pageId: "advanced"
                note: dlg.flagList.length ? "Every other feature switch is on its page. A switch changes when you click Save."
                                          : "The features are not loaded yet. Open Settings again in a moment."
            }
        }
    }

    footer: Item {
        implicitHeight: 64
        Text {
            objectName: "settingsError"
            anchors { left: parent.left; leftMargin: 18; right: buttons.left; rightMargin: 16; verticalCenter: parent.verticalCenter }
            visible: dlg.reelError !== ""
            text: "Not saved yet: a reel's shortest length is longer than its longest (Clips)."
            elide: Text.ElideRight
            color: Theme.c.danger
            font.family: Theme.family
            font.pixelSize: 13
        }
        Row {
            id: buttons
            anchors { right: parent.right; rightMargin: 18; verticalCenter: parent.verticalCenter }
            spacing: 10
            UButton {
                objectName: "settingsCancel"
                text: "Cancel"
                onClicked: dlg.cancel()
            }
            UButton {
                objectName: "settingsSave"
                text: "Save"
                kind: "primary"
                onClicked: dlg.save()
            }
        }
    }

    // Unsaved changes (D332): Save changes / Discard / Cancel. Cancel keeps Settings open with the edits.
    Dialog {
        id: unsaved
        objectName: "settingsUnsaved"
        popupType: studioHidden ? Popup.Item : Popup.Window
        modal: true
        anchors.centerIn: parent
        width: 440
        title: "Unsaved changes"
        closePolicy: Popup.CloseOnEscape
        background: Rectangle {
            color: Theme.c.panel
            radius: Theme.radiusLarge
            border.width: 1
            border.color: Theme.c.border
        }
        header: Text {
            text: unsaved.title
            padding: 18
            bottomPadding: 6
            color: Theme.c.text
            font.family: "Barlow"
            font.pixelSize: 18
            font.weight: Font.DemiBold
        }
        contentItem: Text {
            text: "Some settings were changed but not saved."
            wrapMode: Text.Wrap
            color: Theme.c.text
            font.family: Theme.family
            font.pixelSize: 14
        }
        footer: Item {
            implicitHeight: 64
            Row {
                anchors { right: parent.right; rightMargin: 18; verticalCenter: parent.verticalCenter }
                spacing: 10
                UButton { objectName: "unsavedCancel"; text: "Cancel"; onClicked: unsaved.close() }
                UButton { objectName: "unsavedDiscard"; text: "Discard"; onClicked: dlg.discard() }
                UButton { objectName: "unsavedSave"; text: "Save changes"; kind: "primary"; onClicked: dlg.save() }
            }
        }
    }

    // ---- probe (tests): the same names as the widget studio's probe ----
    function probe() {
        const sections = [], heads = [];
        for (const g of groups) { if (g.heading) heads.push(g.heading); for (const t of g.pages) sections.push(t) }
        const rows = [];
        for (const pid of knownPages) for (const r of flagRows(pid))
            rows.push({ id: r.id, label: r.label, summary: r.summary, page: r.page, on: flagDraft[r.id] === true, visible: page === pageTitle(pid) });
        const reelRows = {};
        for (const t of ((info.reelLengths || {}).types || []))
            reelRows[t.id] = { min: draft.reel[t.id].lo, max: draft.reel[t.id].hi, maxLimit: (info.reelLengths || {}).limitMaxSec || 60 };
        const hooks = {}, hi = info.reelHooks || {};
        for (const t of (hi.types || []))
            hooks[t.id] = { on: draft.hooks[t.id].on, teaserSec: draft.hooks[t.id].sec, teaserEnabled: draft.hooks[t.id].on, min: hi.teaserMin || 1, max: hi.teaserMax || 3 };
        const k = transKinds().find(x => x.id === draft.transKind), r = kindRange(draft.transKind);
        return {
            open: opened, page: page, query: query, shownPages: shownPages, sections: sections, navGroups: heads,
            motion: draft.motion, motionChoices: motionChoices.length, dirty: dirty, theme: draft.theme, effects: draft.effects,
            flagRows: rows, reelLengths: { rows: reelRows, error: reelError }, reelHooks: hooks,
            reelTransition: k ? { kind: k.id, label: k.label, ms: transMsNow(draft), msEnabled: !!r, min: r ? r.min : 0, max: r ? r.max : 0 } : null,
            recordLive: { on: draft.recordLive, text: "Record while live", visible: page === "Clips",
                hint: "Records the stream (H and V) to your recordings folder so reels can be made after it ends. Uses about 10 GB per hour." },
            snap: draft.snap, unsavedOpen: unsaved.opened, guide: guide,
            size: [width, height]
        };
    }
    function pageTitle(pid) { for (const t in pageIds) if (pageIds[t] === pid) return t; return "" }

    // settings-* probe actions, named as on the widget studio (probe actions run every 700 ms; the open waits for its
    // two answers, so the next action finds the window open).
    function probeAction(a) {
        const p = a.split(":");
        const on = (v) => v === "on" || v === "1";
        switch (p[0]) {
        case "settings-open": openAt(p[1] || ""); return true;
        case "settings-section":
        case "settings-page": if (!opened || !shownPages.includes(p[1])) return false; page = p[1]; return true;
        case "settings-search": if (!opened) return false; query = a.slice(a.indexOf(":") + 1); return true;
        case "settings-save": return save();
        case "settings-cancel": return cancel();
        case "settings-unsaved":
            if (!unsaved.opened) return false;
            if (p[1] === "save") return save();
            if (p[1] === "discard") { discard(); return true }
            unsaved.close();
            return true;
        }
        if (!opened) return false;
        switch (p[0]) {
        case "settings-shot": { // settings-shot:<png path>: a picture of the Settings window (it is its own window)
            const file = a.slice("settings-shot:".length);
            return contentItem.parent.grabToImage((r) => Api.log("settings shot: " + (r.saveToFile(file) ? "saved" : "failed")));
        }
        case "settings-flag": if (!flagList.some(f => f.id === p[1])) return false; setFlagDraft(p[1], on(p[2])); return true;
        case "settings-motion": if (!motionChoices.some(m => m.value === p[1])) return false; set("motion", p[1]); return true;
        case "settings-record-live": set("recordLive", on(p[1])); return true;
        case "settings-snap": set("snap", on(p[1])); return true;
        case "settings-theme": if (!Theme.themes().some(t => t.id === p[1])) return false; pickTheme(p[1]); return true;
        case "settings-reduce-effects": if (draft.effects === "performance") return false; setReduce(on(p[1])); return true;
        case "settings-performance": setPerformance(on(p[1])); return true;
        case "settings-reel":
            if (!draft.reel[p[1]]) return false;
            setIn("reel", p[1], "lo", parseInt(p[2], 10));
            setIn("reel", p[1], "hi", parseInt(p[3], 10));
            return true;
        case "settings-hook":
            if (!draft.hooks[p[1]]) return false;
            setIn("hooks", p[1], "on", on(p[2]));
            setIn("hooks", p[1], "sec", parseInt(p[3], 10));
            return true;
        case "settings-transition":
            if (!transKinds().some(t => t.id === p[1])) return false;
            pickKind(p[1]);
            if (kindRange(p[1])) set("transMs", parseInt(p[2], 10));
            return true;
        }
        return false;
    }
}
