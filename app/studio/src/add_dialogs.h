// SPDX-License-Identifier: GPL-3.0-or-later
// Add layer / Add scene windows and the small motion helpers the new menus and windows share (D292).
// The windows only build the structure route's request body (layer.add, scene.add); MainWindow sends it.
#pragma once

#include <QDialog>
#include <QJsonArray>
#include <QJsonObject>
#include <QList>
#include <QPair>
#include <QString>

class QLabel;
class QLineEdit;
class QListWidget;
class QPushButton;

namespace addui {

// Layer kinds the structure route adds (D240): label, kind, what it is.
struct LayerKind {
	const char *label, *kind, *about;
};
extern const LayerKind kLayerKinds[7];

// What a kind can be made from: (shown text, value) from GET /ui/api/project/structure. Empty for colour and text.
QList<QPair<QString, QString>> addChoices(const QJsonObject &structure, const QString &kind);

// The structure route's layer.add body; err is set (and says what) when something is missing.
QJsonObject layerAddBody(const QString &scene, const QString &kind, const QString &pick, const QString &text, QString &err);

// Focus, pressed and disabled looks for the new menus, windows and buttons (the app style has hover and a glow).
void polish(QWidget *w);
// Fade in (and, for windows, a small grow) on show; follows the motion setting. Call after the widget is shown.
void popIn(QWidget *w, bool grow);

// A dialog that fades in when shown and out when it closes (instant when motion is off). Deletes itself on close.
class FadeDialog : public QDialog {
	Q_OBJECT
public:
	explicit FadeDialog(QWidget *parent);
	void done(int r) override;
protected:
	void showEvent(QShowEvent *e) override;
private:
	bool closing_ = false, shown_ = false;
};

// Kinds on the left (a kind the project cannot supply is greyed with the reason), what it can be made from on the right.
class AddLayerDialog : public FadeDialog {
	Q_OBJECT
public:
	AddLayerDialog(const QJsonObject &structure, const QString &sceneId, const QString &sceneName, QWidget *parent);
	void setStructure(const QJsonObject &structure);
	// Probe (tests): drive the real widgets.
	bool probeKind(const QString &kind);
	bool probeChoice(int row);
	bool probeText(const QString &text);
	bool probeSend();
	QJsonObject probe() const;
signals:
	void chosen(const QJsonObject &body);
private:
	void send();
	void fillChoices(const QString &keep);
	QJsonObject structure_;
	QString scene_;
	QListWidget *kinds_, *choices_;
	QLineEdit *search_, *text_;
	QPushButton *colour_, *add_;
	QLabel *about_;
};

// A name for the new scene. The scene is made on every canvas of the project; the window says which.
class AddSceneDialog : public FadeDialog {
	Q_OBJECT
public:
	AddSceneDialog(const QStringList &canvases, QWidget *parent);
	bool probeName(const QString &name);
	bool probeSend();
	QJsonObject probe() const;
signals:
	void chosen(const QJsonObject &body);
private:
	void send();
	QLineEdit *name_;
	QLabel *where_;
	QPushButton *add_;
};

} // namespace addui
