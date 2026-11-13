// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Posting & growth > Auto-post (D375). See autopost_card.h.
#include "autopost_card.h"
#include "api_client.h"
#include "theme.h"

#include <QCheckBox>
#include <QComboBox>
#include <QDateTime>
#include <QDateTimeEdit>
#include <QDialog>
#include <QDialogButtonBox>
#include <QDoubleSpinBox>
#include <QFormLayout>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QJsonArray>
#include <QLabel>
#include <QPointer>
#include <QPushButton>
#include <QSpinBox>
#include <QTimeZone>
#include <QVBoxLayout>
#include <cmath>

namespace autopost {

static QLabel *mutedLabel(const QString &text, QWidget *parent)
{
	auto *l = new QLabel(text, parent);
	l->setWordWrap(true);
	l->setObjectName(QStringLiteral("muted"));
	return l;
}

// "Sat 14 Nov, 18:00" in the PC's own time zone, from a UTC ISO time.
static QString localTime(const QString &iso)
{
	QDateTime t = QDateTime::fromString(iso, Qt::ISODateWithMs);
	if (!t.isValid())
		t = QDateTime::fromString(iso, Qt::ISODate);
	return t.isValid() ? t.toLocalTime().toString(QStringLiteral("ddd d MMM, HH:mm")) : iso;
}

static QString problemsText(const QJsonArray &problems)
{
	QStringList out;
	for (const QJsonValue &p : problems)
		out << p.toObject().value(QStringLiteral("text")).toString();
	return out.join(QStringLiteral("; "));
}

Card::Card(ApiClient *api, QWidget *parent) : QWidget(parent), api_(api)
{
	setObjectName(QStringLiteral("autopostCard"));
	auto *v = new QVBoxLayout(this);
	v->setContentsMargins(0, 0, 0, 0);
	theme::space(v, 12);

	auto *box = new QGroupBox(QStringLiteral("AUTO-POST"), this);
	auto *bv = new QVBoxLayout(box);
	theme::space(bv, 8);
	bv->addWidget(mutedLabel(QStringLiteral("Clips from your clips folder go up to YouTube by themselves, oldest first, each as a scheduled post: "
						"private until its publish time, then public. Times are picked around the posts already scheduled on "
						"your channel, never two at the same time. Changes apply from the next upload pass when you click Save."),
				 box));
	flags_ = mutedLabel(QString(), box);
	flags_->setObjectName(QStringLiteral("autopostFlags"));
	bv->addWidget(flags_);
	upload_ = new QCheckBox(QStringLiteral("Upload clips automatically"), box);
	upload_->setObjectName(QStringLiteral("autopostUpload"));
	bv->addWidget(upload_);

	auto *f = new QFormLayout();
	theme::space(f, 8);
	auto *kindRow = new QWidget(box);
	auto *kh = new QHBoxLayout(kindRow);
	kh->setContentsMargins(0, 0, 0, 0);
	theme::space(kh, 12);
	for (const auto &k : {std::pair{"short", "Short clips"}, std::pair{"montage", "Montages"}, std::pair{"won-reel", "Won-round reels"}, std::pair{"impact-play", "Impact plays"}}) {
		auto *c = new QCheckBox(QString::fromLatin1(k.second), kindRow);
		c->setObjectName(QStringLiteral("autopostKind_") + QString::fromLatin1(k.first));
		c->setProperty("kind", QString::fromLatin1(k.first));
		kinds_ << c;
		kh->addWidget(c);
	}
	kh->addStretch(1);
	f->addRow(QStringLiteral("What uploads:"), kindRow);
	score_ = new QDoubleSpinBox(box);
	score_->setObjectName(QStringLiteral("autopostScore"));
	score_->setRange(0, 100);
	score_->setDecimals(1);
	score_->setToolTip(QStringLiteral("Short clips need at least this score. Montages, reels and impact plays have no clip score: choosing the kind is enough."));
	f->addRow(QStringLiteral("Minimum clip score:"), score_);
	perDay_ = new QSpinBox(box);
	perDay_->setObjectName(QStringLiteral("autopostPerDay"));
	perDay_->setRange(1, 100);
	perDay_->setSuffix(QStringLiteral(" a day"));
	f->addRow(QStringLiteral("Uploads at most:"), perDay_);
	fit_ = mutedLabel(QString(), box);
	fit_->setObjectName(QStringLiteral("autopostFit"));
	f->addRow(QString(), fit_);
	gap_ = new QSpinBox(box);
	gap_->setObjectName(QStringLiteral("autopostGap"));
	gap_->setRange(1, 48);
	gap_->setSuffix(QStringLiteral(" h"));
	gap_->setToolTip(QStringLiteral("Every post, yours from Ujwalam or already on the channel, is at least this far from the next."));
	f->addRow(QStringLiteral("Time between posts:"), gap_);
	days_ = new QSpinBox(box);
	days_->setObjectName(QStringLiteral("autopostDays"));
	days_->setRange(1, 730);
	days_->setSuffix(QStringLiteral(" days"));
	days_->setToolTip(QStringLiteral("A clip whose next free time is further ahead waits until it fits."));
	f->addRow(QStringLiteral("Schedule up to:"), days_);
	placement_ = new QComboBox(box);
	placement_->setObjectName(QStringLiteral("autopostPlacement"));
	placement_->addItem(QStringLiteral("Fill the free times between posts"), QStringLiteral("fill-gaps"));
	placement_->addItem(QStringLiteral("Always after the last scheduled post"), QStringLiteral("after-last"));
	f->addRow(QStringLiteral("Where new posts go:"), placement_);
	quotaUnits_ = new QSpinBox(box);
	quotaUnits_->setObjectName(QStringLiteral("autopostQuota"));
	quotaUnits_->setRange(1000, 10000000);
	quotaUnits_->setSingleStep(1000);
	quotaUnits_->setSuffix(QStringLiteral(" units a day"));
	quotaUnits_->setToolTip(QStringLiteral("Your YouTube Data API quota (Google Cloud Console > APIs & Services > Quotas). Raise it here after Google grants more."));
	f->addRow(QStringLiteral("YouTube quota:"), quotaUnits_);
	bv->addLayout(f);
	problem_ = new QLabel(box);
	problem_->setObjectName(QStringLiteral("taskWarn"));
	problem_->setWordWrap(true);
	problem_->hide();
	bv->addWidget(problem_);
	v->addWidget(box);

	auto *tb = new QGroupBox(QStringLiteral("NEXT POSTING TIMES"), this);
	auto *tv = new QVBoxLayout(tb);
	theme::space(tv, 6);
	timesInfo_ = mutedLabel(QStringLiteral("Loading..."), tb);
	timesInfo_->setObjectName(QStringLiteral("autopostTimesInfo"));
	tv->addWidget(timesInfo_);
	times_ = new QVBoxLayout();
	theme::space(times_, 4);
	tv->addLayout(times_);
	auto *refresh = new QPushButton(QStringLiteral("Check the channel again"), tb);
	refresh->setObjectName(QStringLiteral("autopostRefresh"));
	refresh->setToolTip(QStringLiteral("Reads the posts already scheduled on your channel (read only, at most every 10 minutes)."));
	connect(refresh, &QPushButton::clicked, this, [this]() { loadTimes(true); });
	tv->addWidget(refresh, 0, Qt::AlignLeft);
	msg_ = mutedLabel(QString(), tb);
	msg_->setObjectName(QStringLiteral("autopostMsg"));
	tv->addWidget(msg_);
	v->addWidget(tb);

	for (QCheckBox *c : kinds_)
		connect(c, &QCheckBox::toggled, this, [this](bool) { updateFit(); });
	connect(perDay_, qOverload<int>(&QSpinBox::valueChanged), this, [this](int) { updateFit(); });
	connect(quotaUnits_, qOverload<int>(&QSpinBox::valueChanged), this, [this](int) { updateFit(); });
	setEnabled(false);
	load();
}

void Card::load()
{
	api_->get(QStringLiteral("ui/api/posts/auto/settings"), [this, alive = QPointer<QObject>(this)](bool ok, const QJsonObject &b, const QString &err) {
		if (!alive)
			return; // the page closed before the answer came
		if (!ok) {
			timesInfo_->setText(QStringLiteral("Auto-post settings are not available: ") + err);
			return;
		}
		render(b);
		loadTimes(false);
	});
}

void Card::render(const QJsonObject &b)
{
	const QJsonObject c = b.value(QStringLiteral("card")).toObject();
	const QJsonObject fl = b.value(QStringLiteral("flags")).toObject();
	quota_ = b.value(QStringLiteral("quota")).toObject();
	upload_->setChecked(c.value(QStringLiteral("autoUpload")).toBool());
	QStringList ks;
	for (const QJsonValue &k : c.value(QStringLiteral("kinds")).toArray())
		ks << k.toString();
	for (QCheckBox *k : kinds_)
		k->setChecked(ks.contains(k->property("kind").toString()));
	perDay_->setMaximum(b.value(QStringLiteral("limits")).toObject().value(QStringLiteral("maxPerDay")).toInt(100));
	score_->setValue(c.value(QStringLiteral("minScore")).toDouble());
	perDay_->setValue(c.value(QStringLiteral("maxPerDay")).toInt(1));
	gap_->setValue(c.value(QStringLiteral("intervalHours")).toInt(1));
	days_->setValue(c.value(QStringLiteral("maxAheadDays")).toInt(60));
	placement_->setCurrentIndex(std::max(0, placement_->findData(c.value(QStringLiteral("placement")).toString())));
	quotaUnits_->setValue(c.value(QStringLiteral("quotaUnitsPerDay")).toInt(10000));
	QStringList off;
	if (!fl.value(QStringLiteral("autoPost")).toBool())
		off << QStringLiteral("Auto post");
	if (!fl.value(QStringLiteral("schedule")).toBool())
		off << QStringLiteral("Scheduled posting");
	QString t = off.isEmpty() ? QStringLiteral("Auto post and Scheduled posting are on.")
				  : QStringLiteral("Nothing uploads by itself until %1 %2 switched on below.").arg(off.join(QStringLiteral(" and ")), off.size() > 1 ? QStringLiteral("are") : QStringLiteral("is"));
	t += fl.value(QStringLiteral("deleteUploaded")).toBool()
		     ? QStringLiteral(" Delete posted clips forever is on: each clip file is deleted permanently once YouTube has processed its upload.")
		     : QStringLiteral(" Posted clip files stay in the clips folder.");
	if (b.value(QStringLiteral("custom")).toBool())
		t += QStringLiteral(" Your rules file was edited by hand; Save replaces it with these values.");
	const QString bad = b.value(QStringLiteral("error")).toString() + b.value(QStringLiteral("scheduleError")).toString();
	if (!bad.isEmpty())
		t += QStringLiteral(" Your saved settings could not be read (") + bad + QStringLiteral("); the defaults are shown, and Save writes them again.");
	flags_->setText(t);
	loaded_ = true;
	orig_ = current();
	updateFit();
	setEnabled(true);
}

QJsonObject Card::current() const
{
	QJsonArray ks;
	for (QCheckBox *k : kinds_)
		if (k->isChecked())
			ks.append(k->property("kind").toString());
	return QJsonObject{{QStringLiteral("autoUpload"), upload_->isChecked()},
			   {QStringLiteral("kinds"), ks},
			   {QStringLiteral("minScore"), std::round(score_->value() * 10) / 10},
			   {QStringLiteral("maxPerDay"), perDay_->value()},
			   {QStringLiteral("intervalHours"), gap_->value()},
			   {QStringLiteral("maxAheadDays"), days_->value()},
			   {QStringLiteral("placement"), placement_->currentData().toString()},
			   {QStringLiteral("quotaUnitsPerDay"), quotaUnits_->value()}};
}

QString Card::localProblem() const
{
	for (QCheckBox *k : kinds_)
		if (k->isChecked())
			return QString();
	return QStringLiteral("Choose at least one kind of clip to upload.");
}

void Card::updateFit()
{
	// Same sum as the server (quota-budget.mjs loadQuota): (quota - read reserve) / (upload + thumbnail units); 0 is
	// possible and is said plainly (the daily budget then stops every upload).
	const int per = quota_.value(QStringLiteral("perUploadUnits")).toInt(0);
	const int reserve = quota_.value(QStringLiteral("readReserveUnits")).toInt(0);
	const int fit = per > 0 ? std::max(0, (quotaUnits_->value() - reserve) / per) : perDay_->maximum();
	QString t = QStringLiteral("About %1 uploads a day fit in the quota.").arg(fit);
	if (fit == 0)
		t = QStringLiteral("No upload fits in a quota of %1 units a day (one upload needs %2): nothing uploads until the quota is raised.")
				.arg(quotaUnits_->value())
				.arg(per + reserve);
	else if (perDay_->value() > fit)
		t += QStringLiteral(" More than that a day stop at the quota and wait for the next day.");
	fit_->setText(t);
	const QString p = localProblem();
	problem_->setText(p);
	problem_->setVisible(!p.isEmpty());
}

void Card::save(const Note &note)
{
	if (!dirty())
		return;
	const QJsonObject card = current();
	api_->post(QStringLiteral("ui/api/posts/auto/settings"), QJsonObject{{QStringLiteral("card"), card}},
		   [this, note, card, alive = QPointer<QObject>(this)](bool ok, const QJsonObject &b, const QString &err) {
			   if (ok) {
				   if (alive)
					   orig_ = card;
				   return note(QStringLiteral("Auto-post settings saved; the next upload pass uses them."));
			   }
			   const QString why = problemsText(b.value(QStringLiteral("problems")).toArray());
			   note(QStringLiteral("Auto-post settings not saved: ") + (why.isEmpty() ? err : why));
		   });
}

void Card::loadTimes(bool fresh)
{
	api_->get(QStringLiteral("ui/api/posts/auto/schedule?count=10") + (fresh ? QStringLiteral("&fresh=1") : QString()),
		  [this, alive = QPointer<QObject>(this)](bool ok, const QJsonObject &b, const QString &err) {
			  if (!alive)
				  return;
			  if (!ok)
				  return timesInfo_->setText(QStringLiteral("The posting times are not available: ") + err);
			  renderTimes(b);
		  });
}

void Card::renderTimes(const QJsonObject &b)
{
	while (QLayoutItem *it = times_->takeAt(0)) {
		if (it->widget())
			it->widget()->deleteLater();
		delete it;
	}
	timeLines_.clear();
	const QString err = b.value(QStringLiteral("error")).toString();
	const QString live = b.value(QStringLiteral("liveError")).toString();
	QString info;
	if (err == QStringLiteral("schedule-read-incomplete"))
		info = QStringLiteral("The last channel read did not reach back far enough to see every scheduled post, so no time is given (nothing uploads until it does).");
	else if (!err.isEmpty())
		info = QStringLiteral("The schedule settings are not valid, so no time is given.");
	else {
		const QString src = b.value(QStringLiteral("source")).toString();
		const QString at = b.value(QStringLiteral("channelReadAt")).toString();
		info = src == QStringLiteral("none") ? QStringLiteral("The channel has not been read yet; the times below may move once it is.")
						     : QStringLiteral("Channel read %1. Times are in your time zone; each post is at least %2 h from the next.")
							       .arg(at.isEmpty() ? QStringLiteral("earlier") : localTime(at))
							       .arg(b.value(QStringLiteral("intervalHours")).toInt());
	}
	if (live == QStringLiteral("schedule-scope-missing"))
		info += QStringLiteral(" Could not read the channel: sign in again so YouTube allows reading scheduled posts.");
	else if (!live.isEmpty())
		info += QStringLiteral(" Could not read the channel just now (") + live + QStringLiteral(").");
	timesInfo_->setText(info);
	auto line = [this](const QString &text, const QString &id, bool movable) {
		auto *row = new QWidget();
		auto *h = new QHBoxLayout(row);
		h->setContentsMargins(0, 0, 0, 0);
		auto *l = new QLabel(text, row);
		h->addWidget(l, 1);
		timeLines_ << text;
		if (movable) {
			auto *mv = new QPushButton(QStringLiteral("Move"), row);
			mv->setObjectName(QStringLiteral("autopostMove_") + id);
			auto *rm = new QPushButton(QStringLiteral("Remove"), row);
			rm->setObjectName(QStringLiteral("autopostRemove_") + id);
			rm->setToolTip(QStringLiteral("Takes this clip out of the upload queue. Its post stays in the Posts window."));
			h->addWidget(mv);
			h->addWidget(rm);
			connect(rm, &QPushButton::clicked, this, [this, id]() { remove(id); });
			connect(mv, &QPushButton::clicked, this, [this, id, text]() {
				QDialog dlg(this);
				dlg.setWindowTitle(QStringLiteral("Move this clip"));
				auto *dv = new QVBoxLayout(&dlg);
				dv->addWidget(new QLabel(QStringLiteral("New publish time (your time zone, on the hour):"), &dlg));
				auto *edit = new QDateTimeEdit(QDateTime::currentDateTime().addSecs(3 * 3600), &dlg);
				edit->setDisplayFormat(QStringLiteral("ddd d MMM yyyy, HH:00"));
				edit->setCalendarPopup(true);
				dv->addWidget(edit);
				auto *bb = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel, &dlg);
				connect(bb, &QDialogButtonBox::accepted, &dlg, &QDialog::accept);
				connect(bb, &QDialogButtonBox::rejected, &dlg, &QDialog::reject);
				dv->addWidget(bb);
				if (dlg.exec() != QDialog::Accepted)
					return;
				QDateTime t = edit->dateTime();
				t.setTime(QTime(t.time().hour(), 0));
				move(id, t.toUTC().toString(QStringLiteral("yyyy-MM-ddTHH:mm:00Z")));
			});
		}
		times_->addWidget(row);
	};
	for (const QJsonValue &qv : b.value(QStringLiteral("queue")).toArray()) {
		const QJsonObject q = qv.toObject();
		const QString at = q.value(QStringLiteral("publishAt")).toString();
		const QString st = q.value(QStringLiteral("state")).toString();
		const QString what = st == QStringLiteral("done") ? QStringLiteral("uploaded, scheduled") : st == QStringLiteral("uploading") ? QStringLiteral("uploading, scheduled") : QStringLiteral("queued clip, scheduled");
		line(QStringLiteral("%1  -  %2").arg(at.isEmpty() ? QStringLiteral("time not set yet") : localTime(at), what), q.value(QStringLiteral("id")).toString(),
		     q.value(QStringLiteral("movable")).toBool() && !at.isEmpty());
	}
	for (const QJsonValue &cv : b.value(QStringLiteral("channel")).toArray())
		line(QStringLiteral("%1  -  already scheduled on the channel").arg(localTime(cv.toString())), QString(), false);
	const QJsonArray next = b.value(QStringLiteral("next")).toArray();
	for (const QJsonValue &nv : next)
		line(QStringLiteral("%1  -  free: the next clip goes up Scheduled for this time").arg(localTime(nv.toString())), QString(), false);
	if (b.value(QStringLiteral("queue")).toArray().isEmpty() && b.value(QStringLiteral("channel")).toArray().isEmpty() && next.isEmpty())
		line(QStringLiteral("No posting times yet."), QString(), false);
}

