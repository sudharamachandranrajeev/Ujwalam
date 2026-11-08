// SPDX-License-Identifier: GPL-3.0-or-later
// Guide (D294 proposed): the one object the main window talks to for tips. It owns the welcome tour (Coach), the
// "behind the scenes" hints (Hints) and the floating help (HelpPanel), reads their text from the UI server
// (GET ui/api/guide, from data/guide/*.json) and keeps the user's choices in settings.json ui.guide
// ({tips, dismissed, tourDone}, through ui/api/settings; allowed while live). The window registers the parts of itself
// the tips point at by name (anchor); a tip whose anchor is missing is skipped. Hints are triggered by changes the
// window already sees (the status snapshot it polls anyway): this class never polls.
#pragma once

#include "api_client.h"

#include <QJsonArray>
#include <QJsonObject>
#include <QList>
#include <QMap>
#include <QObject>
#include <QPointer>
#include <QSet>
#include <QStringList>

class Coach;
class Hints;
class HelpPanel;
class QAbstractButton;
class QDialog;
class QMainWindow;
class QVBoxLayout;
class QWidget;

class Guide : public QObject {
	Q_OBJECT
public:
	Guide(QMainWindow *host, ApiClient *api);
	// Register a part of the window under a name used in data/guide/*.json. Several widgets = their union.
	void anchor(const QString &name, std::initializer_list<QWidget *> widgets);
	void attachHelpButton(QAbstractButton *b); // the "?" in the top bar: toggles the help panel; also anchor "help"
	void start();                                // after login: load the text and the choices; maybe start the welcome tour
	void onStatus(const QJsonObject &status);    // every status snapshot the window already polls
	void onLayerEffects(bool hasEffects);        // the selected layer has effects (Look panel)
	void setFlags(bool postingOn, bool autoPostOn);
	void refresh();                              // after a resize/move, and before a picture
	// Settings > Help & tips: fills the page the dialog made for it.
	void fillSettingsPage(QVBoxLayout *page, QDialog *dlg);

	bool tips() const { return tips_; }
	void setTips(bool on);
	void resetDismissed();
	void startTour(const QString &id);
	void replayWelcome() { startTour(QStringLiteral("welcome")); }
	bool trigger(const QString &trigger); // show the hint with this trigger, if tips are on and it is not dismissed

	bool probeAction(const QString &action);
	QJsonObject probe() const;

protected:
	bool eventFilter(QObject *o, QEvent *e) override;

private:
	QRect rectOf(const QString &anchor) const;
	QList<QRect> previewRects() const;
	void save(const QJsonObject &part);
	void addDismissed(const QString &id);
	void maybeWelcome(int tries);
	void updateSettingsPage();
	QJsonObject tourById(const QString &id) const;

	QMainWindow *host_;
	ApiClient *api_;
	Coach *coach_;
	Hints *hints_;
	HelpPanel *help_;
	QMap<QString, QList<QPointer<QWidget>>> anchors_;
	QJsonArray tours_, hintDefs_;
	QStringList dismissed_;
	QSet<QString> seenThisSession_;
	bool tips_ = true, tourDone_ = false, textLoaded_ = false, settingsLoaded_ = false, saveFailed_ = false;
	// previous status, to see what changed
	bool welcomeTried_ = false;
	bool havePrev_ = false, prevLive_ = false, prevRec_ = false, prevRunning_ = false, firstTaskSeen_ = false;
	QSet<QString> skipSeen_;
	QPointer<QDialog> settingsDlg_;
	QPointer<QWidget> tipsBox_;
};
