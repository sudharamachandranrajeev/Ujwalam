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

class Page : public QWidget {
	Q_OBJECT
public:
	Page(ApiClient *api, QWidget *parent = nullptr);
	void reload(bool fresh = false);

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
	QString chosenFor_; // the job id whose stream choice was already asked
};

} // namespace connections
