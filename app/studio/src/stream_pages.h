// SPDX-License-Identifier: GPL-3.0-or-later
// D327 studio pages, each behind its own flag (off by default):
//   StreamPage       Settings > Stream (flag stream-settings): canvas mode, video and audio settings, the outputs list
//                    (Add / Edit / Delete; Edit has "Connect": with flag platform-connect on it opens the Connections flow for
//                    that output and shows its status; off: disabled with a tooltip; connections_page.h).
//   TransitionsPage  Settings > Transitions (flags transitions + stream-settings): type, easing and duration per canvas,
//                    "Mirror main canvas transitions" for the portrait canvas, "Force complete transition".
//   IntegrationsPage Settings > Integrations (flag integrations): Streamer.bot / Speaker.bot ports with a Test button,
//                    "Allow remote connections" (LAN only, off by default).
//   OutputsPanel     main window (flag outputs-panel): an on/off switch per output, a + button, the Virtual Camera row.
// Every value goes through the UI server (services/studio-ui/settings-routes.mjs), which checks it again: platform
// limits, live lock, "yes, on air" for a live switch. No key or token is stored or shown here. Theme tokens only.
#pragma once

#include "api_client.h"

#include <QGroupBox>
#include <QJsonArray>
#include <QJsonObject>
#include <QWidget>

#include <functional>

class QButtonGroup;
class QCheckBox;
class QComboBox;
class QLabel;
class QLineEdit;
class QListWidget;
class QPushButton;
class QSpinBox;
class QVBoxLayout;
class Switch;

namespace streampages {

using Note = std::function<void(const QString &)>;

class StreamPage : public QWidget {
	Q_OBJECT
public:
	StreamPage(ApiClient *api, QWidget *parent);
	void save(const Note &note); // Settings Save: refused values come back with the limit
	// A change with problems (a value over a platform limit): Settings stays open on this page, the problems shown.
	bool blocksSave() const { return loaded_ && !lastProblems_.isEmpty() && current() != orig_; }
	QJsonObject probe() const;
	bool probeAction(const QStringList &p); // stream-mode:<main|multi> | stream-kbps:<n> | stream-output:add|edit|delete:<i>

private:
	void load();
	void render();
	QJsonObject current() const;
	void check();
	void editOutput(int index); // -1: add; asks for the connection state first
	void openEditor(int index, const QJsonObject &conn);
	void refreshConnect();
	void deleteOutput(int index);

	ApiClient *api_;
	QJsonObject setup_, options_, canvases_, orig_; // orig_: as loaded (Save sends only a change)
	bool loaded_ = false;
	bool connectOn_ = false;  // flag platform-connect on (ui/api/connect answers)
	QJsonObject connectRows_; // output id -> its row of ui/api/connect (presence, last 4 at most)
	QButtonGroup *mode_ = nullptr;
	QComboBox *fps_ = nullptr, *res_ = nullptr, *quality_ = nullptr, *audio_ = nullptr;
	Switch *hw_ = nullptr;
	QSpinBox *kbps_ = nullptr, *pkbps_ = nullptr;
	QLabel *canvasInfo_ = nullptr, *problems_ = nullptr;
	QListWidget *outputs_ = nullptr;
	QPushButton *edit_ = nullptr, *del_ = nullptr;
	class QTimer *checkTimer_ = nullptr;
	QString lastProblems_;
};

class TransitionsPage : public QWidget {
	Q_OBJECT
public:
	TransitionsPage(ApiClient *api, bool live, QWidget *parent);
	void save(const Note &note);
	QJsonObject probe() const;
	bool probeAction(const QStringList &p); // tr-type:<h|v>:<id> | tr-ease:<h|v>:<id> | tr-mirror:<on|off> | tr-force:<h|v>

private:
	struct Row {
		QComboBox *type = nullptr, *ease = nullptr;
		QSpinBox *ms = nullptr;
		QPushButton *force = nullptr;
		QWidget *box = nullptr;
	};
	void load();
	void sync(Row &r);
	void force(const QString &canvas);
	QString signature() const; // what Save would send; compared with the loaded one
	ApiClient *api_;
	bool live_;
	QJsonObject data_;
	QString orig_;
	Row h_, v_;
	QCheckBox *mirror_ = nullptr;
	QLabel *status_ = nullptr;
	QString forced_;
};

class IntegrationsPage : public QWidget {
	Q_OBJECT
public:
	IntegrationsPage(ApiClient *api, QWidget *parent);
	void save(const Note &note);
	QJsonObject probe() const;
	bool probeAction(const QStringList &p); // int-test:<streamerbot|speakerbot> | int-remote:<on|off>

private:
	void load();
	void test(const QString &bot);
	ApiClient *api_;
	QJsonObject data_;
	QSpinBox *sbPort_ = nullptr, *spPort_ = nullptr;
	QLabel *sbStatus_ = nullptr, *spStatus_ = nullptr, *remoteInfo_ = nullptr;
	QCheckBox *remote_ = nullptr;
	QComboBox *remoteAddr_ = nullptr;
	QPushButton *copyToken_ = nullptr;
};

class OutputsPanel : public QGroupBox {
	Q_OBJECT
public:
	OutputsPanel(ApiClient *api, QWidget *parent);
	void refresh();
	QJsonObject probe() const;
	bool probeToggle(const QString &id, bool on); // a click on that row's switch

signals:
	void confirmNeeded(const QJsonObject &pending); // a live switch: the window asks for "yes, on air"
	void message(const QString &text);
	void addRequested(); // the + button: Settings > Stream

private:
	void toggle(const QString &id, bool on);
	ApiClient *api_;
	QVBoxLayout *rows_;
	QJsonObject data_;
	QMap<QString, Switch *> switches_;
	bool busy_ = false;
};

} // namespace streampages
