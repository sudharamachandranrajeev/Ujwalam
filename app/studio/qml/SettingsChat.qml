// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Chat & bots (the widget's streampages::IntegrationsPage, flag integrations; plan Q3 slice 5): the ports of
// Streamer.bot and Speaker.bot with a Test button each, and Allow remote connections with its network address and a
// pairing code for the clipboard. It loads ui/api/integrations when Settings opens (flag on); Save sends the value only when
// something changed (the server checks every value again). The ports and the remote choice apply at the next start.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Column {
    id: ch
    required property var box
    width: parent ? parent.width : 0
    spacing: 12

    // ---- state ----
    property bool loaded: false
    property bool started: false          // the load is on its way or done (Settings starts it as soon as the flags are known)
    property int gen: 0                   // a newer load or reset drops older answers
    property var orig: ({})               // the value as loaded: what Save compares with and builds on
    property bool existed: false
    property int sbPort: 0
    property int spPort: 0
    property bool remote: false
    property string address: ""           // "" = automatic
    property var lan: []
    property bool running: false
    property string sbStatus: "Not tested"
    property string spStatus: "Not tested"
    property string info: ""

    readonly property bool active: box.ready && box.flagOn("integrations")
    readonly property var addrModel: {
        const m = [{ value: "", text: "Automatic (first home network address)" }];
        for (const a of lan) m.push({ value: a, text: a });
        if (address !== "" && !lan.includes(address)) m.push({ value: address, text: address }); // a saved address this PC no longer has
        return m;
    }
    readonly property bool dirty: {
        if (!loaded) return false;
        const b = orig.bots || ({}), r = orig.remote || ({});
        const port = (id) => ((b[id] || ({})).port);
        const oa = typeof r.address === "string" && r.address !== "" ? r.address : "";
        return sbPort !== port("streamerbot") || spPort !== port("speakerbot") || remote !== (r.enabled === true) || address !== oa;
    }

    onActiveChanged: { if (!active) reset(); else if (!started) load() }
    visible: active
    enabled: loaded

    function problemsText(arr) { return (arr || []).map(p => p.text).join("; ") }
    function clampPort(n) { return Math.max(1024, Math.min(65535, typeof n === "number" && !isNaN(n) ? Math.round(n) : 1024)) }

    function reset() {
        gen++;
        started = false;
        loaded = false;
        orig = ({});
        existed = false;
        sbPort = 0;
        spPort = 0;
        remote = false;
        address = "";
        lan = [];
        running = false;
        sbStatus = "Not tested";
        spStatus = "Not tested";
        info = "";
    }

    function load() {
        const g = ++gen;
        started = true;
        Api.get("ui/api/integrations", (ok, b, err) => {
            if (g !== gen) return; // closed, or opened again, before the answer came
            if (!ok) { info = "Integrations not available: " + err; return }
            const val = b.value || ({}), bots = val.bots || ({}), rem = val.remote || ({}), run = b.remote || ({});
            orig = JSON.parse(JSON.stringify(val));
            existed = b.exists === true;
            sbPort = clampPort((bots.streamerbot || ({})).port);
            spPort = clampPort((bots.speakerbot || ({})).port);
            lan = Array.isArray(run.lan) ? run.lan.map(String) : [];
            remote = rem.enabled === true;
            address = typeof rem.address === "string" ? rem.address : "";
            running = run.running === true;
            info = running ? "Listening on " + run.address + ":" + run.port + " (home network only)."
                : lan.length === 0 ? "Not running. No home network address found on this PC." : "Not running.";
            if (b.corrupt === true) info = "The saved integrations file could not be read; defaults are shown (remote connections off).";
            loaded = true;
        });
    }

    // ---- changes ----
    function setPort(id, n) {
        if (!loaded) return false;
        if (id === "streamerbot") sbPort = clampPort(n); else spPort = clampPort(n);
        return true;
    }
    function setRemote(on) {
        if (!loaded) return false;
        remote = on;
        return true;
    }

    function test(bot) {
        if (!loaded) return false;
        const g = gen, sb = bot === "streamerbot", port = sb ? sbPort : spPort;
        const say = (t) => { if (sb) sbStatus = t; else spStatus = t };
        say("Testing...");
        Api.post("ui/api/integrations/test", { bot: bot, port: port }, (ok, b, err) => {
            if (g !== gen) return;
            if (!ok) return say("Test failed: " + err);
            say(b.answered === true ? "Connected (127.0.0.1:" + port + " answers)"
                : "Not reachable on 127.0.0.1:" + port + ". Is it running, with its WebSocket server on?");
        });
        return true;
    }

    // What Save sends: nothing when nothing changed. The page goes with the Settings window right after Save, so the
    // answer only needs the store.
    function save() {
        if (!dirty) return;
        const val = JSON.parse(JSON.stringify(orig));
        val.bots = { streamerbot: { port: sbPort }, speakerbot: { port: spPort } };
        val.remote = { enabled: remote, address: address === "" ? null : address };
        const store = box.store, g = gen;
        Api.post("ui/api/integrations", { value: val }, (ok, b, err) => {
            if (ok) {
                if (g === gen) { orig = val; existed = true }
                return store.say("Integrations saved; they apply at the next start.");
            }
            const why = problemsText(b && b.problems);
            store.say("Integrations not saved: " + (why !== "" ? why : err));
        });
    }

    function copyCode() {
        const g = gen;
        Api.post("ui/api/integrations/remote-token", {}, (ok, b, err) => {
            if (g !== gen) return;
            if (!ok) { info = "No pairing code: " + err; return }
            Api.copyText(String(b.token || "")); // the code is never kept or shown here
            info = "Pairing code copied. Paste it on the other device only.";
        });
    }

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
    component Field: Column {
        property string label: ""
        width: 250
        spacing: 4
        Words { text: parent.label }
    }
    // a box that follows the page's value even after the user picked one (a picked value breaks a plain binding)
    component PickBox: UCombo {
        id: pb
        property int want: 0
        Binding { target: pb; property: "currentIndex"; value: pb.want }
    }
    component PortBox: USpin {
        id: sb
        property int want: 0
        from: 1024
        to: 65535
        Binding { target: sb; property: "value"; value: sb.want }
    }

    UCard {
        title: "STREAMER.BOT"
        Flow {
            width: parent.width
            spacing: 14
            Field {
                label: "Address:"
                UField { objectName: "streamerbotAddress"; width: parent.width; label: "Address"; text: "127.0.0.1"; readOnly: true }
            }
            Field {
                label: "Port:"
                PortBox { objectName: "streamerbotPort"; label: "Streamer.bot port"; want: ch.sbPort; onValueModified: ch.setPort("streamerbot", value) }
            }
        }
        Row {
            spacing: 10
            UButton { objectName: "streamerbotTest"; text: "Test"; onClicked: ch.test("streamerbot") }
            Words { objectName: "streamerbotStatus"; anchors.verticalCenter: parent.verticalCenter; text: ch.sbStatus }
        }
        Quiet { text: "Ujwalam only reads from Streamer.bot (chat and events); it never sends it actions. A new port is used from the next start." }
    }

    UCard {
        title: "SPEAKER.BOT"
        Flow {
            width: parent.width
            spacing: 14
            Field {
                label: "Address:"
                UField { objectName: "speakerbotAddress"; width: parent.width; label: "Address"; text: "127.0.0.1"; readOnly: true }
            }
            Field {
                label: "Port:"
                PortBox { objectName: "speakerbotPort"; label: "Speaker.bot port"; want: ch.spPort; onValueModified: ch.setPort("speakerbot", value) }
            }
        }
        Row {
            spacing: 10
            UButton { objectName: "speakerbotTest"; text: "Test"; onClicked: ch.test("speakerbot") }
            Words { objectName: "speakerbotStatus"; anchors.verticalCenter: parent.verticalCenter; text: ch.spStatus }
        }
        Quiet { text: "Used for the pre-stream check. A new port is used from the next start." }
    }

    UCard {
        title: "REMOTE CONNECTIONS"
        USwitch {
            id: remSw
            objectName: "integrationsRemote"
            width: parent.width
            text: "Allow remote connections"
            checked: ch.remote
            onToggled: ch.setRemote(checked)
            Binding { target: remSw; property: "checked"; value: ch.remote }
        }
        Quiet {
            text: "Off by default. When on, devices on your home network (the same Wi-Fi or cable network) can read Ujwalam's status and send requests, "
                + "after pairing with a code from this page. It never listens on the internet, and it cannot change scenes or start a stream by itself. "
                + "Turn it off when you do not use it. It starts with the next start of Ujwalam."
        }
        Field {
            label: "Network address:"
            width: 330
            PickBox {
                objectName: "integrationsAddress"
                width: parent.width
                label: "Network address"
                enabled: ch.remote
                model: ch.addrModel
                want: Math.max(0, ch.addrModel.findIndex(m => m.value === ch.address))
                onChose: (v) => { if (ch.loaded) ch.address = v }
            }
        }
        Quiet { objectName: "integrationsInfo"; text: ch.info }
        UButton { objectName: "integrationsCopy"; text: "Copy pairing code"; enabled: ch.running; onClicked: ch.copyCode() }
    }

    // ---- probe (tests): the same names and values as the widget page's probe ----
    function probe() {
        return { loaded: loaded, streamerbotPort: sbPort, speakerbotPort: spPort, streamerbotStatus: sbStatus, speakerbotStatus: spStatus,
            remote: remote, remoteInfo: info, address: address, dirty: dirty };
    }

    // int-test:<streamerbot|speakerbot> | int-remote:<on|off>   (the widget's names; int-port is new, for the range)
    function probeAction(p) {
        if (!loaded) return false;
        const a = p[0], arg = p[1];
        if (a === "int-test" && (arg === "streamerbot" || arg === "speakerbot")) return test(arg);
        if (a === "int-remote" && (arg === "on" || arg === "off")) return setRemote(arg === "on");
        if (a === "int-port" && p.length === 3 && (arg === "streamerbot" || arg === "speakerbot")) {
            const n = parseInt(p[2], 10);
            return !isNaN(n) && setPort(arg, n);
        }
        return false;
    }
}
