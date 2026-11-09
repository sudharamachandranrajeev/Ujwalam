// SPDX-License-Identifier: GPL-3.0-or-later
// Meld-like studio window (P5a): scenes + layers (left), H/V previews (centre), inspector + mixer (right),
// Stream / Record and status pills (top). Every action goes through the UI server (ApiClient); stream and record
// changes come back as a typed confirmation ("yes" / "yes, on air") shown in a dialog.
#pragma once

#include "api_client.h"

#include <QJsonArray>
#include <QMainWindow>
#include <QMap>
#include <QPointer>

#include <functional>

class QDialog;
class QLabel;
class QListWidget;
class QAction;
class QPushButton;
class QDoubleSpinBox;
class QSpinBox;
class QHBoxLayout;
class QVBoxLayout;
class QProgressBar;
class QButtonGroup;
class QTimer;
class QFormLayout;
class QGroupBox;
class QComboBox;
class QLineEdit;
class QMenu;
class QToolButton;
class QCheckBox;
class TaskBar;
class TrayKeeper;
class LookPanel;
class StatsCards;
class Guide;

// A native child widget the host draws a canvas preview into (P5a step 4): the host makes its preview a child
// window of this widget's handle and resizes it when the slot changes size. If the host refuses (no canvas yet, host
// down), the slot shows why and the "Own window" button still opens a host window. Display rule: D219.
class PreviewSlot : public QWidget {
public:
	PreviewSlot(ApiClient *api, QString canvas, QWidget *parent);
	void embed();
	void schedule(); // debounced embed (resize, move)
	void setMessage(const QString &text);
	QString message() const;

protected:
	void resizeEvent(QResizeEvent *e) override;
	void showEvent(QShowEvent *e) override;

private:
	ApiClient *api_;
	QString canvas_;
	class QTimer *debounce_;
	class QLabel *msg_;
	bool busy_ = false, again_ = false;
};

class MainWindow : public QMainWindow {
	Q_OBJECT
public:
	explicit MainWindow(ApiClient *api, QWidget *parent = nullptr);
	void start(); // first loads after login
	// Headless probe (tests only, UJWALAM_STUDIO_PROBE_MS): what the panels show now, as plain data. Never shown.
	QJsonObject probe() const;
	QWidget *settingsWindow() const; // the open Settings window (tests: for the picture)
	void refreshGuide();             // tips/tour cards re-placed (tests: before a picture)

protected:
	void closeEvent(class QCloseEvent *e) override; // one close for the whole app (D280)

public:
	// Probe action (tests only, UJWALAM_STUDIO_PROBE_ACTIONS, D275): clicks the real widget so its own handler runs.
	// flag-off:<id> | mute:<strip> | track:<strip>:<n> | undo. false: no such widget. Never types a confirm phrase.
	bool probeAction(const QString &action);

private:
	QWidget *buildLeft();
	QWidget *buildCentre();
	QWidget *buildRight();
	QWidget *buildMixer();
	QWidget *buildTop();
	QWidget *buildControls(); // round Start stream / Record / Save clip / Mark moment buttons (D290)
	QPushButton *roundButton(QWidget *parent, const QString &icon, const QString &caption, const QString &tip, const QString &role, QLayout *into);
	void setControl(QPushButton *b, const QString &icon, const QString &caption);

