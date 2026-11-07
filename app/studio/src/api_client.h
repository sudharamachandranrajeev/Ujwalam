// SPDX-License-Identifier: GPL-3.0-or-later
// Client of the studio UI server (services/studio-ui/server.mjs), the same narrow API the web page uses.
// login(): GET /login?k=<one-time launch key> -> session cookie (HttpOnly, kept in this process only), then
// GET /ui/api/session -> CSRF value. Every POST carries Origin = the server origin, the CSRF header and JSON.
// Only 127.0.0.1 URLs are accepted. The host token and event-core tokens never reach this process (D40).
#pragma once

#include <QJsonObject>
#include <QJsonValue>
#include <QNetworkAccessManager>
#include <QObject>
#include <QUrl>
#include <functional>

class ApiClient : public QObject {
	Q_OBJECT
public:
	// result: the parsed JSON body (object); ok false on transport error or HTTP status >= 400 (error text in err).
	using Done = std::function<void(bool ok, const QJsonObject &body, const QString &err)>;

	explicit ApiClient(QObject *parent = nullptr);
	// base must be http://127.0.0.1:<port>/ ; returns false (and does nothing) for anything else.
	bool setBase(const QUrl &base);
	void login(const QString &launchKey, Done done);
	void get(const QString &route, Done done);
	void post(const QString &route, const QJsonObject &body, Done done);
	// POST /ui/api/host {method, params}
	void host(const QString &method, const QJsonObject &params, Done done);
	bool loggedIn() const { return !csrf_.isEmpty(); }

private:
	void finish(class QNetworkReply *r, Done done);
	QNetworkAccessManager nam_;
	QUrl base_;
	QString origin_;
	QByteArray cookie_; // "name=value"
	QByteArray csrf_;
};
