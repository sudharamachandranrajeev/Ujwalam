// SPDX-License-Identifier: GPL-3.0-or-later
// Meld-like studio window (P5a): scenes + layers (left), H/V previews (centre), inspector + mixer (right),
// Stream / Record and status pills (top). Every action goes through the UI server (ApiClient); stream and record
// changes come back as a typed confirmation ("yes" / "yes, on air") shown in a dialog.
#pragma once

#include "api_client.h"

#include <QJsonArray>
#include <QMainWindow>
#include <QMap>

class QLabel;
class QListWidget;
class QPushButton;
class QDoubleSpinBox;
class QSpinBox;
class QVBoxLayout;
class QProgressBar;
class QButtonGroup;
class QTimer;

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
	void hostAction(const QString &method);
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
	int previewSeq_ = -1; // newest host preview mouse edit seen (status previewEdit.seq, D230); -1 = none yet

	QListWidget *sceneList_ = nullptr;
	QListWidget *layerList_ = nullptr;
	QPushButton *tabH_ = nullptr, *tabV_ = nullptr;
	QWidget *inspForm_ = nullptr;
	QLabel *inspTitle_ = nullptr, *inspEmpty_ = nullptr;
	QDoubleSpinBox *inX_ = nullptr, *inY_ = nullptr, *inW_ = nullptr, *inH_ = nullptr, *inRot_ = nullptr;
	QSpinBox *crL_ = nullptr, *crT_ = nullptr, *crR_ = nullptr, *crB_ = nullptr;
	QVBoxLayout *mixerBox_ = nullptr;
	QMap<QString, QProgressBar *> meters_;
	QPushButton *streamBtn_ = nullptr, *recordBtn_ = nullptr;
	QLabel *pillLive_ = nullptr, *pillRec_ = nullptr, *pillStats_ = nullptr, *pillHost_ = nullptr, *pillCore_ = nullptr;
	QLabel *note_ = nullptr;
	QList<PreviewSlot *> slots_;

protected:
	void moveEvent(QMoveEvent *e) override; // re-embed: the host re-checks the display the window is on
};