void Card::move(const QString &id, const QString &at)
{
	api_->post(QStringLiteral("ui/api/posts/auto/queue/move"), QJsonObject{{QStringLiteral("id"), id}, {QStringLiteral("at"), at}},
		   [this, alive = QPointer<QObject>(this)](bool ok, const QJsonObject &b, const QString &err) {
			   if (!alive)
				   return;
			   msg_->setText(ok ? QStringLiteral("Moved to %1.").arg(localTime(b.value(QStringLiteral("publishAt")).toString()))
					    : QStringLiteral("Not moved: ") + (b.value(QStringLiteral("text")).toString().isEmpty() ? err : b.value(QStringLiteral("text")).toString()));
			   loadTimes(false);
		   });
}

void Card::remove(const QString &id)
{
	api_->post(QStringLiteral("ui/api/posts/auto/queue/remove"), QJsonObject{{QStringLiteral("id"), id}},
		   [this, alive = QPointer<QObject>(this)](bool ok, const QJsonObject &b, const QString &err) {
			   if (!alive)
				   return;
			   msg_->setText(ok ? QStringLiteral("Taken out of the upload queue.")
					    : QStringLiteral("Not removed: ") + (b.value(QStringLiteral("text")).toString().isEmpty() ? err : b.value(QStringLiteral("text")).toString()));
			   loadTimes(false);
		   });
}