	void loadScenes();
	void loadLayers();
	void loadMixer();
	void pollStatus();
	void updateAlerts(const QJsonArray &alerts); // live alert strip (flag live-test-kit, D305 proposed)
	void pollMeters();
	void renderScenes();
	void renderLayers();
	void renderInspector();
	void renderMixer();
	void applyInspector();
	void renderEffects();    // effect editor (D260): the working list
	void renderEffectForm(); // the selected effect's settings
	void applyEffects();
	void applyLook();          // Look panel (D290): sends the working list now, or after the send in flight
	void editEffects(const std::function<void(QJsonArray &, int &)> &change);
	void nudge(int dx, int dy);
	void sendNudge();
	void hostAction(const QString &method);
	// Settings (D284): clips (ask / after / while / off, for recordings and for streams) and the save folders.
	void openSettings(bool firstRun);
	void saveSettings(const QJsonObject &body, bool retried = false);
	void askClips(const QJsonObject &ask);
	void answerClips(const QString &id, bool make, bool remember);
	void updateClips(const QJsonObject &cl);
	void loadEdits();             // undo / redo state (UI server history, D238)
	void undoRedo(bool undo);
	void loadFlags();             // feature flags (D149): on needs the typed phrase, off is instant
	void setFlag(const QString &id, bool on);
	void loadUiSettings();        // settings.json ui.motion -> motion::setMode (D290)
	// Scene and layer structure edits (D240, flag scene-edit) and transitions (D242, flag transitions): the UI server
	// edits the project file and the host; both are refused while live.
	void loadStructure();
	void renderAddPick();
	void structureEdit(const QJsonObject &body);
	// Right-click menus and keys on the layer and scene lists (D292): the same actions as the buttons plus duplicate,
	// rename, copy / paste look, delete. Duplicate and rename work without the scene-edit flag; delete needs it.
	void showLayerMenu(const QPoint &pos);
	void showSceneMenu(const QPoint &pos);
	QMenu *buildLayerMenu(QWidget *parent, bool blank = false);
	QMenu *buildSceneMenu(QWidget *parent, const QString &sceneId, bool blank = false);
	void layerDuplicate();
	void layerRename();
	void layerDelete();
	void layerMoveTo(int index);
	void layerToggleVisible();
	void lookCopy();
	void lookPaste();
	void lookFocus();
	void sceneRename(const QString &id);
	void sceneDuplicate(const QString &id);
	void sceneDelete(const QString &id);
	QString sceneKeyId() const; // the scene the scene list's current row names
	void loadTransitions();
	void renderTransition();
	void applyTransition();
	// Streamer.bot / Speaker.bot start and stop (BM, flag bot-manager): typed "yes" each; stop ends only a copy
	// Ujwalam started (the server checks).
	void loadBots();
	void openAddLayer(const QString &sceneId = QString()); // add-layer window (D274, D292): kinds with what they are, a searchable pick list
	void openAddScene();   // add-scene window (D292): a name
	void updateAddButtons();
	void openImport();   // Meld session import -> host check -> typed confirm -> project.load (the page's flow)
	void openPosts();    // flag posting (P16a): review clip packages; YouTube private upload needs "yes, upload"
	void report();       // flag report-button (D199): prefilled GitHub issue link opened in the user's browser
	void openFeedback(); // post-stream notes on feedback moments (D150), the browser page's form
	void botAction(const QString &bot, bool start);
	void confirm(const QJsonObject &pending);
	void note(const QString &text);
	QJsonObject layerArgs(const QJsonObject &extra = {}) const;
	QJsonObject selectedLayer() const;

	ApiClient *api_;
	QString canvas_ = QStringLiteral("h");
	QString activeScene_;
	QString selected_;
	QJsonArray scenes_, layers_, mixer_;
	QJsonArray mixerTracks_;     // mixer.list tracks: the project audio tracks [{id, name}] (D273)
	bool mixerRoutingOn_ = false; // flag mixer-routing: a button per track on each mixer strip
	int routeButtons_ = 0;        // track buttons shown (headless probe)
	bool routeBusy_ = false;      // a routing change is on its way: further track clicks wait for the answer
	void setTracks(const QString &id, const QStringList &tracks);
	bool live_ = false, recording_ = false, meterBusy_ = false;
	double hostUptime_ = -1; // host.status uptimeMs: going down means the host restarted (D280)
	bool previewEditing_ = false; // host switch for preview editing = flag preview-edit (status host.previewEditing)
	int nudgeDx_ = 0, nudgeDy_ = 0; // arrow-key nudge not sent yet (D254)
	bool nudgeBusy_ = false;
	// Effect editor (D260, flag effect-editor): a working copy of the selected layer's effects; Apply sends it whole.
	bool effectEditing_ = false;
	QJsonArray effEdit_;
	QString effLayer_;     // "<scene>/<layer>" effEdit_ belongs to
	QPointer<QDialog> settingsDlg_; // Settings window, while open (D290)
	LookPanel *look_ = nullptr;
	QLabel *lookCap_ = nullptr;
	bool lookSending_ = false, lookAgain_ = false;
	int effRev_ = 0;       // bumped on every change of effEdit_; an Apply answer for an older draft keeps it dirty
	bool effDirty_ = false; // changed since it was read from the host
	int previewSeq_ = -1; // newest host preview mouse edit seen (status previewEdit.seq, D230); -1 = none yet

