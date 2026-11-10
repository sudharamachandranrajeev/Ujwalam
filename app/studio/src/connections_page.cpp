// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Connections (D327). See connections_page.h.
#include "connections_page.h"
#include "api_client.h"

#include <QDesktopServices>
#include <QDialog>
#include <QDialogButtonBox>
#include <QFormLayout>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QInputDialog>
#include <QJsonArray>
#include <QJsonObject>
#include <QLabel>
#include <QLineEdit>
#include <QPushButton>
#include <QTimer>
#include <QUrl>
#include <QVBoxLayout>

namespace connections {

static QString stateText(const QJsonObject &o)
{
	const QString st = o.value(QStringLiteral("state")).toString();
	const QJsonObject key = o.value(QStringLiteral("key")).toObject();
	QString t;
	if (st == QStringLiteral("connected"))
		t = QStringLiteral("Connected");
	else if (st == QStringLiteral("token-expired"))
		t = QStringLiteral("Sign-in expired");
	else
		t = QStringLiteral("Not connected");
	if (key.value(QStringLiteral("present")).toBool() && key.contains(QStringLiteral("last4")))
		t += QStringLiteral("  (key ....") + key.value(QStringLiteral("last4")).toString() + QStringLiteral(")");
	const QString d = o.value(QStringLiteral("detail")).toString();
	return d.isEmpty() ? t : t + QStringLiteral(" - ") + d;
}

QString shortStateText(const QJsonObject &o)
{
	const QString st = o.value(QStringLiteral("state")).toString();
	const QJsonObject key = o.value(QStringLiteral("key")).toObject();
	QString t = st == QStringLiteral("connected") ? QStringLiteral("Connected")
		    : st == QStringLiteral("token-expired") ? QStringLiteral("Sign-in expired") : QStringLiteral("Not connected");
	if (key.value(QStringLiteral("present")).toBool() && key.contains(QStringLiteral("last4")))
		t += QStringLiteral("  (key ....") + key.value(QStringLiteral("last4")).toString() + QStringLiteral(")");
	return t;
}

void openForOutput(ApiClient *api, const QString &outputId, QWidget *parent)
{
	QDialog dlg(parent);
	dlg.setObjectName(QStringLiteral("connectionsFlow"));
	dlg.setProperty("output", outputId);
	dlg.setWindowTitle(QStringLiteral("Connect output"));
	auto *v = new QVBoxLayout(&dlg);
	v->addWidget(new Page(api, &dlg, outputId), 1);
	auto *bb = new QDialogButtonBox(QDialogButtonBox::Close, &dlg);
	QObject::connect(bb, &QDialogButtonBox::rejected, &dlg, &QDialog::reject);
	QObject::connect(bb, &QDialogButtonBox::clicked, &dlg, &QDialog::accept);
	v->addWidget(bb);
	dlg.resize(780, 560);
	dlg.exec();
}

int Page::rowCount() const
{
	return rows_->count();
}

QString Page::rowLabel(int i) const
{
	QWidget *w = i >= 0 && i < rows_->count() ? rows_->itemAt(i)->widget() : nullptr;
	QLabel *l = w ? w->findChild<QLabel *>() : nullptr;
	return l ? l->text() : QString();
}

Page::Page(ApiClient *api, QWidget *parent, const QString &onlyOutput) : QWidget(parent), api_(api), only_(onlyOutput)
{
	auto *v = new QVBoxLayout(this);
	v->setContentsMargins(0, 0, 0, 0);
	v->setSpacing(12);
	auto *intro = new QLabel(QStringLiteral("Connect each stream output here instead of the Windows Credential Manager tool. Ujwalam stores the keys in "
						"Windows Credential Manager itself and shows only their last 4 characters. Every change asks you to type \"yes\" "
						"(\"yes, on air\" while live); an output that is streaming cannot be changed until it stops. A new key is used from "
						"the next start of that stream."),
				 this);
	intro->setWordWrap(true);
	intro->setObjectName(QStringLiteral("muted"));
	v->addWidget(intro);
	auto *box = new QGroupBox(QStringLiteral("STREAM OUTPUTS"), this);
	rows_ = new QVBoxLayout(box);
	rows_->setSpacing(8);
	v->addWidget(box);
	jobLabel_ = new QLabel(this);
	jobLabel_->setWordWrap(true);
	jobLabel_->setTextInteractionFlags(Qt::TextSelectableByMouse);
	jobLabel_->hide();
	v->addWidget(jobLabel_);
	msg_ = new QLabel(this);
	msg_->setWordWrap(true);
	v->addWidget(msg_);
	auto *setup = new QGroupBox(QStringLiteral("SIGN-IN SET-UP (ONCE)"), this);
	auto *sf = new QFormLayout(setup);
	auto *tw = new QWidget(setup);
	auto *th = new QHBoxLayout(tw);
	th->setContentsMargins(0, 0, 0, 0);
	auto *twId = new QLineEdit(tw);
	twId->setObjectName(QStringLiteral("connectTwitchClientId"));
	twId->setPlaceholderText(QStringLiteral("Twitch app client ID"));
	auto *twSave = new QPushButton(QStringLiteral("Save"), tw);
	th->addWidget(twId, 1);
	th->addWidget(twSave);
	sf->addRow(QStringLiteral("Twitch client ID:"), tw);
	connect(twSave, &QPushButton::clicked, this, [this, twId]() {
		const QString id = twId->text().trimmed();
		if (id.isEmpty())
			return say(QStringLiteral("Paste the client ID first."));
		twId->clear();
		post(QStringLiteral("ui/api/connect/twitch-client"), QJsonObject{{QStringLiteral("clientId"), id}}, true);
	});
	auto *how = new QLabel(QStringLiteral(
		"YouTube: uses the Google app (OAuth \"Desktop app\" client) already set for clip uploads (Ujwalam/posting/youtube-client-id and -secret). "
		"Signing in here asks Google for one more permission, managing your YouTube live streams, so you sign in again in the browser even if clip "
		"uploads are signed in; in the Google Cloud consent screen add the scope .../auth/youtube if Google asks. YouTube live streaming must be "
		"enabled on the channel.\n"
		"Twitch: register an app once at dev.twitch.tv > Your Console > Applications > Register (Client Type: Public, OAuth Redirect URL: "
		"http://localhost), then paste its Client ID above. Ujwalam asks Twitch only to read your stream key.\n"
		"Kick and other services: use Paste key (Kick events still come through Streamer.bot)."),
				  setup);
	how->setWordWrap(true);
	how->setObjectName(QStringLiteral("muted"));
	sf->addRow(how);
	v->addWidget(setup);
	auto *check = new QPushButton(QStringLiteral("Check sign-ins"), this);
	check->setToolTip(QStringLiteral("Asks YouTube and Twitch whether the stored sign-ins still work"));
	connect(check, &QPushButton::clicked, this, [this]() {
		say(QStringLiteral("Checking..."));
		api_->post(QStringLiteral("ui/api/connect/check"), {}, [p = QPointer<Page>(this)](bool ok, const QJsonObject &, const QString &err) {
			if (!p)
				return;
			p->say(ok ? QStringLiteral("Checked.") : QStringLiteral("Could not check: ") + err);
			p->reload(true);
		});
	});
	v->addWidget(check, 0, Qt::AlignLeft);
	v->addStretch(1);
	poll_ = new QTimer(this);
	poll_->setInterval(1000);
	connect(poll_, &QTimer::timeout, this, [this]() { reload(false); });
	reload(true);
}

void Page::say(const QString &text)
{
	msg_->setText(text);
}

void Page::reload(bool fresh)
{
	api_->get(fresh ? QStringLiteral("ui/api/connect?fresh=1") : QStringLiteral("ui/api/connect"),
		  [p = QPointer<Page>(this)](bool ok, const QJsonObject &b, const QString &err) {
			  if (!p)
				  return;
			  if (!ok) {
				  p->poll_->stop();
				  if (b.value(QStringLiteral("error")).toString() == QStringLiteral("platform-connect-off"))
					  return p->say(QStringLiteral("Switch on the feature flag platform-connect (Advanced) to connect platforms here."));
				  return p->say(QStringLiteral("Connections not available: ") + err);
			  }
			  p->render(b);
		  });
}

void Page::render(const QJsonObject &b)
{
	while (QLayoutItem *it = rows_->takeAt(0)) {
		if (it->widget())
			it->widget()->deleteLater();
		delete it;
	}
	const QJsonObject accounts = b.value(QStringLiteral("accounts")).toObject();
	for (const QJsonValue &ov : b.value(QStringLiteral("outputs")).toArray()) {
		const QJsonObject o = ov.toObject();
		const QString id = o.value(QStringLiteral("id")).toString();
		if (!only_.isEmpty() && id != only_)
			continue;
		auto *row = new QWidget();
		auto *h = new QHBoxLayout(row);
		h->setContentsMargins(0, 0, 0, 0);
		auto *name = new QLabel(QStringLiteral("<b>%1</b>").arg(o.value(QStringLiteral("label")).toString().toHtmlEscaped()), row);
		name->setMinimumWidth(110);
		auto *st = new QLabel(stateText(o), row);
		st->setWordWrap(true);
		st->setObjectName(o.value(QStringLiteral("state")).toString() == QStringLiteral("connected") ? QString() : QStringLiteral("muted"));
		h->addWidget(name);
		h->addWidget(st, 1);
		const QString signIn = o.value(QStringLiteral("signIn")).toString();
		if (!signIn.isEmpty()) {
			auto *sb = new QPushButton(signIn == QStringLiteral("youtube") ? QStringLiteral("Sign in with YouTube") : QStringLiteral("Sign in with Twitch"), row);
			const QJsonObject acc = accounts.value(signIn).toObject();
			if (!acc.value(QStringLiteral("clientSet")).toBool())
				sb->setToolTip(QStringLiteral("Set up once first: see SIGN-IN SET-UP below"));
			connect(sb, &QPushButton::clicked, this, [this, id, signIn]() {
				chosenFor_.clear();
				post(QStringLiteral("ui/api/connect/sign-in"), QJsonObject{{QStringLiteral("output"), id}, {QStringLiteral("platform"), signIn}}, true);
			});
			h->addWidget(sb);
		}
		auto *pb = new QPushButton(QStringLiteral("Paste key..."), row);
		connect(pb, &QPushButton::clicked, this, [this, o]() { pasteDialog(o); });
		h->addWidget(pb);
		auto *db = new QPushButton(QStringLiteral("Disconnect"), row);
		db->setEnabled(o.value(QStringLiteral("key")).toObject().value(QStringLiteral("present")).toBool() ||
			       o.value(QStringLiteral("server")).toObject().value(QStringLiteral("present")).toBool());
		connect(db, &QPushButton::clicked, this, [this, id]() { post(QStringLiteral("ui/api/connect/disconnect"), QJsonObject{{QStringLiteral("output"), id}}, true); });
		h->addWidget(db);
		rows_->addWidget(row);
	}
	showJob(b.value(QStringLiteral("job")).toObject());
}

void Page::showJob(const QJsonObject &job)
{
	const QString st = job.value(QStringLiteral("state")).toString();
	if (job.isEmpty() || st.isEmpty()) {
		jobLabel_->hide();
		poll_->stop();
		return;
	}
	const bool running = st == QStringLiteral("starting") || st == QStringLiteral("browser") || st == QStringLiteral("device") || st == QStringLiteral("saving");
	if (running && !poll_->isActive())
		poll_->start();
	if (!running && st != QStringLiteral("choose"))
		poll_->stop();
	QString t;
	if (st == QStringLiteral("browser"))
		t = QStringLiteral("Finish the sign-in in the browser window that opened (Google). Waiting...");
	else if (st == QStringLiteral("device"))
		t = QStringLiteral("On Twitch, enter the code %1 (the page should have opened: %2). Waiting...")
			    .arg(job.value(QStringLiteral("userCode")).toString(), job.value(QStringLiteral("verifyUrl")).toString());
	else if (st == QStringLiteral("starting") || st == QStringLiteral("saving"))
		t = QStringLiteral("Working...");
	else if (st == QStringLiteral("done"))
		t = QStringLiteral("Connected: the stream key is stored.");
	else if (st == QStringLiteral("failed"))
		t = QStringLiteral("Sign-in did not finish: ") + job.value(QStringLiteral("message")).toString();
	else if (st == QStringLiteral("cancelled"))
		t = QStringLiteral("Sign-in cancelled.");
	else if (st == QStringLiteral("choose"))
		t = QStringLiteral("Signed in to YouTube: choose which stream key to use.");
	for (const QJsonValue &w : job.value(QStringLiteral("warnings")).toArray())
		t += QStringLiteral("\n") + w.toString();
	jobLabel_->setText(t);
	jobLabel_->show();
	if (st == QStringLiteral("choose") && chosenFor_ != job.value(QStringLiteral("id")).toString()) {
		const QString jobId = job.value(QStringLiteral("id")).toString();
		chosenFor_ = jobId;
		poll_->stop();
		QStringList items;
		QStringList ids;
		for (const QJsonValue &sv : job.value(QStringLiteral("streams")).toArray()) {
			const QJsonObject s = sv.toObject();
			items << QStringLiteral("%1 (%2%3)").arg(s.value(QStringLiteral("title")).toString(), s.value(QStringLiteral("resolution")).toString(),
								s.value(QStringLiteral("reusable")).toBool() ? QStringLiteral(", reusable") : QString());
			ids << s.value(QStringLiteral("id")).toString();
		}
		items << QStringLiteral("Create a new stream key for this output");
		bool ok = false;
		const QString pick = QInputDialog::getItem(this, QStringLiteral("YouTube stream key"),
							   QStringLiteral("Which YouTube stream key should this output use? (The one you use today is usually \"Default stream key\".)"),
							   items, 0, false, &ok);
		if (!ok) {
			api_->post(QStringLiteral("ui/api/connect/cancel"), QJsonObject{{QStringLiteral("jobId"), jobId}}, [](bool, const QJsonObject &, const QString &) {});
			return say(QStringLiteral("Cancelled."));
		}
		const int i = items.indexOf(pick);
		const QJsonValue sid = i >= 0 && i < ids.size() ? QJsonValue(ids.at(i)) : QJsonValue(QJsonValue::Null);
		api_->post(QStringLiteral("ui/api/connect/choose"), QJsonObject{{QStringLiteral("jobId"), jobId}, {QStringLiteral("streamId"), sid}},
			   [p = QPointer<Page>(this)](bool ok2, const QJsonObject &r, const QString &err) {
				   if (!p)
					   return;
				   p->say(ok2 ? QStringLiteral("Done.") : QStringLiteral("Not done: ") + r.value(QStringLiteral("message")).toString(err));
				   p->reload(true);
			   });
	}
}

void Page::pasteDialog(const QJsonObject &o)
{
	const bool needsServer = o.contains(QStringLiteral("server"));
	QDialog dlg(this);
	dlg.setWindowTitle(QStringLiteral("Paste stream key: ") + o.value(QStringLiteral("label")).toString());
	auto *f = new QFormLayout(&dlg);
	auto *key = new QLineEdit(&dlg);
	key->setEchoMode(QLineEdit::Password); // never shown, never echoed back by the server
	key->setPlaceholderText(QStringLiteral("Leave empty to keep the stored key"));
	f->addRow(QStringLiteral("Stream key:"), key);
	QLineEdit *server = nullptr;
	if (needsServer) {
		server = new QLineEdit(&dlg);
		QStringList schemes;
		for (const QJsonValue &s : o.value(QStringLiteral("server")).toObject().value(QStringLiteral("schemes")).toArray())
			schemes << s.toString() + QStringLiteral("://");
		server->setPlaceholderText(QStringLiteral("%1server.name/app  (leave empty to keep the stored one)").arg(schemes.value(0)));
		f->addRow(QStringLiteral("Server address:"), server);
		auto *hint = new QLabel(QStringLiteral("This output takes ") + schemes.join(QStringLiteral(" or ")) + QStringLiteral(" (from the platform's stream settings page)."), &dlg);
		hint->setWordWrap(true);
		hint->setObjectName(QStringLiteral("muted"));
		f->addRow(hint);
	}
	auto *bb = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel, &dlg);
	f->addRow(bb);
	connect(bb, &QDialogButtonBox::accepted, &dlg, &QDialog::accept);
	connect(bb, &QDialogButtonBox::rejected, &dlg, &QDialog::reject);
	if (dlg.exec() != QDialog::Accepted)
		return;
	QJsonObject body{{QStringLiteral("output"), o.value(QStringLiteral("id")).toString()}};
	if (!key->text().trimmed().isEmpty())
		body.insert(QStringLiteral("key"), key->text().trimmed());
	if (server && !server->text().trimmed().isEmpty())
		body.insert(QStringLiteral("server"), server->text().trimmed());
	key->clear();
	if (body.size() == 1)
		return say(QStringLiteral("Nothing to store."));
	post(QStringLiteral("ui/api/connect/paste"), body, true);
}

