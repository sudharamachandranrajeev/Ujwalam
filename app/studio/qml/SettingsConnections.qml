// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Connections (the widget's connections::Page, D327 PC1-PC3, flag platform-connect; plan Q3 slice 6): per stream
// output, sign in with YouTube or Twitch, paste a stream key / server address, or disconnect; the Twitch app client ID once;
// Check sign-ins. Same routes as the widget (ui/api/connect, .../sign-in, paste, disconnect, twitch-client, check, choose,
// cancel, ui/api/confirm), so both studios write the same Windows Credential Manager entries through the studio UI server.
// Every write acts on its own click (D332): no draft, nothing for Save in Settings, no question. An output that is
// streaming is refused by the server, which says so.
// Keys: a pasted key goes once from a password field to the server and is never shown again; the page gets presence, the
// address scheme and at most the last 4 characters. The key and server fields have no object name (the probe tree never
// lists them or their text), are wiped and destroyed when the paste box closes (OK or Cancel) and when Settings closes.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Column {
    id: cp
    required property var box
    width: parent ? parent.width : 0
    spacing: 12

    // ---- state ----
    property bool loaded: false
    property int gen: 0                   // a newer load or reset drops older answers
    property int sent: 0                  // reads sent; an answer older than the last one shown is dropped (polls overlap)
    property int shown: 0
    property var rows: []                 // ui/api/connect outputs shown (only one after Edit output > Connect)
    property var accounts: ({})
    property string only: ""              // the one output shown (Edit output > Connect), or empty: all
    property string message: ""
    property string jobText: ""
    property bool polling: false          // a sign-in is on its way: the state is read every second
    property string chosenFor: ""         // the job id whose stream choice was already offered
    property string choiceJob: ""         // the job whose YouTube stream key is being chosen, or empty
    property var choiceTexts: []
    property var choiceIds: []
    property string pasteId: ""           // the output whose paste box is open, or empty

    readonly property bool active: box.ready && box.flagOn("platform-connect")
    readonly property var pasteRow: pasteId === "" ? null : (rows.find(o => o.id === pasteId) || null)

    onActiveChanged: { if (!active) reset(); else reload(true) }
    visible: active

    function reset() {
        gen++;
        closePaste();
        twWipe();
        loaded = false;
        rows = [];
        accounts = ({});
        only = "";
        message = "";
        jobText = "";
        polling = false;
        chosenFor = "";
        choiceJob = "";
        choiceTexts = [];
        choiceIds = [];
    }

    // "Connected  (key ....ab12)" / "Sign-in expired" / "Not connected", then the server's detail (as the widget).
    function shortText(o) {
        const key = o.key || ({});
        let t = o.state === "connected" ? "Connected" : o.state === "token-expired" ? "Sign-in expired" : "Not connected";
        if (key.present === true && key.last4 !== undefined) t += "  (key ...." + key.last4 + ")";
        return t;
    }
    function stateText(o) {
        const t = shortText(o), d = o.detail || "";
        return d === "" ? t : t + " - " + d;
    }
    function canDisconnect(o) { return (o.key || {}).present === true || (o.server || {}).present === true }
    function say(t) { message = t }

    // ---- reading ----
    function reload(fresh) {
        const g = gen, n = ++sent;
        Api.get(fresh ? "ui/api/connect?fresh=1" : "ui/api/connect", (ok, b, err) => {
            if (g !== gen) return; // closed, or opened again, before the answer came
            if (n < shown) return; // a newer read was already shown: this older job state would undo it
            shown = n;
            if (!ok) {
                polling = false;
                if ((b || {}).error === "platform-connect-off")
                    return say("Switch on " + box.flagLabel("platform-connect") + " below and click Save to connect platforms here.");
                return say("Connections not available: " + err);
            }
            render(b);
        });
    }
    function render(b) {
        accounts = b.accounts || ({});
        const out = [];
        for (const o of (b.outputs || [])) if (only === "" || o.id === only) out.push(o);
        rows = out;
        if (pasteId !== "" && !out.some(o => o.id === pasteId)) closePaste();
        loaded = true;
        showJob(b.job || ({}));
    }

    function showJob(job) {
        const st = job.state || "";
        if (st === "") { jobText = ""; polling = false; return }
        const running = ["starting", "browser", "device", "saving"].includes(st);
        if (running) polling = true;
        else if (st !== "choose") polling = false;
        let t = "";
        if (st === "browser") t = "Finish the sign-in in the browser window that opened (Google). Waiting...";
        else if (st === "device") t = "On Twitch, enter the code " + (job.userCode || "") + " (the page should have opened: " + (job.verifyUrl || "") + "). Waiting...";
        else if (st === "starting" || st === "saving") t = "Working...";
        else if (st === "done") t = "Connected: the stream key is stored.";
        else if (st === "failed") t = "Sign-in did not finish: " + (job.message || "");
        else if (st === "cancelled") t = "Sign-in cancelled.";
        else if (st === "choose") t = "Signed in to YouTube: choose which stream key to use.";
        for (const w of (job.warnings || [])) t += "\n" + w;
        jobText = t;
        if (st !== "choose") { choiceJob = ""; choiceTexts = []; choiceIds = []; return }
        if (chosenFor === (job.id || "")) return;
        // the stream choice (the widget asks it in a small window; here it is a list on the page)
        chosenFor = job.id || "";
        polling = false;
        const texts = [], ids = [];
        for (const s of (job.streams || [])) {
            texts.push((s.title || "") + " (" + (s.resolution || "") + (s.reusable === true ? ", reusable" : "") + ")");
            ids.push(s.id || "");
        }
        texts.push("Create a new stream key for this output");
        choiceTexts = texts;
        choiceIds = ids;
        choiceJob = chosenFor;
    }

    // ---- writes: each on its own click (D332) ----
    function post(route, body) {
        const g = gen;
        Api.post(route, body, (ok, r, err) => {
            if (g !== gen) return;
            if (!ok) return say("Not done: " + ((r && r.message) ? r.message : err));
            if (r.verdict === "confirm") return confirmHeld(r.pending || ({}));
            afterAllow(r);
        });
    }
    // A held change (D332): the click on this page was the decision, so the pending id is sent at once. No phrase, no
    // second question. The server checks the id, its expiry and the live state again.
    function confirmHeld(pending) {
        const g = gen;
        Api.post("ui/api/confirm", { pendingId: pending.pendingId || "" }, (ok, r, err) => {
            if (g !== gen) return;
            if (!ok) return say("Not done: " + ((r && r.message) ? r.message : err));
            afterAllow(r);
        });
    }
    function afterAllow(r) {
        if (r.job !== undefined) {
            say("");
            showJob(r.job || ({}));
            if (!polling && (r.job || {}).state !== "choose") polling = true;
            return;
        }
        say(r.verdict === "allow" || r.ok === true ? "Done." : "Result: " + (r.verdict || ""));
        reload(true);
    }

    function signIn(id, platform) {
        chosenFor = "";
        post("ui/api/connect/sign-in", { output: id, platform: platform });
    }
    function disconnect(id) { post("ui/api/connect/disconnect", { output: id }) }
    function check() {
        say("Checking...");
        const g = gen;
        Api.post("ui/api/connect/check", {}, (ok, r, err) => {
            if (g !== gen) return;
            say(ok ? "Checked." : "Could not check: " + err);
            reload(true);
        });
    }
    function choose(i) {
        const jobId = choiceJob;
        const sid = i < choiceIds.length ? choiceIds[i] : null; // the last choice: a new stream key
        choiceJob = "";
        choiceTexts = [];
        choiceIds = [];
        const g = gen;
        Api.post("ui/api/connect/choose", { jobId: jobId, streamId: sid }, (ok, r, err) => {
            if (g !== gen) return;
            say(ok ? "Done." : "Not done: " + ((r && r.message) ? r.message : err));
            reload(true);
        });
    }
    function cancelChoice() {
        const jobId = choiceJob;
        choiceJob = "";
        choiceTexts = [];
        choiceIds = [];
        Api.post("ui/api/connect/cancel", { jobId: jobId }, () => {});
        say("Cancelled.");
    }

    // Twitch app client ID: Save sends it and empties the box.
    function twWipe() { twField.clear(); twField.text = "" }
    function saveTwitchClient() {
        const id = twField.text.trim();
        if (id === "") return say("Paste the client ID first.");
        twWipe();
        post("ui/api/connect/twitch-client", { clientId: id });
    }

    // The paste box: a new one (fresh, empty fields) each time it opens; closing it wipes the fields and destroys them.
    function startPaste(id) {
        closePaste();
        pasteId = id;
    }
    function closePaste() {
        if (pasteLoader.item) pasteLoader.item.wipe();
        pasteId = "";
    }
    function pasteOk() {
        const it = pasteLoader.item;
        if (!it || pasteId === "") return false;
        const id = pasteId;
        const key = it.keyText().trim(), server = it.needsServer ? it.serverText().trim() : "";
        closePaste(); // the fields are wiped before the key leaves
        const body = { output: id };
        if (key !== "") body.key = key;
        if (server !== "") body.server = server;
        if (Object.keys(body).length === 1) { say("Nothing to store."); return true }
        post("ui/api/connect/paste", body);
        return true;
    }

    function showOnly(id) {
        only = id;
        if (active) reload(true);
    }

    Timer {
        interval: 1000
        repeat: true
        running: cp.polling && cp.active
        onTriggered: cp.reload(false)
    }

    component Words: Text {
        width: parent ? parent.width : 0
        wrapMode: Text.Wrap
        textFormat: Text.PlainText
        color: Theme.c.text
        font.family: Theme.family
        font.pixelSize: 14
    }
    component Quiet: Text {
        width: parent ? parent.width : 0
        wrapMode: Text.Wrap
        textFormat: Text.PlainText
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: 13
    }

    Quiet {
        objectName: "connIntro"
        text: "Connect each stream output here instead of the Windows Credential Manager tool. Ujwalam stores the keys in "
            + "Windows Credential Manager itself and shows only their last 4 characters. Each change happens on your click; "
            + "an output that is streaming cannot be changed until it stops. A new key is used from "
            + "the next start of that stream."
    }

    UCard {
        title: "STREAM OUTPUTS"
        Quiet { objectName: "connLoading"; visible: !cp.loaded; text: "Loading..." }
        Repeater {
            model: cp.rows
            delegate: Column {
                id: row
                required property var modelData
                width: parent.width
                spacing: 6
                Item {
                    width: parent.width
                    height: Math.max(nameText.implicitHeight, stText.implicitHeight)
                    Text {
                        id: nameText
                        objectName: "connRow:" + row.modelData.id
                        width: 110
                        elide: Text.ElideRight
                        textFormat: Text.PlainText
                        text: row.modelData.label || row.modelData.id
                        color: Theme.c.text
                        font.family: Theme.family
                        font.pixelSize: 14
                        font.weight: Font.DemiBold
                    }
                    Text {
                        id: stText
                        objectName: "connState:" + row.modelData.id
                        x: 118
                        width: parent.width - 118
                        wrapMode: Text.Wrap
                        textFormat: Text.PlainText
                        text: cp.stateText(row.modelData)
                        color: row.modelData.state === "connected" ? Theme.c.text : Theme.c.muted
                        font.family: Theme.family
                        font.pixelSize: 13
                    }
                }
                Flow {
                    width: parent.width
                    spacing: 8
                    UButton {
                        objectName: "connSignIn:" + row.modelData.id
                        visible: !!row.modelData.signIn
                        text: row.modelData.signIn === "youtube" ? "Sign in with YouTube" : "Sign in with Twitch"
                        tip: ((cp.accounts[row.modelData.signIn] || {}).clientSet === true) ? "" : "Set up once first: see SIGN-IN SET-UP below"
                        onClicked: cp.signIn(row.modelData.id, row.modelData.signIn)
                    }
                    UButton {
                        objectName: "connPaste:" + row.modelData.id
                        text: "Paste key..."
                        onClicked: cp.startPaste(row.modelData.id)
                    }
                    UButton {
                        objectName: "connDisconnect:" + row.modelData.id
                        text: "Disconnect"
                        enabled: cp.canDisconnect(row.modelData)
                        onClicked: cp.disconnect(row.modelData.id)
                    }
                }
            }
        }
        UButton {
            objectName: "connShowAll"
            visible: cp.only !== ""
            text: "Show all outputs"
            onClicked: cp.showOnly("")
        }
    }

    // Paste stream key (the widget's small window): a password field for the key and, for an output that takes one, the
    // server address. OK sends what was typed (an empty field keeps what is stored); Cancel sends nothing.
    UCard {
        objectName: "connPasteBox"
        visible: cp.pasteRow !== null
        title: "PASTE STREAM KEY"
        Loader {
            id: pasteLoader
            width: parent.width
            active: cp.pasteRow !== null
            sourceComponent: pasteBox
        }
    }
    Component {
        id: pasteBox
        Column {
            id: pb
            width: parent ? parent.width : 0
            spacing: 8
            readonly property var o: cp.pasteRow || ({})
            readonly property bool needsServer: o.server !== undefined
            readonly property var schemes: ((o.server || {}).schemes || []).map(s => s + "://")
            function keyText() { return keyField.text }
            function serverText() { return serverField.text }
            function typeKey(t) { keyField.text = t }
            function typeServer(t) { serverField.text = t }
            function wipe() { keyField.clear(); keyField.text = ""; serverField.clear(); serverField.text = "" }
            function probe() { return { password: keyField.echoMode === TextInput.Password, keyEmpty: keyField.text.length === 0, serverEmpty: serverField.text.length === 0 } }
            Words { objectName: "connPasteTitle"; text: "Paste stream key: " + (pb.o.label || "") }
            Words { text: "Stream key:" }
            Item {
                objectName: "connKeyBox" // the field itself is not named: the probe tree never lists its text
                width: parent.width
                height: 34
                UField {
                    id: keyField
                    anchors.fill: parent
                    label: "Stream key"
                    echoMode: TextInput.Password // never shown, never echoed back by the server
                    inputMethodHints: Qt.ImhHiddenText | Qt.ImhSensitiveData | Qt.ImhNoPredictiveText | Qt.ImhNoAutoUppercase
                    placeholderText: "Leave empty to keep the stored key"
                }
            }
            Words { visible: pb.needsServer; text: "Server address:" }
            Item {
                objectName: "connServerBox"
                visible: pb.needsServer
                width: parent.width
                height: 34
                UField {
                    id: serverField
                    anchors.fill: parent
                    label: "Server address"
                    inputMethodHints: Qt.ImhSensitiveData | Qt.ImhNoPredictiveText | Qt.ImhNoAutoUppercase
                    placeholderText: (pb.schemes.length ? pb.schemes[0] : "") + "server.name/app  (leave empty to keep the stored one)"
                }
            }
            Quiet {
                objectName: "connServerHint"
                visible: pb.needsServer
                text: "This output takes " + pb.schemes.join(" or ") + " (from the platform's stream settings page)."
            }
            Row {
                spacing: 10
                UButton { objectName: "connPasteOk"; text: "OK"; kind: "primary"; onClicked: cp.pasteOk() }
                UButton { objectName: "connPasteCancel"; text: "Cancel"; onClicked: cp.closePaste() }
            }
        }
    }

    // A sign-in on its way, and the YouTube stream key choice.
    Words {
        objectName: "connJob"
        visible: cp.jobText !== ""
        text: cp.jobText
    }
    UCard {
        objectName: "connChoiceBox"
        visible: cp.choiceJob !== ""
        title: "YOUTUBE STREAM KEY"
        Words { text: "Which YouTube stream key should this output use? (The one you use today is usually \"Default stream key\".)" }
        Repeater {
            model: cp.choiceTexts
            delegate: UButton {
                required property string modelData
                required property int index
                objectName: "connChoice:" + index
                width: Math.min(implicitWidth, parent ? parent.width : implicitWidth)
                text: modelData
                onClicked: cp.choose(index)
            }
        }
        UButton { objectName: "connChoiceCancel"; text: "Cancel"; onClicked: cp.cancelChoice() }
    }
    Words {
        objectName: "connMsg"
        visible: cp.message !== ""
        text: cp.message
    }

    UCard {
        title: "SIGN-IN SET-UP (ONCE)"
        Words { text: "Twitch client ID:" }
        Item {
            width: parent.width
            height: 34
            Item {
                objectName: "connTwitchClientBox" // the field itself is not named: the probe tree never lists its text
                anchors { left: parent.left; right: twSave.left; rightMargin: 8 }
                height: parent.height
                UField {
                    id: twField
                    anchors.fill: parent
                    label: "Twitch app client ID"
                    placeholderText: "Twitch app client ID"
                    inputMethodHints: Qt.ImhSensitiveData | Qt.ImhNoPredictiveText | Qt.ImhNoAutoUppercase
                }
            }
            UButton {
                id: twSave
                objectName: "connTwitchSave"
                anchors.right: parent.right
                text: "Save"
                onClicked: cp.saveTwitchClient()
            }
        }
        Quiet {
            objectName: "connHow"
            text: "YouTube: uses the Google app (OAuth \"Desktop app\" client) already set for clip uploads (Ujwalam/posting/youtube-client-id and -secret). "
                + "Signing in here asks Google for one more permission, managing your YouTube live streams, so you sign in again in the browser even if clip "
                + "uploads are signed in; in the Google Cloud consent screen add the scope .../auth/youtube if Google asks. YouTube live streaming must be "
                + "enabled on the channel.\n"
                + "Twitch: register an app once at dev.twitch.tv > Your Console > Applications > Register (Client Type: Public, OAuth Redirect URL: "
                + "http://localhost), then paste its Client ID above. Ujwalam asks Twitch only to read your stream key.\n"
                + "Kick and other services: use Paste key (Kick events still come through Streamer.bot)."
        }
    }

    UButton {
        objectName: "connCheck"
        text: "Check sign-ins"
        tip: "Asks YouTube and Twitch whether the stored sign-ins still work"
        onClicked: cp.check()
    }

    // ---- probe (tests): states, words and booleans only; never a typed key, server address or client ID ----
    function probe() {
        const pi = pasteLoader.item;
        return {
            loaded: loaded, only: only, rows: rows.map(o => o.label || o.id),
            outputs: rows.map(o => ({ id: o.id, label: o.label || "", state: o.state || "", status: stateText(o), short: shortText(o),
                signIn: o.signIn || "", disconnect: canDisconnect(o) })),
            message: message, job: jobText, polling: polling, choices: choiceJob !== "" ? choiceTexts.slice() : [],
            paste: pi && pasteId !== "" ? Object.assign({ output: pasteId, server: pi.needsServer }, pi.probe()) : null,
            twitchClientEmpty: twField.text.length === 0
        };
    }

    // conn-sign-in:<output> | conn-paste:<output> | conn-key:<text> | conn-server:<text> | conn-paste-ok | conn-paste-cancel
    // | conn-disconnect:<output> | conn-twitch-client:<text> | conn-twitch-save | conn-check | conn-choose:<i>
    // | conn-choose-cancel | conn-all. The probe line lists conn-key, conn-server and conn-twitch-client without their text.
    function probeAction(p) {
        if (!loaded) return false;
        const a = p[0], arg = p.length > 1 ? p.slice(1).join(":") : ""; // a server address has colons: the rest of the action
        const row = (id) => rows.find(o => o.id === id);
        switch (a) {
        case "conn-sign-in": { const o = row(arg); if (!o || !o.signIn) return false; signIn(o.id, o.signIn); return true }
        case "conn-paste": { const o = row(arg); if (!o) return false; startPaste(o.id); return true }
        case "conn-key": if (!pasteLoader.item || pasteId === "") return false; pasteLoader.item.typeKey(arg); return true;
        case "conn-server": if (!pasteLoader.item || pasteId === "" || !pasteLoader.item.needsServer) return false; pasteLoader.item.typeServer(arg); return true;
        case "conn-paste-ok": return pasteOk();
        case "conn-paste-cancel": if (pasteId === "") return false; closePaste(); return true;
        case "conn-disconnect": { const o = row(arg); if (!o || !canDisconnect(o)) return false; disconnect(o.id); return true }
        case "conn-twitch-client": twField.text = arg; return true;
        case "conn-twitch-save": saveTwitchClient(); return true;
        case "conn-check": check(); return true;
        case "conn-choose": {
            const i = parseInt(arg, 10);
            if (choiceJob === "" || isNaN(i) || i < 0 || i >= choiceTexts.length) return false;
            choose(i);
            return true;
        }
        case "conn-choose-cancel": if (choiceJob === "") return false; cancelChoice(); return true;
        case "conn-all": if (only === "") return false; showOnly(""); return true;
        }
        return false;
    }
}