	QListWidget *sceneList_ = nullptr;
	QListWidget *layerList_ = nullptr;
	QListWidget *flagList_ = nullptr;
	bool sceneEditOn_ = false, transitionsOn_ = false, botsOn_ = false;
	int botPoll_ = 0; // bot status reads the process list: every 5th status poll (10 s), and after each action
	QGroupBox *botBox_ = nullptr;
	QAction *reportAct_ = nullptr, *postsAct_ = nullptr; // in the More menu (D285)
	QVBoxLayout *botRows_ = nullptr;
	QJsonObject structure_;   // GET /ui/api/project/structure
	QJsonArray lookClip_;     // Copy look (D292): the effects list of the layer copied, in this process only
	bool hasLookClip_ = false;
	QPointer<QDialog> addDlg_; // the open Add layer / Add scene window (one at a time)
	QToolButton *addSceneBtn_ = nullptr, *addLayerBtn_ = nullptr;
	QJsonObject lastMenu_;    // the last menu built, for the probe
	QJsonObject transitions_; // GET /ui/api/project/transitions
	QGroupBox *structBox_ = nullptr, *transBox_ = nullptr;
	QComboBox *addKind_ = nullptr, *addPick_ = nullptr;
	QLineEdit *addText_ = nullptr;
	QComboBox *trCanvas_ = nullptr, *trType_ = nullptr, *trFile_ = nullptr;
	QSpinBox *trMs_ = nullptr, *trPoint_ = nullptr;
	QCheckBox *trAudio_ = nullptr;
	QPushButton *tabH_ = nullptr, *tabV_ = nullptr;
	QWidget *inspForm_ = nullptr;
	QLabel *inspTitle_ = nullptr, *inspEmpty_ = nullptr;
	QDoubleSpinBox *inX_ = nullptr, *inY_ = nullptr, *inW_ = nullptr, *inH_ = nullptr, *inRot_ = nullptr;
	QSpinBox *crL_ = nullptr, *crT_ = nullptr, *crR_ = nullptr, *crB_ = nullptr;
	QGroupBox *effBox_ = nullptr; // "Advanced effects": the plain list (flag effect-editor)
	QListWidget *effList_ = nullptr;
	QFormLayout *effForm_ = nullptr;
	QHBoxLayout *mixerBox_ = nullptr; // strips side by side under the previews (D285)
	QMap<QString, QProgressBar *> meters_;
	QPushButton *streamBtn_ = nullptr, *recordBtn_ = nullptr, *clipBtn_ = nullptr, *markBtn_ = nullptr;
	QPushButton *undoBtn_ = nullptr, *redoBtn_ = nullptr;
	bool undoBusy_ = false;
	QLabel *pillLive_ = nullptr, *pillRec_ = nullptr, *pillStats_ = nullptr, *pillHost_ = nullptr, *pillCore_ = nullptr, *pillClips_ = nullptr;
	QLabel *note_ = nullptr;
	QLabel *alertBar_ = nullptr; // live alerts (D305 proposed); hidden while empty
	QString alertLevel_;         // worst level shown: info, warn, error; empty when hidden
	QList<PreviewSlot *> slots_;
	QPushButton *settingsBtn_ = nullptr, *clipsFolderBtn_ = nullptr;
	Guide *guide_ = nullptr;       // tips, tour and help (D294 proposed)
	QPushButton *helpBtn_ = nullptr;
	QWidget *moreBtn_ = nullptr;
	TaskBar *tasks_ = nullptr;     // task chip, list and toasts (D287)
	TrayKeeper *tray_ = nullptr;  // tasks kept running in the tray after the window closed (D311 proposed)
	QString closeAsked_;          // the last close question's text (probe)
	QString closeChoice_;         // tray | stop | cancel: the answer to it (probe)
	void enterTray();
	void leaveTray();
	void stopAllFromTray(bool ask);
	// The closing lock (D311 proposed): the UI server grants it only when no stream or recording runs or is starting
	// (fresh host status, fail closed) and from then refuses every start. Every tray-triggered exit takes it first;
	// then() gets granted, the reason when not, and the lock's token (release it with releaseQuit when not exiting).
	void requestQuit(std::function<void(bool granted, const QString &reason, const QString &token)> then);
	void releaseQuit(const QString &token);
	// Right before exiting: the UI server confirms the grant still stands. exitNow() only on that answer; otherwise
	// the lock is released and stay() runs (the studio keeps running).
	void commitQuit(const QString &token, std::function<void()> exitNow, std::function<void()> stay);
	QString trayStay_;            // why the tray did not quit (live | recording | unreadable; probe)
	StatsCards *stats_ = nullptr;  // session time, GPU, CPU, fps with history
	QJsonObject clips_;           // status.clips: settings, state, asks, last result (D284)
	QStringList asked_;           // "make clips?" questions already shown this session
	bool firstRunAsked_ = false;  // the first-run clip question (no settings saved yet) was shown

protected:
	void moveEvent(QMoveEvent *e) override; // re-embed: the host re-checks the display the window is on
	void resizeEvent(QResizeEvent *e) override; // task list and toasts stay anchored bottom-right
};