void Page::post(const QString &route, const QJsonObject &body, bool confirmFirst)
{
	api_->post(route, body, [p = QPointer<Page>(this), confirmFirst](bool ok, const QJsonObject &r, const QString &err) {
		if (!p)
			return;
		if (!ok)
			return p->say(QStringLiteral("Not done: ") + r.value(QStringLiteral("message")).toString(err));
		if (confirmFirst && r.value(QStringLiteral("verdict")).toString() == QStringLiteral("confirm"))
			return p->confirm(r.value(QStringLiteral("pending")).toObject());
		p->afterAllow(r);
	});
}

// Typed confirmation (D151): the phrase comes from the server and is checked there.
void Page::confirm(const QJsonObject &pending)
{
	const QString id = pending.value(QStringLiteral("pendingId")).toString();
	bool ok = false;
	const QString typed = QInputDialog::getText(this, QStringLiteral("Confirm"),
						    pending.value(QStringLiteral("summary")).toString() + QStringLiteral("\n\nType: ") +
							    pending.value(QStringLiteral("phrase")).toString(),
						    QLineEdit::Normal, QString(), &ok);
	if (!ok) {
		api_->post(QStringLiteral("ui/api/cancel"), QJsonObject{{QStringLiteral("pendingId"), id}}, [](bool, const QJsonObject &, const QString &) {});
		return say(QStringLiteral("Cancelled."));
	}
	api_->post(QStringLiteral("ui/api/confirm"), QJsonObject{{QStringLiteral("pendingId"), id}, {QStringLiteral("text"), typed}},
		   [p = QPointer<Page>(this)](bool ok2, const QJsonObject &r, const QString &err) {
			   if (!p)
				   return;
			   if (!ok2)
				   return p->say(QStringLiteral("Not done: ") + r.value(QStringLiteral("message")).toString(err));
			   if (r.value(QStringLiteral("verdict")).toString() == QStringLiteral("wrong-phrase")) {
				   p->say(QStringLiteral("That is not the phrase. Type it exactly."));
				   return p->confirm(r.value(QStringLiteral("pending")).toObject());
			   }
			   p->afterAllow(r);
		   });
}

void Page::afterAllow(const QJsonObject &r)
{
	if (r.contains(QStringLiteral("job"))) {
		say(QString());
		showJob(r.value(QStringLiteral("job")).toObject());
		if (!poll_->isActive())
			poll_->start();
		return;
	}
	say(r.value(QStringLiteral("verdict")).toString() == QStringLiteral("allow") || r.value(QStringLiteral("ok")).toBool() ? QStringLiteral("Done.") : QStringLiteral("Result: ") + r.value(QStringLiteral("verdict")).toString());
	reload(true);
}

} // namespace connections
