// SPDX-License-Identifier: GPL-3.0-or-later
// The QML studio's state and its calls to the UI server (D355). Same routes, same order of loads and the same rules as
// the widget studio (main_window.cpp: loadScenes, loadLayers, loadMixer, pollStatus, pollMeters, hostAction, confirm),
// so both windows behave the same while they live side by side.
import QtQuick
import Ujwalam.Core

QtObject {
    id: store

    // ---- state ----
    property var scenes: []          // merged by id: {id, name, canvases: ["h","v"], active}
    property string activeScene: ""
    property string canvas: "h"      // the canvas the layer list shows
    property var layers: []          // host order: bottom first
    property string selected: ""     // layer id
    property var mixer: []           // mixer.list sources
    property var tracks: []          // project audio tracks (D273)
    property var peaks: ({})         // source id -> peak dB, refreshed every 250 ms
    property bool routeBusy: false
    property bool live: false
    property bool recording: false
    property bool hostUp: false
    property bool coreUp: false
    property bool fake: false
    property int dropped: 0
    property real fps: 0
    property real cpu: 0
    property real gpu: 0
    property bool canStream: false
    property bool canRecord: false
    property var onAir: ({})         // status host.onAir: liveForMs, recordForMs, kbps, sinks
    property var tasks: []
    property bool previewEditing: false
    property var flags: ({})         // flag id -> on (ui/api/flags), read after each status poll as the widget does
    readonly property bool routing: flags["mixer-routing"] === true && tracks.length > 0
    readonly property bool sceneEdit: flags["scene-edit"] === true // deleting scenes needs it (D240); adding does not
    property var structure: ({})     // ui/api/project/structure: what a new layer can be made from (devices, overlays, assets)
    property bool addOpen: false     // an add window is open: a device plugged in or out refreshes its lists (D329)
    property string note: ""

    readonly property var activeSceneObj: scenes.find(s => s.id === activeScene) || null
    readonly property bool bothCanvases: !!activeSceneObj && activeSceneObj.canvases.length > 1
    readonly property var selectedLayer: layers.find(l => l.id === selected) || null
    readonly property int activeTasks: tasks.filter(t => t.state === "running" || t.state === "waiting").length

    signal confirmNeeded(var pending)
    signal hostRestarted()
    signal addLayerReady(string sceneId, string sceneName)
    signal addSceneReady(var canvases)

    // ---- private ----
    property real pHostUptime: -1
    property int pPreviewSeq: -1
    property int pDevicesSeq: -1
    property var pSelSeqs: ({})
    property string pSelSent: ""
    property bool pMeterBusy: false

    function say(text) { note = text; Api.log("studio note: " + text) }

    function unwrap(body, key) {
        const r = body ? body.result : undefined;
        if (Array.isArray(r)) return r;
        return r && Array.isArray(r[key]) ? r[key] : [];
    }
    function canvasesOf(s) {
        if (Array.isArray(s.canvases)) return s.canvases.map(c => String(c).toLowerCase());
        return s.canvas !== undefined ? [String(s.canvas).toLowerCase()] : [];
    }
    function layerArgs(extra) {
        const o = { scene: activeScene };
        if (bothCanvases) o.canvas = canvas;
        for (const k in (extra || {})) o[k] = extra[k];
        return o;
    }

    function start() {
        loadScenes();
        pollStatus();
    }

    // ---- scenes ----
    function loadScenes() {
        Api.host("scenes.list", {}, (ok, b, err) => {
            if (!ok) return say("Scenes: " + err);
            // the host lists a scene once per canvas; merge by id
            const merged = [], at = {};
            for (const s of unwrap(b, "scenes")) {
                const cv = canvasesOf(s);
                if (at[s.id] === undefined) {
                    at[s.id] = merged.length;
                    merged.push({ id: s.id, name: s.name || s.id, canvases: cv, active: !!s.active });
                } else {
                    const e = merged[at[s.id]];
                    for (const c of cv) if (!e.canvases.includes(c)) e.canvases.push(c);
                    if (s.active) e.active = true;
                }
            }
            scenes = merged;
            if (!merged.some(s => s.id === activeScene)) {
                const a = merged.find(s => s.active);
                activeScene = a ? a.id : (merged.length ? merged[0].id : "");
            }
            if (!bothCanvases && activeSceneObj && activeSceneObj.canvases.length === 1) canvas = activeSceneObj.canvases[0];
            loadLayers();
            loadMixer();
        });
    }

    function activateScene(id) {
        Api.host("scenes.activate", { scene: id }, (ok, b, err) => {
            if (!ok) return say("Scene switch failed: " + err);
            activeScene = id;
            selected = "";
            loadScenes();
        });
    }

    function showCanvas(c) {
        if (c === canvas) return;
        canvas = c;
        selected = "";
        loadLayers();
    }

    // ---- layers ----
    function loadLayers() {
        if (!activeScene) { layers = []; return; }
        Api.host("layers.list", layerArgs(), (ok, b, err) => {
            if (!ok) return say("Layers: " + err);
            layers = unwrap(b, "layers");
            if (selected && !layers.some(l => l.id === selected)) selected = "";
            syncPreviewSelection();
        });
    }

    function select(id) {
        selected = id;
        syncPreviewSelection();
    }

    function setVisible(id, visible) {
        Api.host("layers.setVisible", layerArgs({ layer: id, visible: visible }), (ok, b, err) => {
            if (!ok) say("Show/hide failed: " + err);
            loadLayers();
        });
    }

    // ---- adding and deleting scenes and layers (the widget's openAddLayer, openAddScene, layerDelete, sceneDelete and
    // structureEdit): the windows only build the body; one structure route sends it and the project file is saved too.
    // Adding and deleting a layer need no flag, only "not live" (D330); deleting a scene needs scene editing (D240).
    function plainStructureError(code) {
        const words = {
            "live-locked": "Not while live.",
            "scene-edit-off": "Turn on scene editing in Settings > Advanced first.",
            "scene-active": "That scene is the one the project starts with; make another scene the start scene first.",
            "last-scene": "The last scene cannot be deleted.",
            "layer-copied": "Another layer shows this one; delete that copy first.",
            "layer-has-audio": "Its sound is in the mixer, so it cannot be deleted here.",
            "bad-name": "Type a name of 1 to 80 characters.",
            "no-project-file": "No project file is open, so nothing can be saved.",
            "too-many-layers": "This scene has the most layers it can hold.",
            "too-many-scenes": "The project has the most scenes it can hold.",
            "host-unavailable": "The studio host is not reachable."
        };
        return words[code] || code;
    }

    // The choices are read fresh each time a window opens (new assets, devices).
    function loadStructure(then) {
        Api.get("ui/api/project/structure", (ok, b, err) => {
            if (!ok) return say("Cannot add: " + err);
            if (!b.available) return say("Adding needs a loaded project file.");
            structure = b;
            if (then) then(b);
        });
    }

    function addLayer(sceneId) {
        if (live) return say("Not while live.");
        const id = sceneId || activeScene;
        if (!id) return say("Pick a scene first.");
        const s = scenes.find(x => x.id === id);
        loadStructure(() => addLayerReady(id, s ? s.name : id));
    }

    function addScene() {
        if (live) return say("Not while live.");
        loadStructure((b) => addSceneReady(Array.isArray(b.canvases) ? b.canvases : []));
    }

    function deleteLayer() {
        if (!selectedLayer) return say("Select a layer first.");
        if (live) return say("Not while live.");
        structureEdit({ op: "layer.remove", scene: activeScene, layer: selected });
    }

    function deleteScene(id) {
        if (live) return say("Not while live.");
        if (!sceneEdit) return say("Turn on scene editing in Settings > Advanced to delete scenes.");
        structureEdit({ op: "scene.remove", scene: id });
    }

    function structureEdit(body) {
        if (live) return say("Live: scenes and layers cannot be added or removed.");
        Api.post("ui/api/project/structure", body, (ok, b, err) => {
            if (!ok) {
                const detail = b && b.detail ? String(b.detail) : "";
                // The host's refusals are full sentences (D329): show them alone, not behind an HTTP code.
                if (b && b.error === "host-error" && detail) say("Not done: " + detail);
                else say("Not done: " + plainStructureError(err) + (detail ? " (" + detail + ")" : ""));
            } else {
                if ((b.op === "layer.add" || b.op === "layer.duplicate") && b.layer && b.layer.id) selected = b.layer.id; // the new layer
                const waiting = b.waiting ? String(b.waiting) : ""; // a capture layer added without its device
                say((waiting ? "Layer added. " + waiting : "Done: " + b.op) +
                    (b.saved ? "" : ". Not saved to the project file: the change is live only."));
            }
            loadScenes();
        });
    }

    // D335 F8: the layer selected in the list is the one the mouse edits on that canvas's preview (a hidden layer, or
    // one without a placement, selects none). Sent once per change; a refusal (live, mid-drag) is left to the next change.
    function syncPreviewSelection() {
        if (!previewEditing || !activeScene) return;
        const l = selectedLayer;
        const layer = l && l.placement !== undefined && l.visible ? selected : "";
        const key = canvas + "/" + activeScene + "/" + layer;
        if (key === pSelSent) return;
        pSelSent = key;
        const p = { canvas: canvas };
        if (layer) p.layer = layer;
        Api.host("preview.select", p, () => {});
    }

    function followPreview(sel) {
        const cur = sel ? sel[canvas.toUpperCase()] : null;
        if (!cur || cur.scene !== activeScene) return;
        const layer = cur.layer || "";
        pSelSent = canvas + "/" + activeScene + "/" + layer; // no echo
        if (layer !== selected) selected = layer;
    }

    // ---- mixer ----
    function loadMixer() {
        Api.host("mixer.list", {}, (ok, b, err) => {
            if (!ok) return say("Mixer: " + err);
            mixer = unwrap(b, "sources");
            tracks = unwrap(b, "tracks");
            takePeaks(mixer);
        });
    }

    function takePeaks(list) {
        const p = {};
        for (const m of list) p[m.id] = typeof m.peakDb === "number" ? m.peakDb : -100;
        peaks = p;
    }

    property bool paused: false      // the window is minimised: no meter polls

    function pollMeters() {
        if (pMeterBusy || paused || !mixer.length) return;
        pMeterBusy = true;
        Api.host("mixer.list", {}, (ok, b) => {
            pMeterBusy = false;
            if (ok) takePeaks(unwrap(b, "sources")); // a missed meter frame is harmless
        });
    }

    function setVolume(id, db) {
        Api.host("mixer.setVolume", { id: id, db: Math.round(db) }, (ok, b, err) => {
            if (!ok) { say("Volume failed: " + err); loadMixer(); }
        });
    }
    function setMute(id, muted) {
        Api.host("mixer.setMute", { id: id, muted: muted }, (ok, b, err) => {
            if (!ok) say("Mute failed: " + err);
            loadMixer();
        });
    }
    function setCue(id, cue) {
        Api.host("mixer.setCue", { id: id, cue: cue }, (ok, b, err) => {
            if (!ok) say("CUE failed: " + err);
            loadMixer();
        });
    }
    function setTracks(id, list) {
        if (routeBusy) { say("A track change is still on its way; try again in a moment."); return loadMixer(); }
        routeBusy = true;
        Api.host("mixer.setTracks", { id: id, tracks: list }, (ok, b, err) => {
            routeBusy = false;
            if (ok && b.verdict === "confirm") confirmNeeded(b.pending); // a held action (D332)
            else if (!ok) say("Tracks not changed: " + err);
            else say(b.saved === "pending" ? "Tracks changed." : "Tracks changed, live only: not saved to the project file.");
            loadMixer();
        });
    }

    // ---- stream and recording (the widget's hostAction / confirm, D332: one click) ----
    function toggleStream() { hostAction(live ? "stream.stop" : "stream.start") }
    function toggleRecord() { hostAction(recording ? "record.stop" : "record.start") }

    function hostAction(method) {
        Api.host(method, {}, (ok, b, err) => {
            if (!ok) return say("Not done: " + err);
            if (b.verdict === "confirm" || b.verdict === "readiness-failed") return confirmNeeded(b.pending);
            if (b.warning) say(b.warning);
            pollStatus();
        });
    }

    function answer(pendingId, allow) {
        if (!allow) {
            Api.post("ui/api/cancel", { pendingId: pendingId }, () => {});
            return say("Cancelled.");
        }
        Api.post("ui/api/confirm", { pendingId: pendingId }, (ok, r, err) => {
            if (!ok) return say("Not done: " + err);
            if (r.verdict === "confirm" || r.verdict === "readiness-failed") return confirmNeeded(r.pending);
            say(r.verdict === "allow" ? "Done." : "Result: " + r.verdict);
            if (r.warning) say(r.warning);
            pollStatus();
            loadScenes();
        });
    }

    // ---- status, every 2 s ----
    function pollStatus() {
        Api.get("ui/api/status", (ok, s, err) => {
            if (!ok) { hostUp = false; return say("Status: " + err); }
            const h = s.host || {}, c = s.core || {};
            live = h.live === true;
            recording = h.recording === true;
            hostUp = h.available === true;
            fake = h.blockedOnHost === true;
            coreUp = c.available === true;
            dropped = h.droppedFrames || 0;
            fps = h.fps || 0;
            cpu = h.cpuPct || 0;
            gpu = h.gpuPct || 0;
            const ready = h.outputsReady || {};
            canStream = ready.stream === true;
            canRecord = ready.record === true;
            onAir = h.onAir || {};
            tasks = Array.isArray(s.tasks) ? s.tasks : [];
            // A restarted host (crash supervisor) lost the previews it drew in our windows: embed them again (D280).
            const up = typeof h.uptimeMs === "number" ? h.uptimeMs : -1;
            if (up >= 0 && pHostUptime >= 0 && up < pHostUptime) hostRestarted();
            if (up >= 0) pHostUptime = up;
            const pe = h.previewEditing === true;
            if (pe !== previewEditing) { previewEditing = pe; pSelSent = ""; syncPreviewSelection(); }
            // D335 F8: a click on this canvas's preview picked another layer: the list follows.
            const ps = h.previewSelection || {};
            const seqs = ps.seqs || {};
            const cv = canvas.toUpperCase();
            if (typeof seqs[cv] === "number" && pSelSeqs[cv] !== undefined && seqs[cv] !== pSelSeqs[cv] && previewEditing) followPreview(ps);
            const nextSeqs = {};
            for (const k of ["H", "V"]) if (typeof seqs[k] === "number") nextSeqs[k] = seqs[k];
            pSelSeqs = nextSeqs;
            // A layer moved or resized with the mouse on the preview (D230): select it and reload the layers.
            const ed = h.previewEdit;
            if (ed && typeof ed.seq === "number") {
                if (pPreviewSeq >= 0 && ed.seq !== pPreviewSeq && ed.scene === activeScene) { selected = ed.layer || selected; loadLayers(); }
                pPreviewSeq = ed.seq;
            }
            // A device was plugged in or out (D329): the layer list shows waiting or connected again.
            const dv = h.devices;
            if (dv && typeof dv.seq === "number") {
                if (pDevicesSeq >= 0 && dv.seq !== pDevicesSeq) { loadLayers(); if (addOpen) loadStructure(); }
                pDevicesSeq = dv.seq;
            }
            loadFlags();
        });
    }

    function loadFlags() {
        Api.get("ui/api/flags", (ok, b) => {
            if (!ok || !Array.isArray(b.flags)) return;
            const f = {};
            for (const x of b.flags) f[x.id] = x.on === true;
            if (JSON.stringify(f) !== JSON.stringify(flags)) flags = f;
        });
    }

    function probeState() {
        return {
            scenes: scenes.map(s => s.name), activeScene: activeScene, canvas: canvas,
            layers: layers.map(l => ({ id: l.id, visible: !!l.visible })), selected: selected,
            mixer: mixer.map(m => ({ id: m.id, name: m.name, volumeDb: m.volumeDb, muted: !!m.muted, cue: !!m.cue })),
            live: live, recording: recording, canStream: canStream, canRecord: canRecord, hostUp: hostUp, note: note
        };
    }

    property Timer pStatus: Timer { interval: 2000; repeat: true; running: true; onTriggered: store.pollStatus() }
    property Timer pMeters: Timer { interval: 250; repeat: true; running: true; onTriggered: store.pollMeters() }
}