QJsonObject Card::probe() const
{
	return QJsonObject{{QStringLiteral("loaded"), loaded_}, {QStringLiteral("card"), current()}, {QStringLiteral("dirty"), dirty()},
			   {QStringLiteral("fit"), fit_->text()}, {QStringLiteral("flags"), flags_->text()}, {QStringLiteral("problem"), problem_->isVisible() ? problem_->text() : QString()},
			   {QStringLiteral("timesInfo"), timesInfo_->text()}, {QStringLiteral("times"), QJsonArray::fromStringList(timeLines_)}, {QStringLiteral("message"), msg_->text()}};
}

bool Card::probeAction(const QStringList &p)
{
	if (!loaded_)
		return false;
	const QString a = p.value(0);
	const QString arg = p.value(1);
	if (a == QStringLiteral("ap-upload")) {
		upload_->setChecked(arg == QStringLiteral("on"));
		return true;
	}
	if (a == QStringLiteral("ap-kind") && p.size() == 3) {
		for (QCheckBox *k : kinds_)
			if (k->property("kind").toString() == arg) {
				k->setChecked(p[2] == QStringLiteral("on"));
				return true;
			}
		return false;
	}
	bool ok = false;
	const int n = arg.toInt(&ok);
	if (a == QStringLiteral("ap-score") && ok)
		return score_->setValue(n), true;
	if (a == QStringLiteral("ap-perday") && ok)
		return perDay_->setValue(n), true;
	if (a == QStringLiteral("ap-gap") && ok)
		return gap_->setValue(n), true;
	if (a == QStringLiteral("ap-days") && ok)
		return days_->setValue(n), true;
	if (a == QStringLiteral("ap-quota") && ok)
		return quotaUnits_->setValue(n), true;
	if (a == QStringLiteral("ap-placement")) {
		const int i = placement_->findData(arg);
		if (i < 0)
			return false;
		placement_->setCurrentIndex(i);
		return true;
	}
	if (a == QStringLiteral("ap-refresh"))
		return loadTimes(true), true;
	if (a == QStringLiteral("ap-move") && p.size() >= 3) // the time has colons: the rest of the action
		return move(arg, p.mid(2).join(QLatin1Char(':'))), true;
	if (a == QStringLiteral("ap-remove") && !arg.isEmpty())
		return remove(arg), true;
	return false;
}

} // namespace autopost
