// SPDX-License-Identifier: GPL-3.0-or-later
// Meld-like studio window (P5a): scenes + layers (left), H/V previews (centre), inspector + mixer (right),
// Stream / Record and status pills (top). Every action goes through the UI server (ApiClient); stream and record
// changes come back as a typed confirmation ("yes" / "yes, on air") shown in a dialog.
#pragma once

#include "api_client.h"

#include <QJsonArray>
#include <QMainWindow>
#include <QMap>

#include <functional>

class QLabel;
class QListWidget;
class QPushButton;
class QDoubleSpinBox;
class QSpinBox;
class QVBoxLayout;
class QProgressBar;
class QButtonGroup;
class QTimer;
class QFormLayout;
class QGroupBox;
class QComboBox;
class QLineEdit;
class QCheckBox;

// A native child widget the host draws a canvas preview into (P5a step 4): the host makes its preview a child
// window of this widget's handle and resizes it when the slot changes size. If the host refuses (no canvas yet, host
// down), the slot shows why and the Open preview button still opens a host window. Display rule: D219.
class PreviewSlot : public QWidget {
public:
	PreviewSlot(ApiClient *api, QString canvas, QWidget *parent);
	void embed();
	void schedule(); // debounced embed (resize, move)
	void setMessage(const QString &text);

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

private:
	QWidget *buildLeft();
	QWidget *buildCentre();
	QWidget *buildRight();
	QWidget *buildTop();

	void loadScenes();
	void loadLayers();
	void loadMixer();
	void pollStatus();
	void pollMeters();
	void renderScenes();
	void renderLayers();
	void renderInspector();
	void renderMixer();
	void applyInspector();
	void renderEffects();    // effect editor (D260): the working list
	void renderEffectForm(); // the selected effect's settings
	void applyEffects();
	void editEffects(const std::function<void(QJsonArray &, int &)> &change);
	void nudge(int dx, int dy);
	void sendNudge();
	void hostAction(const QString &method);
	void loadEdits();             // undo / redo state (UI server history, D238)
	void undoRedo(bool undo);
	void loadFlags();             // feature flags (D149): on needs the typed phrase, off is instant
	void setFlag(const QString &id, bool on);
	// Scene and layer structure edits (D240, flag scene-edit) and transitions (D242, flag transitions): the UI server
	// edits the project file and the host; both are refused while live.
	void loadStructure();
	void renderAddPick();
	void structureEdit(const QJsonObject &body);
	void loadTransitions();
	void renderTransition();
	void applyTransition();
	// Streamer.bot / Speaker.bot start and stop (BM, flag bot-manager): typed "yes" each; stop ends only a copy
	// Ujwalam started (the server checks).
	void loadBots();
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
	bool live_ = false, recording_ = false, meterBusy_ = false;
	bool previewEditing_ = false; // host switch for preview editing = flag preview-edit (status host.previewEditing)
	int nudgeDx_ = 0, nudgeDy_ = 0; // arrow-key nudge not sent yet (D254)
	bool nudgeBusy_ = false;
	// Effect editor (D260, flag effect-editor): a working copy of the selected layer's effects; Apply sends it whole.
	bool effectEditing_ = false;
	QJsonArray effEdit_;
	QString effLayer_;     // "<scene>/<layer>" effEdit_ belongs to
	int effRev_ = 0;       // bumped on every change of effEdit_; an Apply answer for an older draft keeps it dirty
	bool effDirty_ = false; // changed since it was read from the host
	int previewSeq_ = -1; // newest host preview mouse edit seen (status previewEdit.seq, D230); -1 = none yet

	QListWidget *sceneList_ = nullptr;
	QListWidget *layerList_ = nullptr;
	QListWidget *flagList_ = nullptr;
	bool sceneEditOn_ = false, transitionsOn_ = false, botsOn_ = false;
	int botPoll_ = 0; // bot status reads the process list: every 5th status poll (10 s), and after each action
	QGroupBox *botBox_ = nullptr;
	QVBoxLayout *botRows_ = nullptr;
	QJsonObject structure_;   // GET /ui/api/project/structure
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
	QGroupBox *effBox_ = nullptr;
	QListWidget *effList_ = nullptr;
	QFormLayout *effForm_ = nullptr;
	QVBoxLayout *mixerBox_ = nullptr;
	QMap<QString, QProgressBar *> meters_;
	QPushButton *streamBtn_ = nullptr, *recordBtn_ = nullptr;
	QPushButton *undoBtn_ = nullptr, *redoBtn_ = nullptr;
	bool undoBusy_ = false;
	QLabel *pillLive_ = nullptr, *pillRec_ = nullptr, *pillStats_ = nullptr, *pillHost_ = nullptr, *pillCore_ = nullptr;
	QLabel *note_ = nullptr;
	QList<PreviewSlot *> slots_;

protected:
	void moveEvent(QMoveEvent *e) override; // re-embed: the host re-checks the display the window is on
};
