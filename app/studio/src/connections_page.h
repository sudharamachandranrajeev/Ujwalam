// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Connections (D327, PC1-PC3, flag `platform-connect`): per stream output, sign in with YouTube or Twitch,
// paste a stream key / server address, or disconnect. Talks only to the studio UI server (ui/api/connect*), which
// writes Windows Credential Manager. A pasted key is sent once over the local API (session cookie + CSRF + Origin) and
// never shown again: the page gets presence, the address scheme and at most the last 4 characters.
#pragma once

#include <QPointer>
#include <QWidget>

class ApiClient;
class QVBoxLayout;
class QLabel;
class QTimer;
class QJsonObject;

namespace connections {

// "Connected  (key ....ab12)" / "Sign-in expired" / "Not connected": a row of ui/api/connect, at most the last 4 characters.
QString shortStateText(const QJsonObject &output);

// The flow for one output in its own window (Edit output > Connect): the same page as Settings > Connections, only that
// output's row (sign in, paste key, disconnect). Returns when the window is closed.
void openForOutput(ApiClient *api, const QString &outputId, QWidget *parent);

class Page : public QWidget {
	Q_OBJECT
public:
	// onlyOutput: show just that output's row (empty: all outputs).
	Page(ApiClient *api, QWidget *parent = nullptr, const QString &onlyOutput = QString());
	void reload(bool fresh = false);
	int rowCount() const; // output rows shown (tests)
	QString rowLabel(int i) const;

private:
	void render(const QJsonObject &b);
	void post(const QString &route, const QJsonObject &body, bool confirmFirst);
	void confirm(const QJsonObject &pending);
	void afterAllow(const QJsonObject &r);
	void showJob(const QJsonObject &job);
	void pasteDialog(const QJsonObject &output);
	void say(const QString &text);
	ApiClient *api_;
	QVBoxLayout *rows_ = nullptr;
	QLabel *msg_ = nullptr, *jobLabel_ = nullptr;
	QTimer *poll_ = nullptr;
	QString only_;      // the one output shown (Edit output > Connect), or empty
	QString chosenFor_; // the job id whose stream choice was already asked
};

} // namespace connections
