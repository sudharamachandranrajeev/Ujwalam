// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Posting & growth > Auto-post (D375): what uploads by itself, how many a day, how far apart and how far
// ahead, and the next posting times. Every automatic upload goes up scheduled (private until its publish time).
// Talks only to the studio UI server (ui/api/posts/auto/settings, .../schedule, .../queue/move|remove); the server checks
// every value again and writes the user's files in the data folder. Saved with the Settings Save button (one click,
// D332); moving or removing a queued clip acts on its own click. Theme tokens only.
#pragma once

#include <QJsonObject>
#include <QStringList>
#include <QWidget>
#include <functional>

class ApiClient;
class QCheckBox;
class QComboBox;
class QDoubleSpinBox;
class QLabel;
class QSpinBox;
class QVBoxLayout;

namespace autopost {

using Note = std::function<void(const QString &)>;

class Card : public QWidget {
	Q_OBJECT
public:
	Card(ApiClient *api, QWidget *parent = nullptr);
	void save(const Note &note);	// Settings Save: sends the card only when it changed
	bool dirty() const { return loaded_ && current() != orig_; }
	bool blocksSave() const { return loaded_ && dirty() && !localProblem().isEmpty(); }
	QJsonObject probe() const;
	// ap-upload:<on|off> | ap-kind:<id>:<on|off> | ap-score:<n> | ap-perday:<n> | ap-gap:<h> | ap-days:<n> | ap-placement:<id>
	// | ap-quota:<n> | ap-refresh | ap-move:<id>:<UTC time> | ap-remove:<id>
	bool probeAction(const QStringList &p);

private:
	void load();
	void render(const QJsonObject &b);
	void loadTimes(bool fresh);
	void renderTimes(const QJsonObject &b);
	void move(const QString &id, const QString &at);
	void remove(const QString &id);
	void updateFit();
	QJsonObject current() const;
	QString localProblem() const;

	ApiClient *api_;
	bool loaded_ = false;
	QJsonObject orig_, quota_;
	QCheckBox *upload_ = nullptr;
	QList<QCheckBox *> kinds_;
	QDoubleSpinBox *score_ = nullptr;
	QSpinBox *perDay_ = nullptr, *gap_ = nullptr, *days_ = nullptr, *quotaUnits_ = nullptr;
	QComboBox *placement_ = nullptr;
	QLabel *flags_ = nullptr, *fit_ = nullptr, *problem_ = nullptr, *timesInfo_ = nullptr, *msg_ = nullptr;
	QVBoxLayout *times_ = nullptr;
	QStringList timeLines_; // what the list shows (probe)
};

} // namespace autopost
