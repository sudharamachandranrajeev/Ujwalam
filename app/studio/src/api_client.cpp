// SPDX-License-Identifier: GPL-3.0-or-later
#include "api_client.h"

#include <QJsonDocument>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRegularExpression>
#include <QUrlQuery>

static const char *CSRF_HEADER = "X-Ujwalam-Csrf";
static const int TIMEOUT_MS = 10000;

ApiClient::ApiClient(QObject *parent) : QObject(parent)
{
	nam_.setRedirectPolicy(QNetworkRequest::ManualRedirectPolicy); // the login answers 302 + Set-Cookie
}

bool ApiClient::setBase(const QUrl &base)
{
	static const QRegularExpression re(QStringLiteral("^http://127\\.0\\.0\\.1:\\d{1,5}/$"));
	if (!base.isValid() || !re.match(base.toString()).hasMatch())
		return false;
	base_ = base;
	origin_ = base.toString().chopped(1);
	return true;
}

void ApiClient::finish(QNetworkReply *r, Done done)
{
	QObject::connect(r, &QNetworkReply::finished, this, [r, done]() {
		r->deleteLater();
		const int status = r->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
		const QByteArray data = r->readAll();
		QJsonObject body;
		const QJsonDocument doc = QJsonDocument::fromJson(data);
		if (doc.isObject())
			body = doc.object();
		if (r->error() != QNetworkReply::NoError && status == 0) {
			done(false, body, r->errorString());
			return;
		}
		if (status >= 400) {
			QString e = body.value(QStringLiteral("error")).toString();
			if (e.isEmpty())
				e = QString::fromUtf8(data.left(80));
			done(false, body, QStringLiteral("HTTP %1: %2").arg(status).arg(e));
			return;
		}
		done(true, body, QString());
	});
}

void ApiClient::login(const QString &launchKey, Done done)
{
	if (base_.isEmpty()) {
		done(false, {}, QStringLiteral("no server URL"));
		return;
	}
	QUrl u = base_.resolved(QUrl(QStringLiteral("login")));
	QUrlQuery q;
	q.addQueryItem(QStringLiteral("k"), launchKey);
	u.setQuery(q);
	QNetworkRequest req(u);
	req.setTransferTimeout(TIMEOUT_MS);
	req.setRawHeader("Sec-Fetch-Site", "none");
	QNetworkReply *r = nam_.get(req);
	QObject::connect(r, &QNetworkReply::finished, this, [this, r, done]() {
		r->deleteLater();
		const int status = r->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
		const QByteArray setCookie = r->rawHeader("Set-Cookie");
		if (status != 302 || setCookie.isEmpty()) {
			done(false, {}, QStringLiteral("login refused (HTTP %1)").arg(status));
			return;
		}
		cookie_ = setCookie.split(';').first().trimmed();
		get(QStringLiteral("ui/api/session"), [this, done](bool ok, const QJsonObject &b, const QString &err) {
			if (ok)
				csrf_ = b.value(QStringLiteral("csrf")).toString().toUtf8();
			done(ok && !csrf_.isEmpty(), b, ok && csrf_.isEmpty() ? QStringLiteral("no CSRF value") : err);
		});
	});
}

void ApiClient::get(const QString &route, Done done)
{
	QNetworkRequest req(base_.resolved(QUrl(route)));
	req.setTransferTimeout(TIMEOUT_MS);
	req.setRawHeader("Cookie", cookie_);
	req.setRawHeader("Sec-Fetch-Site", "same-origin");
	finish(nam_.get(req), done);
}

void ApiClient::post(const QString &route, const QJsonObject &body, Done done)
{
	QNetworkRequest req(base_.resolved(QUrl(route)));
	req.setTransferTimeout(TIMEOUT_MS);
	req.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
	req.setRawHeader("Cookie", cookie_);
	req.setRawHeader("Origin", origin_.toUtf8());
	req.setRawHeader("Sec-Fetch-Site", "same-origin");
	req.setRawHeader(CSRF_HEADER, csrf_);
	finish(nam_.post(req, QJsonDocument(body).toJson(QJsonDocument::Compact)), done);
}

void ApiClient::host(const QString &method, const QJsonObject &params, Done done)
{
	QJsonObject b;
	b.insert(QStringLiteral("method"), method);
	b.insert(QStringLiteral("params"), params);
	post(QStringLiteral("ui/api/host"), b, done);
}
