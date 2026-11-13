// SPDX-License-Identifier: GPL-3.0-or-later
// D327 studio pages: see stream_pages.h.
#include "stream_pages.h"
#include "connections_page.h"
#include "switch_widget.h"
#include "theme.h"

#include <QApplication>
#include <QButtonGroup>
#include <QCheckBox>
#include <QClipboard>
#include <QComboBox>
#include <QDialog>
#include <QDialogButtonBox>
#include <QFormLayout>
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QListWidget>
#include <QMessageBox>
#include <QPointer>
#include <QPushButton>
#include <QRegularExpression>
#include <QSpinBox>
#include <QTimer>
#include <QVBoxLayout>

namespace streampages {

namespace {

QString s(const QJsonObject &o, const char *k, const QString &def = QString())
{
	return o.value(QLatin1String(k)).toString(def);
}

QJsonObject platformOf(const QJsonObject &options, const QString &id)
{
	for (const auto &x : options.value(QStringLiteral("platforms")).toArray())
		if (x.toObject().value(QStringLiteral("id")).toString() == id)
			return x.toObject();
	return {};
}

// The platform mark: its short badge text on an accent pill (no brand images).
QLabel *badge(const QString &text, QWidget *parent)
{
	auto *b = new QLabel(text, parent);
	b->setObjectName(QStringLiteral("platformBadge"));
	b->setAlignment(Qt::AlignCenter);
	b->setFixedSize(30, 22);
	b->setStyleSheet(QStringLiteral("QLabel#platformBadge{background:%1;color:%2;border-radius:6px;font-weight:600;}")
				 .arg(theme::color(QStringLiteral("accent")).name(), theme::color(QStringLiteral("text")).name()));
	return b;
}

QLabel *muted(const QString &text, QWidget *parent)
{
	auto *l = new QLabel(text, parent);
	l->setWordWrap(true);
	l->setObjectName(QStringLiteral("muted"));
	return l;
}

QString problemsText(const QJsonArray &problems)
{
	QStringList out;
	for (const auto &p : problems)
		out << p.toObject().value(QStringLiteral("message")).toString();
	return out.join(QLatin1Char('\n'));
}

// The Add / Edit output window. Connect (flag platform-connect): opens the Connections flow for this output (sign in or
// paste the key); the stream key is never typed or kept here. conn: { on: the flag is on, row: this output's row of
// ui/api/connect (empty: the connection service does not know the output yet, e.g. not saved) }.
class OutputDialog : public QDialog {
public:
	// shared: the canvas encoders this output uses unless it has its own: {kbps (main), pkbps (portrait), output (main
	// resolution id)}, as Settings > Stream VIDEO shows them now.
	OutputDialog(ApiClient *api, const QJsonObject &options, const QJsonObject &out, const QJsonObject &conn, bool multi, const QJsonObject &shared, QWidget *parent)
		: QDialog(parent), out_(out), shared_(shared), api_(api)
	{
		const bool adding = out.isEmpty();
		setWindowTitle(adding ? QStringLiteral("Add output") : QStringLiteral("Edit output"));
		auto *v = new QVBoxLayout(this);
		auto *f = form_ = new QFormLayout();
		platform_ = new QComboBox(this);
		for (const auto &x : options.value(QStringLiteral("platforms")).toArray())
			platform_->addItem(s(x.toObject(), "label"), s(x.toObject(), "id"));
		platform_->setCurrentIndex(std::max(0, platform_->findData(s(out, "platform"))));
		platform_->setEnabled(adding); // the id and its stored key follow the platform: a new output for another one
		name_ = new QLineEdit(s(out, "name"), this);
		name_->setMaxLength(60);
		canvas_ = new QComboBox(this);
		own_ = new QCheckBox(QStringLiteral("Its own bitrate (an extra encoder, from the main canvas)"), this);
		own_->setObjectName(QStringLiteral("outputOwnBitrate"));
		ownKbps_ = new QSpinBox(this);
		ownKbps_->setObjectName(QStringLiteral("outputBitrate"));
		const QJsonObject vb = options.value(QStringLiteral("videoBitrateKbps")).toObject();
		ownKbps_->setRange(vb.value(QStringLiteral("min")).toInt(500), vb.value(QStringLiteral("max")).toInt(100000));
		ownKbps_->setSingleStep(vb.value(QStringLiteral("step")).toInt(500));
		ownKbps_->setSuffix(QStringLiteral(" kbps"));
		ownRes_ = new QComboBox(this);
		for (const auto &x : options.value(QStringLiteral("resolutions")).toArray())
			ownRes_->addItem(s(x.toObject(), "label"), s(x.toObject(), "id"));
		// Its own values when it has them; otherwise the shared ones are where ticking the box starts (never a made-up
		// default: the box once showed 6000 for an output that streams at the main canvas bitrate).
		const QJsonObject ov = out.value(QStringLiteral("video")).toObject();
		own_->setChecked(!ov.isEmpty());
		mineKbps_ = ov.value(QStringLiteral("bitrateKbps")).toInt(shared_.value(QStringLiteral("kbps")).toInt(6000));
		mineRes_ = s(ov, "output", s(shared_, "output", QStringLiteral("1080p")));
		bitrateNote_ = muted(QString(), this);
		bitrateNote_->setObjectName(QStringLiteral("outputBitrateNote"));
		bitrateNote_->setWordWrap(true);
		f->addRow(QStringLiteral("Platform"), platform_);
		f->addRow(QStringLiteral("Name"), name_);
		f->addRow(QStringLiteral("Canvas"), canvas_);
		f->addRow(own_);
		f->addRow(QStringLiteral("Resolution"), ownRes_);
		f->addRow(QStringLiteral("Bitrate"), ownKbps_);
		f->addRow(bitrateNote_);
		connect(ownKbps_, &QSpinBox::valueChanged, this, [this](int v) {
			if (own_->isChecked() && ownKbps_->isEnabled())
				mineKbps_ = v;
		});
		connect(ownRes_, &QComboBox::currentIndexChanged, this, [this]() {
			if (own_->isChecked() && ownRes_->isEnabled())
				mineRes_ = ownRes_->currentData().toString();
		});
		v->addLayout(f);
		// Connect (D327 PC hook): platform sign-in and the key live in Windows Credential Manager, set elsewhere.
		auto *connectBox = new QGroupBox(QStringLiteral("ACCOUNT"), this);
		auto *ch = new QHBoxLayout(connectBox);
		connect_ = new QPushButton(QStringLiteral("Connect"), connectBox);
		connect_->setObjectName(QStringLiteral("outputConnect"));
		status_ = muted(QString(), connectBox);
		status_->setObjectName(QStringLiteral("outputConnectStatus"));
		const bool on = conn.value(QStringLiteral("on")).toBool();
		const QJsonObject row = conn.value(QStringLiteral("row")).toObject();
		connect_->setEnabled(on && !row.isEmpty());
		if (!on) {
			connect_->setToolTip(QStringLiteral("Turn on the feature flag platform-connect (Settings > Connections) to sign in or paste the stream key from Ujwalam."));
			status_->setText(QStringLiteral("Sign-in and connection status need the feature flag platform-connect (Settings > Connections). The stream key is kept in Windows Credential Manager under the name shown below."));
		} else if (row.isEmpty()) {
			connect_->setToolTip(QStringLiteral("Save this output first (OK, then Save in Settings), then open it again to connect it."));
			status_->setText(QStringLiteral("Not connected. Save this output first (OK, then Save in Settings), then open it again to connect it."));
		} else {
			connect_->setToolTip(QStringLiteral("Sign in to the platform, or paste the stream key, for this output."));
			status_->setText(connections::shortStateText(row));
		}
		ch->addWidget(connect_);
		ch->addWidget(status_, 1);
		connect(connect_, &QPushButton::clicked, this, [this]() {
			const QString id = s(out_, "id");
			connections::openForOutput(api_, id, this);
			api_->get(QStringLiteral("ui/api/connect"), [alive = QPointer<QLabel>(status_), id](bool ok, const QJsonObject &b, const QString &) {
				if (!alive || !ok)
					return;
				for (const auto &x : b.value(QStringLiteral("outputs")).toArray())
					if (x.toObject().value(QStringLiteral("id")).toString() == id)
						alive->setText(connections::shortStateText(x.toObject()));
			});
		});
		v->addWidget(connectBox);
		keyRef_ = muted(QString(), this);
		v->addWidget(keyRef_);
		auto *bb = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel, this);
		connect(bb, &QDialogButtonBox::accepted, this, &QDialog::accept);
		connect(bb, &QDialogButtonBox::rejected, this, &QDialog::reject);
		v->addWidget(bb);
		auto refresh = [this, options, multi]() {
			const QJsonObject p = platformOf(options, platform_->currentData().toString());
			const QString was = canvas_->currentData().toString().isEmpty() ? s(out_, "canvas", QStringLiteral("H")) : canvas_->currentData().toString();
			canvas_->clear();
			for (const auto &c : p.value(QStringLiteral("canvases")).toArray())
				canvas_->addItem(c.toString() == QStringLiteral("V") ? QStringLiteral("Portrait canvas (9:16)%1").arg(multi ? QString() : QStringLiteral(", needs Main + portrait"))
										  : QStringLiteral("Main canvas (16:9)"),
						 c.toString());
			canvas_->setCurrentIndex(std::max(0, canvas_->findData(was)));
			if (name_->text().isEmpty() || !out_.contains(QStringLiteral("name")))
				name_->setText(s(p, "label"));
			syncBitrate();
			keyRef_->setText(QStringLiteral("Key name: Ujwalam/stream/%1").arg(out_.contains(QStringLiteral("id")) ? s(out_, "id") : QStringLiteral("<new id>")));
		};
		connect(platform_, &QComboBox::currentIndexChanged, this, refresh);
		connect(canvas_, &QComboBox::currentIndexChanged, this, [this]() { syncBitrate(); });
		connect(own_, &QCheckBox::toggled, this, [this]() { syncBitrate(); });
		refresh();
	}
	// Resolution and Bitrate show what this output really sends: its own values when "Its own bitrate" is on, else the
	// canvas encoder it shares (greyed out), with a line that says so.
	void syncBitrate()
	{
		const bool h = canvas_->currentData().toString() == QStringLiteral("H");
		const bool mine = h && own_->isChecked();
		own_->setEnabled(h);
		ownKbps_->setEnabled(mine);
		ownRes_->setEnabled(mine);
		const int sharedKbps = shared_.value(h ? QStringLiteral("kbps") : QStringLiteral("pkbps")).toInt();
		const QSignalBlocker b1(ownKbps_), b2(ownRes_);
		ownKbps_->setValue(mine ? mineKbps_ : sharedKbps);
		ownRes_->setCurrentIndex(std::max(0, ownRes_->findData(mine ? mineRes_ : s(shared_, "output", mineRes_))));
		form_->setRowVisible(ownRes_, h); // the portrait canvas has its own size; this list holds the main canvas sizes
		if (mine)
			bitrateNote_->setText(QStringLiteral("This output gets its own encoder at this bitrate (one more encoder session while live)."));
		else if (h)
			bitrateNote_->setText(QStringLiteral("Sends the main canvas stream: %1 kbps, set under VIDEO (Main canvas bitrate). Tick \"Its own bitrate\" to give this output a different one.").arg(sharedKbps));
		else
			bitrateNote_->setText(QStringLiteral("Sends the portrait canvas stream: %1 kbps, set under VIDEO (Portrait canvas bitrate).").arg(sharedKbps));
	}
	// The output as the setup holds it; id stays for an edit, a new one gets one from the caller.
	QJsonObject value() const
	{
		QJsonObject o = out_;
		o.insert(QStringLiteral("platform"), platform_->currentData().toString());
		o.insert(QStringLiteral("name"), name_->text().trimmed().isEmpty() ? platform_->currentText() : name_->text().trimmed());
		o.insert(QStringLiteral("canvas"), canvas_->currentData().toString());
		if (!o.contains(QStringLiteral("enabled")))
			o.insert(QStringLiteral("enabled"), true);
		if (own_->isChecked() && canvas_->currentData().toString() == QStringLiteral("H"))
			o.insert(QStringLiteral("video"), QJsonObject{{QStringLiteral("output"), mineRes_}, {QStringLiteral("bitrateKbps"), mineKbps_}});
		else
			o.remove(QStringLiteral("video"));
		return o;
	}

private:
	QJsonObject out_, shared_;
	QFormLayout *form_;
	QComboBox *platform_, *canvas_, *ownRes_;
	QLineEdit *name_;
	QCheckBox *own_;
	QSpinBox *ownKbps_;
	int mineKbps_ = 0;
	QString mineRes_;
	ApiClient *api_;
	QPushButton *connect_;
	QLabel *keyRef_, *status_, *bitrateNote_;
};

QString newId(const QJsonArray &outputs, const QString &platform)
{
	QSet<QString> used{QStringLiteral("record")};
	for (const auto &o : outputs)
		used.insert(o.toObject().value(QStringLiteral("id")).toString());
	if (!used.contains(platform))
		return platform;
	for (int n = 2; n < 100; n++)
		if (!used.contains(QStringLiteral("%1-%2").arg(platform).arg(n)))
			return QStringLiteral("%1-%2").arg(platform).arg(n);
	return QString();
}

} // namespace

// ---------------------------------------------------------------- Settings > Stream

StreamPage::StreamPage(ApiClient *api, QWidget *parent) : QWidget(parent), api_(api)
{
	setObjectName(QStringLiteral("streamPage"));
	auto *v = new QVBoxLayout(this);
	v->setContentsMargins(0, 0, 0, 0);
	theme::space(v, 12);

	auto *modeBox = new QGroupBox(QStringLiteral("CANVAS"), this);
	auto *mh = new QHBoxLayout(modeBox);
	mode_ = new QButtonGroup(this);
	auto card = [&](const QString &id, const QString &title, const QString &text) {
		auto *b = new QPushButton(title + QStringLiteral("\n") + text, modeBox);
		b->setObjectName(QStringLiteral("modeCard"));
		b->setCheckable(true);
		b->setProperty("mode", id);
		b->setMinimumHeight(64);
		mode_->addButton(b);
		mh->addWidget(b, 1);
	};
	card(QStringLiteral("main"), QStringLiteral("Main canvas only"), QStringLiteral("One 16:9 picture for every platform"));
	card(QStringLiteral("multi"), QStringLiteral("Main + portrait canvas"), QStringLiteral("16:9 and a separate 9:16 for portrait outputs"));
	v->addWidget(modeBox);

	auto *vid = new QGroupBox(QStringLiteral("VIDEO"), this);
	auto *vf = new QFormLayout(vid);
	canvasInfo_ = muted(QString(), vid);
	res_ = new QComboBox(vid);
	pres_ = new QComboBox(vid); // D378: the portrait stream size (above the canvas needs flag stream-upscale)
	pres_->setObjectName(QStringLiteral("streamPortraitOutput"));
	fps_ = new QComboBox(vid);
	hw_ = new Switch(vid);
	hw_->setObjectName(QStringLiteral("streamHardware"));
	kbps_ = new QSpinBox(vid);
	pkbps_ = new QSpinBox(vid);
	for (QSpinBox *b : {kbps_, pkbps_})
		b->setSuffix(QStringLiteral(" kbps"));
	quality_ = new QComboBox(vid);
	vf->addRow(QStringLiteral("Canvas resolution"), canvasInfo_);
	vf->addRow(QStringLiteral("Output resolution"), res_);
	vf->addRow(QStringLiteral("Portrait output resolution"), pres_);
	vf->addRow(QStringLiteral("Frame rate"), fps_);
	auto *hwRow = new QWidget(vid);
	auto *hh = new QHBoxLayout(hwRow);
	hh->setContentsMargins(0, 0, 0, 0);
	hh->addWidget(hw_);
	hh->addWidget(muted(QStringLiteral("Hardware encoder (NVIDIA); off: the processor (x264)"), hwRow), 1);
	vf->addRow(QStringLiteral("Encoder"), hwRow);
	vf->addRow(QStringLiteral("Main canvas bitrate"), kbps_);
	vf->addRow(QStringLiteral("Portrait canvas bitrate"), pkbps_);
	vf->addRow(QStringLiteral("Quality"), quality_);
	v->addWidget(vid);

	auto *aud = new QGroupBox(QStringLiteral("AUDIO"), this);
	auto *af = new QFormLayout(aud);
	audio_ = new QComboBox(aud);
	af->addRow(QStringLiteral("Audio bitrate"), audio_);
	v->addWidget(aud);

	auto *outBox = new QGroupBox(QStringLiteral("OUTPUTS"), this);
	auto *ov = new QVBoxLayout(outBox);
	outputs_ = new QListWidget(outBox);
	outputs_->setObjectName(QStringLiteral("streamOutputs"));
	outputs_->setMinimumHeight(120);
	ov->addWidget(outputs_, 1);
	auto *bh = new QHBoxLayout();
	auto *add = new QPushButton(QStringLiteral("Add output"), outBox);
	edit_ = new QPushButton(QStringLiteral("Edit"), outBox);
	del_ = new QPushButton(QStringLiteral("Delete"), outBox);
	bh->addWidget(add);
	bh->addWidget(edit_);
	bh->addWidget(del_);
	bh->addStretch(1);
	ov->addLayout(bh);
	v->addWidget(outBox, 1);

	problems_ = new QLabel(this);
	problems_->setObjectName(QStringLiteral("streamProblems"));
	problems_->setWordWrap(true);
	problems_->setStyleSheet(QStringLiteral("color:%1;").arg(theme::color(QStringLiteral("danger")).name()));
	v->addWidget(problems_);
	v->addWidget(muted(QStringLiteral("Changes apply the next time you go live. Values over a platform's limit are refused with the limit shown."), this));

	checkTimer_ = new QTimer(this);
	checkTimer_->setSingleShot(true);
	checkTimer_->setInterval(250);
	connect(checkTimer_, &QTimer::timeout, this, &StreamPage::check);
	auto changed = [this]() {
		if (loaded_)
			checkTimer_->start();
	};
	connect(mode_, &QButtonGroup::buttonClicked, this, [this, changed]() {
		pkbps_->setEnabled(mode_->checkedButton() && mode_->checkedButton()->property("mode").toString() == QStringLiteral("multi"));
		changed();
	});
	for (QComboBox *c : {res_, pres_, fps_, quality_, audio_})
		connect(c, &QComboBox::currentIndexChanged, this, changed);
	for (QSpinBox *b : {kbps_, pkbps_})
		connect(b, &QSpinBox::valueChanged, this, changed);
	connect(hw_, &QAbstractButton::toggled, this, changed);
	connect(add, &QPushButton::clicked, this, [this]() { editOutput(-1); });
	connect(edit_, &QPushButton::clicked, this, [this]() { editOutput(outputs_->currentRow()); });
	connect(del_, &QPushButton::clicked, this, [this]() { deleteOutput(outputs_->currentRow()); });
	connect(outputs_, &QListWidget::itemDoubleClicked, this, [this]() { editOutput(outputs_->currentRow()); });
	connect(outputs_, &QListWidget::currentRowChanged, this, [this](int r) {
		edit_->setEnabled(r >= 0);
		del_->setEnabled(r >= 0);
	});
	edit_->setEnabled(false);
	del_->setEnabled(false);
	setEnabled(false);
	load();
}

void StreamPage::load()
{
	api_->get(QStringLiteral("ui/api/stream/setup"), [this, alive = QPointer<QObject>(this)](bool ok, const QJsonObject &b, const QString &err) {
		if (!alive)
			return; // the page closed before the answer came
		if (!ok) {
			problems_->setText(QStringLiteral("Stream settings not available: ") + err);
			return;
		}
		setup_ = b.value(QStringLiteral("setup")).toObject();
		options_ = b.value(QStringLiteral("options")).toObject();
		canvases_ = b.value(QStringLiteral("canvases")).toObject();
		const QSignalBlocker b1(res_), b2(fps_), b3(quality_), b4(audio_), b5(kbps_), b6(pkbps_), b7(pres_);
		res_->clear();
		for (const auto &x : options_.value(QStringLiteral("resolutions")).toArray())
			res_->addItem(s(x.toObject(), "label"), s(x.toObject(), "id"));
		pres_->clear();
		for (const auto &x : options_.value(QStringLiteral("portraitResolutions")).toArray())
			pres_->addItem(s(x.toObject(), "label"), s(x.toObject(), "id"));
		pres_->setEnabled(pres_->count() > 0);
		fps_->clear();
		for (const auto &x : options_.value(QStringLiteral("frameRates")).toArray())
			fps_->addItem(QStringLiteral("%1 fps").arg(x.toInt()), x.toInt());
		quality_->clear();
		for (const auto &x : options_.value(QStringLiteral("qualityPresets")).toArray())
			quality_->addItem(s(x.toObject(), "label"), s(x.toObject(), "id"));
		audio_->clear();
		for (const auto &x : options_.value(QStringLiteral("audioBitratesKbps")).toArray())
			audio_->addItem(QStringLiteral("%1 kbps").arg(x.toInt()), x.toInt());
		const QJsonObject vb = options_.value(QStringLiteral("videoBitrateKbps")).toObject();
		for (QSpinBox *sp : {kbps_, pkbps_}) {
			sp->setRange(vb.value(QStringLiteral("min")).toInt(500), vb.value(QStringLiteral("max")).toInt(100000));
			sp->setSingleStep(vb.value(QStringLiteral("step")).toInt(500));
		}
		render();
		orig_ = current();
		setEnabled(true);
		loaded_ = true;
		lastProblems_ = problemsText(b.value(QStringLiteral("problems")).toArray());
		problems_->setText(lastProblems_);
		refreshConnect();
	});
}

void StreamPage::render()
{
	const QJsonObject v = setup_.value(QStringLiteral("video")).toObject();
	for (QAbstractButton *b : mode_->buttons())
		b->setChecked(b->property("mode").toString() == s(setup_, "canvasMode"));
	pkbps_->setEnabled(s(setup_, "canvasMode") == QStringLiteral("multi"));
	res_->setCurrentIndex(std::max(0, res_->findData(s(v, "output"))));
	pres_->setCurrentIndex(std::max(0, pres_->findData(s(v, "portraitOutput"))));
	fps_->setCurrentIndex(std::max(0, fps_->findData(v.value(QStringLiteral("fps")).toInt())));
	quality_->setCurrentIndex(std::max(0, quality_->findData(s(v, "quality"))));
	audio_->setCurrentIndex(std::max(0, audio_->findData(v.value(QStringLiteral("audioKbps")).toInt())));
	kbps_->setValue(v.value(QStringLiteral("bitrateKbps")).toInt());
	pkbps_->setValue(v.value(QStringLiteral("portraitBitrateKbps")).toInt());
	hw_->setCheckedSilently(v.value(QStringLiteral("hardware")).toBool(true));
	const QJsonObject h = canvases_.value(QStringLiteral("H")).toObject(), vv = canvases_.value(QStringLiteral("V")).toObject();
	canvasInfo_->setText(h.isEmpty() ? QStringLiteral("Set by the scene project (read-only here)")
					 : QStringLiteral("Main %1x%2, portrait %3x%4 (from the scene project, read-only here)")
						   .arg(h.value(QStringLiteral("w")).toInt()).arg(h.value(QStringLiteral("h")).toInt())
						   .arg(vv.value(QStringLiteral("w")).toInt()).arg(vv.value(QStringLiteral("h")).toInt()));
	const int row = outputs_->currentRow();
	outputs_->clear();
	for (const auto &x : setup_.value(QStringLiteral("outputs")).toArray()) {
		const QJsonObject o = x.toObject();
		auto *it = new QListWidgetItem(outputs_);
		auto *w = new QWidget(outputs_);
		auto *rh = new QHBoxLayout(w);
		theme::margins(rh, 6, 4, 6, 4);
		rh->addWidget(badge(s(platformOf(options_, s(o, "platform")), "badge", s(o, "platform").left(2).toUpper()), w));
		auto *txt = new QLabel(QStringLiteral("<b>%1</b>  %2<br><span>%3</span>")
					       .arg(s(o, "name").toHtmlEscaped(), s(o, "canvas") == QStringLiteral("V") ? QStringLiteral("Portrait") : QStringLiteral("Main"),
						    QStringLiteral("%1 kbps%2").arg(s(o, "canvas") == QStringLiteral("V") ? pkbps_->value() : o.value(QStringLiteral("video")).toObject().value(QStringLiteral("bitrateKbps")).toInt(kbps_->value()))
							    .arg(o.value(QStringLiteral("enabled")).toBool(true) ? QString() : QStringLiteral(" · switched off"))),
				       w);
		if (connectOn_ && connectRows_.contains(s(o, "id"))) { // flag platform-connect: this output's connection state
			txt->setObjectName(QStringLiteral("outputRowText"));
			txt->setText(txt->text().replace(QStringLiteral("</span>"), QStringLiteral(" - ") + connections::shortStateText(connectRows_.value(s(o, "id")).toObject()).toHtmlEscaped() + QStringLiteral("</span>")));
		}
		rh->addWidget(txt, 1);
		it->setData(Qt::UserRole, s(o, "id"));
		it->setSizeHint(QSize(0, 46));
		outputs_->setItemWidget(it, w);
	}
	if (row >= 0 && row < outputs_->count())
		outputs_->setCurrentRow(row);
}

QJsonObject StreamPage::current() const
{
	QJsonObject out = setup_;
	if (QAbstractButton *b = mode_->checkedButton())
		out.insert(QStringLiteral("canvasMode"), b->property("mode").toString());
	QJsonObject v = setup_.value(QStringLiteral("video")).toObject();
	v.insert(QStringLiteral("output"), res_->currentData().toString());
	if (pres_->count() > 0)
		v.insert(QStringLiteral("portraitOutput"), pres_->currentData().toString());
	v.insert(QStringLiteral("fps"), fps_->currentData().toInt());
	v.insert(QStringLiteral("quality"), quality_->currentData().toString());
	v.insert(QStringLiteral("audioKbps"), audio_->currentData().toInt());
	v.insert(QStringLiteral("bitrateKbps"), kbps_->value());
	v.insert(QStringLiteral("portraitBitrateKbps"), pkbps_->value());
	v.insert(QStringLiteral("hardware"), hw_->isChecked());
	out.insert(QStringLiteral("video"), v);
	return out;
}

void StreamPage::check()
{
	api_->post(QStringLiteral("ui/api/stream/check"), QJsonObject{{QStringLiteral("setup"), current()}}, [this, alive = QPointer<QObject>(this)](bool ok, const QJsonObject &b, const QString &err) {
		if (!alive)
			return; // the page closed before the answer came
		lastProblems_ = ok ? problemsText(b.value(QStringLiteral("problems")).toArray()) : err;
		problems_->setText(lastProblems_);
	});
}

void StreamPage::save(const Note &note)
{
	if (!loaded_ || current() == orig_) // unchanged: nothing to save
		return;
	const QJsonObject next = current();
	api_->post(QStringLiteral("ui/api/stream/setup"), QJsonObject{{QStringLiteral("setup"), next}}, [note](bool ok, const QJsonObject &b, const QString &err) {
		if (ok)
			return note(QStringLiteral("Stream settings saved; they apply the next time you go live."));
		const QString why = problemsText(b.value(QStringLiteral("problems")).toArray());
		note(QStringLiteral("Stream settings not saved: ") + (why.isEmpty() ? err : why));
	});
}

// The connection state per output (flag platform-connect): ui/api/connect answers 404 while the flag is off, then nothing
// about connections is shown. Rows hold presence and at most the last 4 characters of a key, never a key.
void StreamPage::refreshConnect()
{
	api_->get(QStringLiteral("ui/api/connect"), [this, alive = QPointer<QObject>(this)](bool ok, const QJsonObject &b, const QString &) {
		if (!alive)
			return;
		connectOn_ = ok;
		connectRows_ = QJsonObject();
		if (ok)
			for (const auto &x : b.value(QStringLiteral("outputs")).toArray())
				connectRows_.insert(x.toObject().value(QStringLiteral("id")).toString(), x.toObject());
		if (loaded_)
			render();
	});
}

void StreamPage::editOutput(int index)
{
	if (index >= setup_.value(QStringLiteral("outputs")).toArray().size())
		return;
	// Fresh connection state first (it may have changed in Settings > Connections), then the window.
	api_->get(QStringLiteral("ui/api/connect"), [this, alive = QPointer<QObject>(this), index](bool ok, const QJsonObject &b, const QString &) {
		if (!alive)
			return;
		connectOn_ = ok;
		QJsonObject conn{{QStringLiteral("on"), ok}};
		QJsonObject rows;
		if (ok)
			for (const auto &x : b.value(QStringLiteral("outputs")).toArray())
				rows.insert(x.toObject().value(QStringLiteral("id")).toString(), x.toObject());
		connectRows_ = rows;
		const QJsonArray outs = setup_.value(QStringLiteral("outputs")).toArray();
		if (index >= 0 && index < outs.size())
			conn.insert(QStringLiteral("row"), rows.value(outs.at(index).toObject().value(QStringLiteral("id")).toString()).toObject());
		openEditor(index, conn);
		render();
	});
}

void StreamPage::openEditor(int index, const QJsonObject &conn)
{
	QJsonArray outs = setup_.value(QStringLiteral("outputs")).toArray();
	if (index >= outs.size())
		return;
	const bool multi = mode_->checkedButton() && mode_->checkedButton()->property("mode").toString() == QStringLiteral("multi");
	const QJsonObject shared{{QStringLiteral("kbps"), kbps_->value()}, {QStringLiteral("pkbps"), pkbps_->value()}, {QStringLiteral("output"), res_->currentData().toString()}};
	OutputDialog d(api_, options_, index >= 0 ? outs.at(index).toObject() : QJsonObject(), conn, multi, shared, this);
	if (d.exec() != QDialog::Accepted)
		return;
	QJsonObject o = d.value();
	if (index < 0) {
		const QString id = newId(outs, o.value(QStringLiteral("platform")).toString());
		if (id.isEmpty())
			return;
		o.insert(QStringLiteral("id"), id);
		outs.append(o);
	} else {
		outs.replace(index, o);
	}
	setup_ = current();
	setup_.insert(QStringLiteral("outputs"), outs);
	render();
	check();
}

void StreamPage::deleteOutput(int index)
{
	QJsonArray outs = setup_.value(QStringLiteral("outputs")).toArray();
	if (index < 0 || index >= outs.size())
		return;
	// The click acts (D332); the list change is part of the Settings draft until Save. The key in Credential Manager is
	// left alone.
	outs.removeAt(index);
	setup_ = current();
	setup_.insert(QStringLiteral("outputs"), outs);
	render();
	check();
}

QJsonObject StreamPage::probe() const
{
	QJsonArray rows;
	for (int i = 0; i < outputs_->count(); i++)
		rows.append(outputs_->item(i)->data(Qt::UserRole).toString());
	QJsonObject o{{QStringLiteral("loaded"), loaded_}, {QStringLiteral("setup"), current()}, {QStringLiteral("outputs"), rows}, {QStringLiteral("problems"), problems_->text()}};
	// Connect (flag platform-connect): the open Edit output window's button and status, and the open Connections flow.
	QJsonArray rowTexts;
	for (int i = 0; i < outputs_->count(); i++)
		if (QLabel *l = outputs_->itemWidget(outputs_->item(i))->findChild<QLabel *>(QStringLiteral("outputRowText")))
			rowTexts.append(l->text());
	o.insert(QStringLiteral("connectOn"), connectOn_);
	o.insert(QStringLiteral("rowStatus"), rowTexts);
	for (QWidget *w : QApplication::topLevelWidgets()) {
		auto *dlg = qobject_cast<QDialog *>(w);
		if (!dlg || !dlg->isVisible())
			continue;
		if (auto *b = dlg->findChild<QPushButton *>(QStringLiteral("outputConnect"))) {
			QJsonObject c{{QStringLiteral("enabled"), b->isEnabled()}, {QStringLiteral("tooltip"), b->toolTip()}};
			if (auto *st = dlg->findChild<QLabel *>(QStringLiteral("outputConnectStatus")))
				c.insert(QStringLiteral("status"), st->text());
			o.insert(QStringLiteral("connectButton"), c);
		}
		// The Edit output window's bitrate: what the box shows, whether it is the output's own, and the line under it.
		if (auto *k = dlg->findChild<QSpinBox *>(QStringLiteral("outputBitrate"))) {
			QJsonObject b{{QStringLiteral("kbps"), k->value()}, {QStringLiteral("enabled"), k->isEnabled()}};
			if (auto *own = dlg->findChild<QCheckBox *>(QStringLiteral("outputOwnBitrate")))
				b.insert(QStringLiteral("own"), own->isChecked());
			if (auto *n = dlg->findChild<QLabel *>(QStringLiteral("outputBitrateNote")))
				b.insert(QStringLiteral("note"), n->text());
			o.insert(QStringLiteral("outputBitrate"), b);
		}
		if (dlg->objectName() == QStringLiteral("connectionsFlow")) {
			QJsonObject f{{QStringLiteral("output"), dlg->property("output").toString()}};
			if (auto *pg = dlg->findChild<connections::Page *>()) {
				QJsonArray labels;
				for (int i = 0; i < pg->rowCount(); i++)
					labels.append(pg->rowLabel(i));
				f.insert(QStringLiteral("rows"), labels);
			}
			o.insert(QStringLiteral("connectFlow"), f);
		}
	}
	return o;
}

bool StreamPage::probeAction(const QStringList &p)
{
	if (!loaded_)
		return false;
	if (p.size() == 2 && p[0] == QStringLiteral("stream-mode")) {
		for (QAbstractButton *b : mode_->buttons())
			if (b->property("mode").toString() == p[1]) {
				b->click();
				return true;
			}
		return false;
	}
	if (p.size() == 2 && p[0] == QStringLiteral("stream-kbps")) {
		kbps_->setValue(p[1].toInt());
		return kbps_->value() == p[1].toInt();
	}
	if (p.size() == 2 && p[0] == QStringLiteral("stream-output-delete-now")) { // Delete with the question answered yes
		QJsonArray outs = setup_.value(QStringLiteral("outputs")).toArray();
		const int i = p[1].toInt();
		if (i < 0 || i >= outs.size())
			return false;
		outs.removeAt(i);
		setup_ = current();
		setup_.insert(QStringLiteral("outputs"), outs);
		render();
		check();
		return true;
	}
	if (p.size() == 1 && p[0] == QStringLiteral("stream-output-add")) { // opens the Add window
		QTimer::singleShot(0, this, [this]() { editOutput(-1); });
		return true;
	}
	if (p.size() == 1 && p[0] == QStringLiteral("stream-output-connect")) { // a click on Connect in the open Edit window
		for (QWidget *w : QApplication::topLevelWidgets())
			if (auto *dlg = qobject_cast<QDialog *>(w); dlg && dlg->isVisible())
				if (auto *b = dlg->findChild<QPushButton *>(QStringLiteral("outputConnect"))) {
					if (!b->isEnabled())
						return false;
					QTimer::singleShot(0, b, [b]() { b->click(); }); // the flow's window runs its own event loop
					return true;
				}
		return false;
	}
	if (p.size() == 2 && p[0] == QStringLiteral("stream-output-own")) { // ticks (1) or clears (0) "Its own bitrate" in the open Edit window
		for (QWidget *w : QApplication::topLevelWidgets())
			if (auto *dlg = qobject_cast<QDialog *>(w); dlg && dlg->isVisible())
				if (auto *c = dlg->findChild<QCheckBox *>(QStringLiteral("outputOwnBitrate"))) {
					if (!c->isEnabled())
						return false;
					c->setChecked(p[1] == QStringLiteral("1"));
					return true;
				}
		return false;
	}
	if (p.size() == 2 && p[0] == QStringLiteral("stream-output-edit")) { // opens the Edit window (the probe pictures it)
		const int i = p[1].toInt();
		if (i < 0 || i >= outputs_->count())
			return false;
		outputs_->setCurrentRow(i);
		QTimer::singleShot(0, this, [this, i]() { editOutput(i); });
		return true;
	}
	return false;
}

// ---------------------------------------------------------------- Settings > Transitions

TransitionsPage::TransitionsPage(ApiClient *api, bool live, QWidget *parent) : QWidget(parent), api_(api), live_(live)
{
	setObjectName(QStringLiteral("transitionsPage"));
	auto *v = new QVBoxLayout(this);
	v->setContentsMargins(0, 0, 0, 0);
	theme::space(v, 12);
	auto build = [&](Row &r, const QString &title, const QString &canvas) {
		auto *box = new QGroupBox(title, this);
		auto *f = new QFormLayout(box);
		r.box = box;
		r.type = new QComboBox(box);
		r.ease = new QComboBox(box);
		r.ms = new QSpinBox(box);
		r.ms->setSuffix(QStringLiteral(" ms"));
		r.force = new QPushButton(QStringLiteral("Force complete transition"), box);
		r.force->setToolTip(QStringLiteral("Ends a transition that is running on this canvas now (it shows the new scene at once)."));
		f->addRow(QStringLiteral("Type"), r.type);
		f->addRow(QStringLiteral("Easing"), r.ease);
		f->addRow(QStringLiteral("Duration"), r.ms);
		f->addRow(r.force);
		connect(r.type, &QComboBox::currentIndexChanged, this, [this, &r]() { sync(r); });
		connect(r.force, &QPushButton::clicked, this, [this, canvas]() { force(canvas); });
		v->addWidget(box);
	};
	build(h_, QStringLiteral("MAIN CANVAS"), QStringLiteral("h"));
	mirror_ = new QCheckBox(QStringLiteral("Mirror main canvas transitions"), this);
	mirror_->setObjectName(QStringLiteral("transitionsMirror"));
	v->addWidget(mirror_);
	build(v_, QStringLiteral("PORTRAIT CANVAS"), QStringLiteral("v"));
	connect(mirror_, &QCheckBox::toggled, this, [this](bool on) {
		v_.type->setEnabled(!on && !live_);
		sync(v_);
	});
	status_ = muted(QString(), this);
	v->addWidget(status_);
	v->addWidget(muted(QStringLiteral("A stinger video is chosen in the Transitions panel of the main window. Transitions cannot be changed while live; Force complete works any time."), this));
	v->addStretch(1);
	setEnabled(false);
	load();
}

void TransitionsPage::load()
{
	api_->get(QStringLiteral("ui/api/project/transitions"), [this, alive = QPointer<QObject>(this)](bool ok, const QJsonObject &b, const QString &err) {
		if (!alive)
			return; // the page closed before the answer came
		if (!ok || !b.value(QStringLiteral("available")).toBool()) {
			status_->setText(ok ? QStringLiteral("Transitions need the transitions feature and a loaded scene project.") : QStringLiteral("Transitions not available: ") + err);
			return;
		}
		data_ = b;
		const QJsonObject e = b.value(QStringLiteral("easing")).toObject();
		const QJsonObject dur = e.value(QStringLiteral("durationMs")).toObject();
		for (Row *r : {&h_, &v_}) {
			const QSignalBlocker b1(r->type), b2(r->ease);
			r->type->clear();
			for (const auto &t : e.value(QStringLiteral("types")).toArray())
				if (s(t.toObject(), "id") != QStringLiteral("stinger"))
					r->type->addItem(s(t.toObject(), "label"), s(t.toObject(), "id"));
			r->ease->clear();
			for (const auto &x : e.value(QStringLiteral("easing")).toArray())
				r->ease->addItem(s(x.toObject(), "label"), s(x.toObject(), "id"));
			r->ms->setRange(dur.value(QStringLiteral("min")).toInt(0), dur.value(QStringLiteral("max")).toInt(10000));
		}
		for (const auto &c : b.value(QStringLiteral("canvases")).toArray()) {
			const QJsonObject o = c.toObject(), t = o.value(QStringLiteral("transition")).toObject();
			Row &r = s(o, "id") == QStringLiteral("v") ? v_ : h_;
			const QSignalBlocker b1(r.type);
			if (r.type->findData(s(t, "type")) < 0)
				r.type->addItem(QStringLiteral("Stinger (video)"), s(t, "type")); // kept as it is unless changed here
			r.type->setCurrentIndex(std::max(0, r.type->findData(s(t, "type", QStringLiteral("cut")))));
			r.ease->setCurrentIndex(std::max(0, r.ease->findData(s(t, "easing", QStringLiteral("linear")))));
			r.ms->setValue(t.value(QStringLiteral("durationMs")).toInt(e.value(QStringLiteral("durationMs")).toObject().value(QStringLiteral("default")).toInt(500)));
			if (&r == &v_) {
				const QSignalBlocker b2(mirror_);
				mirror_->setChecked(t.value(QStringLiteral("mirror")).toBool());
			}
		}
		setEnabled(true);
		for (Row *r : {&h_, &v_})
			r->type->setEnabled(!live_);
		mirror_->setEnabled(!live_);
		v_.type->setEnabled(!live_ && !mirror_->isChecked());
		sync(h_);
		sync(v_);
		orig_ = signature();
	});
}

QString TransitionsPage::signature() const
{
	QStringList out;
	for (const Row *r : {&h_, &v_})
		out << r->type->currentData().toString() << r->ease->currentData().toString() << QString::number(r->ms->value());
	out << (mirror_->isChecked() ? QStringLiteral("mirror") : QString());
	return out.join(QLatin1Char('|'));
}

void TransitionsPage::sync(Row &r)
{
	const bool fade = r.type->currentData().toString() == QStringLiteral("fade");
	const bool mirrored = &r == &v_ && mirror_->isChecked();
	r.ease->setEnabled(fade && !mirrored && !live_);
	r.ms->setEnabled(fade && !mirrored && !live_);
}

void TransitionsPage::save(const Note &note)
{
	if (live_ || data_.isEmpty() || signature() == orig_)
		return;
	auto body =[](const Row &r, const QString &canvas) {
		const QString type = r.type->currentData().toString();
		QJsonObject b{{QStringLiteral("canvas"), canvas}, {QStringLiteral("type"), type}};
		if (type == QStringLiteral("fade")) {
			b.insert(QStringLiteral("durationMs"), r.ms->value());
			b.insert(QStringLiteral("easing"), r.ease->currentData().toString());
		}
		return b;
	};
	for (const auto &c : data_.value(QStringLiteral("canvases")).toArray())
		if (s(c.toObject(), "id") == QStringLiteral("v") && s(c.toObject().value(QStringLiteral("transition")).toObject(), "type") == QStringLiteral("stinger") &&
		    v_.type->currentData().toString() == QStringLiteral("stinger") && !mirror_->isChecked())
			return; // a stinger stays as the main window's panel set it
	QJsonObject hb = body(h_, QStringLiteral("h"));
	QJsonObject vb = body(v_, QStringLiteral("v"));
	if (mirror_->isChecked()) { // the portrait canvas follows the main one; the host uses the main canvas's values
		vb = hb;
		vb.insert(QStringLiteral("canvas"), QStringLiteral("v"));
		vb.insert(QStringLiteral("mirror"), true);
	}
	if (hb.value(QStringLiteral("type")).toString() == QStringLiteral("stinger"))
		hb = QJsonObject(); // set in the main window's panel
	// The page goes with the Settings window right after Save: the chain holds only the client and the note.
	auto send = [api = api_, note](const QJsonObject &b, std::function<void()> next) {
		if (b.isEmpty())
			return next();
		api->post(QStringLiteral("ui/api/project/transition"), b, [note, next, b](bool ok, const QJsonObject &, const QString &err) {
			if (!ok)
				note(QStringLiteral("Transition (%1) not saved: %2").arg(b.value(QStringLiteral("canvas")).toString().toUpper(), err));
			next();
		});
	};
	send(hb, [send, vb, note]() { send(vb, [note]() { note(QStringLiteral("Transitions saved; the host follows within a few seconds.")); }); });
}

void TransitionsPage::force(const QString &canvas)
{
	api_->post(QStringLiteral("ui/api/transitions/force"), QJsonObject{{QStringLiteral("canvas"), canvas}}, [this, canvas, alive = QPointer<QObject>(this)](bool ok, const QJsonObject &b, const QString &err) {
		if (!alive)
			return;
		const bool done = b.value(QStringLiteral("result")).toObject().value(QStringLiteral("completed")).toBool();
		forced_ = canvas + (ok ? (done ? QStringLiteral(":completed") : QStringLiteral(":idle")) : QStringLiteral(":error"));
		status_->setText(!ok ? QStringLiteral("Force complete failed: ") + err
				     : done ? QStringLiteral("The running transition was completed.") : QStringLiteral("No transition was running on that canvas."));
	});
}

QJsonObject TransitionsPage::probe() const
{
	auto row = [](const Row &r) {
		return QJsonObject{{QStringLiteral("type"), r.type->currentData().toString()}, {QStringLiteral("easing"), r.ease->currentData().toString()},
				   {QStringLiteral("easingChoices"), r.ease->count()}, {QStringLiteral("durationMs"), r.ms->value()}, {QStringLiteral("easingEnabled"), r.ease->isEnabled()}};
	};
	return QJsonObject{{QStringLiteral("loaded"), !data_.isEmpty()}, {QStringLiteral("h"), row(h_)}, {QStringLiteral("v"), row(v_)},
			   {QStringLiteral("mirror"), mirror_->isChecked()}, {QStringLiteral("forced"), forced_}, {QStringLiteral("status"), status_->text()}};
}

bool TransitionsPage::probeAction(const QStringList &p)
{
	if (p.size() == 2 && p[0] == QStringLiteral("tr-force")) {
		Row &r = p[1] == QStringLiteral("v") ? v_ : h_;
		if (!r.force->isEnabled() || !isEnabled())
			return false;
		r.force->click();
		return true;
	}
	if (p.size() == 2 && p[0] == QStringLiteral("tr-mirror")) {
		mirror_->setChecked(p[1] == QStringLiteral("on"));
		return true;
	}
	if (p.size() == 3 && (p[0] == QStringLiteral("tr-type") || p[0] == QStringLiteral("tr-ease"))) {
		Row &r = p[1] == QStringLiteral("v") ? v_ : h_;
		QComboBox *c = p[0] == QStringLiteral("tr-type") ? r.type : r.ease;
		if (c->findData(p[2]) < 0 || !c->isEnabled())
			return false;
		c->setCurrentIndex(c->findData(p[2]));
		return true;
	}
	if (p.size() == 3 && p[0] == QStringLiteral("tr-ms")) {
		Row &r = p[1] == QStringLiteral("v") ? v_ : h_;
		r.ms->setValue(p[2].toInt());
		return true;
	}
	return false;
}

// ---------------------------------------------------------------- Settings > Integrations

IntegrationsPage::IntegrationsPage(ApiClient *api, QWidget *parent) : QWidget(parent), api_(api)
{
	setObjectName(QStringLiteral("integrationsPage"));
	auto *v = new QVBoxLayout(this);
	v->setContentsMargins(0, 0, 0, 0);
	theme::space(v, 12);
	auto bot = [&](const QString &title, const QString &id, QSpinBox *&port, QLabel *&status, const QString &note) {
		auto *box = new QGroupBox(title, this);
		auto *f = new QFormLayout(box);
		auto *addr = new QLineEdit(QStringLiteral("127.0.0.1"), box);
		addr->setReadOnly(true);
		addr->setToolTip(QStringLiteral("The bots run on this PC."));
		port = new QSpinBox(box);
		port->setRange(1024, 65535);
		auto *row = new QWidget(box);
		auto *h = new QHBoxLayout(row);
		h->setContentsMargins(0, 0, 0, 0);
		auto *t = new QPushButton(QStringLiteral("Test"), row);
		t->setObjectName(id + QStringLiteral("Test"));
		status = new QLabel(QStringLiteral("Not tested"), row);
		h->addWidget(t);
		h->addWidget(status, 1);
		f->addRow(QStringLiteral("Address"), addr);
		f->addRow(QStringLiteral("Port"), port);
		f->addRow(QStringLiteral("Status"), row);
		f->addRow(muted(note, box));
		connect(t, &QPushButton::clicked, this, [this, id]() { test(id); });
		v->addWidget(box);
	};
	bot(QStringLiteral("STREAMER.BOT"), QStringLiteral("streamerbot"), sbPort_, sbStatus_,
	    QStringLiteral("Ujwalam only reads from Streamer.bot (chat and events); it never sends it actions. A new port is used from the next start."));
	bot(QStringLiteral("SPEAKER.BOT"), QStringLiteral("speakerbot"), spPort_, spStatus_, QStringLiteral("Used for the pre-stream check. A new port is used from the next start."));

	auto *rb = new QGroupBox(QStringLiteral("REMOTE CONNECTIONS"), this);
	auto *rv = new QVBoxLayout(rb);
	remote_ = new QCheckBox(QStringLiteral("Allow remote connections"), rb);
	remote_->setObjectName(QStringLiteral("integrationsRemote"));
	rv->addWidget(remote_);
	rv->addWidget(muted(QStringLiteral("Off by default. When on, devices on your home network (the same Wi-Fi or cable network) can read Ujwalam's status and send requests, "
					   "after pairing with a code from this page. It never listens on the internet, and it cannot change scenes or start a stream by itself. "
					   "Turn it off when you do not use it. It starts with the next start of Ujwalam."),
			    rb));
	auto *ah = new QHBoxLayout();
	ah->addWidget(new QLabel(QStringLiteral("Network address"), rb));
	remoteAddr_ = new QComboBox(rb);
	ah->addWidget(remoteAddr_, 1);
	rv->addLayout(ah);
	remoteInfo_ = muted(QString(), rb);
	rv->addWidget(remoteInfo_);
	copyToken_ = new QPushButton(QStringLiteral("Copy pairing code"), rb);
	copyToken_->setEnabled(false);
	rv->addWidget(copyToken_, 0, Qt::AlignLeft);
	v->addWidget(rb);
	v->addStretch(1);
	connect(remote_, &QCheckBox::toggled, remoteAddr_, &QWidget::setEnabled);
	connect(copyToken_, &QPushButton::clicked, this, [this]() {
		api_->post(QStringLiteral("ui/api/integrations/remote-token"), {}, [this, alive = QPointer<QObject>(this)](bool ok, const QJsonObject &b, const QString &err) {
		if (!alive)
			return; // the page closed before the answer came
			if (!ok)
				return remoteInfo_->setText(QStringLiteral("No pairing code: ") + err);
			QApplication::clipboard()->setText(b.value(QStringLiteral("token")).toString());
			remoteInfo_->setText(QStringLiteral("Pairing code copied. Paste it on the other device only."));
		});
	});
	setEnabled(false);
	load();
}

void IntegrationsPage::load()
{
	api_->get(QStringLiteral("ui/api/integrations"), [this, alive = QPointer<QObject>(this)](bool ok, const QJsonObject &b, const QString &err) {
		if (!alive)
			return; // the page closed before the answer came
		if (!ok) {
			remoteInfo_->setText(QStringLiteral("Integrations not available: ") + err);
			return;
		}
		data_ = b;
		const QJsonObject val = b.value(QStringLiteral("value")).toObject(), bots = val.value(QStringLiteral("bots")).toObject();
		sbPort_->setValue(bots.value(QStringLiteral("streamerbot")).toObject().value(QStringLiteral("port")).toInt());
		spPort_->setValue(bots.value(QStringLiteral("speakerbot")).toObject().value(QStringLiteral("port")).toInt());
		const QJsonObject rem = val.value(QStringLiteral("remote")).toObject(), run = b.value(QStringLiteral("remote")).toObject();
		remoteAddr_->clear();
		remoteAddr_->addItem(QStringLiteral("Automatic (first home network address)"), QString()); // empty = null (automatic)
		for (const auto &a : run.value(QStringLiteral("lan")).toArray())
			remoteAddr_->addItem(a.toString(), a.toString());
		if (rem.value(QStringLiteral("address")).isString()) {
			if (remoteAddr_->findData(s(rem, "address")) < 0)
				remoteAddr_->addItem(s(rem, "address"), s(rem, "address"));
			remoteAddr_->setCurrentIndex(remoteAddr_->findData(s(rem, "address")));
		}
		remote_->setChecked(rem.value(QStringLiteral("enabled")).toBool());
		remoteAddr_->setEnabled(remote_->isChecked());
		const bool running = run.value(QStringLiteral("running")).toBool();
		copyToken_->setEnabled(running);
		remoteInfo_->setText(running ? QStringLiteral("Listening on %1:%2 (home network only).").arg(s(run, "address")).arg(run.value(QStringLiteral("port")).toInt())
					     : run.value(QStringLiteral("lan")).toArray().isEmpty() ? QStringLiteral("Not running. No home network address found on this PC.")
												    : QStringLiteral("Not running."));
		if (b.value(QStringLiteral("corrupt")).toBool())
			remoteInfo_->setText(QStringLiteral("The saved integrations file could not be read; defaults are shown (remote connections off)."));
		setEnabled(true);
	});
}

void IntegrationsPage::test(const QString &bot)
{
	QLabel *st = bot == QStringLiteral("streamerbot") ? sbStatus_ : spStatus_;
	const int port = (bot == QStringLiteral("streamerbot") ? sbPort_ : spPort_)->value();
	st->setText(QStringLiteral("Testing..."));
	api_->post(QStringLiteral("ui/api/integrations/test"), QJsonObject{{QStringLiteral("bot"), bot}, {QStringLiteral("port"), port}}, [st = QPointer<QLabel>(st), port](bool ok, const QJsonObject &b, const QString &err) {
		if (!st)
			return;
		if (!ok)
			return st->setText(QStringLiteral("Test failed: ") + err);
		st->setText(b.value(QStringLiteral("answered")).toBool() ? QStringLiteral("Connected (127.0.0.1:%1 answers)").arg(port)
									   : QStringLiteral("Not reachable on 127.0.0.1:%1. Is it running, with its WebSocket server on?").arg(port));
	});
}

QJsonObject IntegrationsPage::edited() const
{
	QJsonObject val = data_.value(QStringLiteral("value")).toObject();
	val.insert(QStringLiteral("bots"), QJsonObject{{QStringLiteral("streamerbot"), QJsonObject{{QStringLiteral("port"), sbPort_->value()}}},
						     {QStringLiteral("speakerbot"), QJsonObject{{QStringLiteral("port"), spPort_->value()}}}});
	val.insert(QStringLiteral("remote"), QJsonObject{{QStringLiteral("enabled"), remote_->isChecked()}, {QStringLiteral("address"), remoteAddr_->currentData().toString().isEmpty() ? QJsonValue() : QJsonValue(remoteAddr_->currentData().toString())}});
	return val;
}

bool IntegrationsPage::dirty() const
{
	return !data_.isEmpty() && edited() != data_.value(QStringLiteral("value")).toObject();
}

void IntegrationsPage::save(const Note &note)
{
	if (data_.isEmpty())
		return;
	const QJsonObject val = edited();
	if (val == data_.value(QStringLiteral("value")).toObject() && data_.value(QStringLiteral("exists")).toBool())
		return; // unchanged
	api_->post(QStringLiteral("ui/api/integrations"), QJsonObject{{QStringLiteral("value"), val}}, [note](bool ok, const QJsonObject &b, const QString &err) {
		if (ok)
			return note(QStringLiteral("Integrations saved; they apply at the next start."));
		const QString why = problemsText(b.value(QStringLiteral("problems")).toArray());
		note(QStringLiteral("Integrations not saved: ") + (why.isEmpty() ? err : why));
	});
}

QJsonObject IntegrationsPage::probe() const
{
	return QJsonObject{{QStringLiteral("loaded"), !data_.isEmpty()}, {QStringLiteral("streamerbotPort"), sbPort_->value()}, {QStringLiteral("speakerbotPort"), spPort_->value()},
			   {QStringLiteral("streamerbotStatus"), sbStatus_->text()}, {QStringLiteral("speakerbotStatus"), spStatus_->text()},
			   {QStringLiteral("remote"), remote_->isChecked()}, {QStringLiteral("remoteInfo"), remoteInfo_->text()}};
}

bool IntegrationsPage::probeAction(const QStringList &p)
{
	if (p.size() == 2 && p[0] == QStringLiteral("int-test") && (p[1] == QStringLiteral("streamerbot") || p[1] == QStringLiteral("speakerbot"))) {
		if (auto *b = findChild<QPushButton *>(p[1] + QStringLiteral("Test")); b && b->isEnabled()) {
			b->click();
			return true;
		}
		return false;
	}
	if (p.size() == 2 && p[0] == QStringLiteral("int-remote")) {
		remote_->setChecked(p[1] == QStringLiteral("on"));
		return true;
	}
	return false;
}

// ---------------------------------------------------------------- Outputs panel (main window)

OutputsPanel::OutputsPanel(ApiClient *api, QWidget *parent) : QGroupBox(QStringLiteral("OUTPUTS"), parent), api_(api)
{
	setObjectName(QStringLiteral("outputsPanel"));
	auto *v = new QVBoxLayout(this);
	theme::space(v, 6);
	auto *head = new QHBoxLayout();
	head->addStretch(1);
	auto *plus = new QPushButton(QStringLiteral("+"), this);
	plus->setObjectName(QStringLiteral("outputsAdd"));
	plus->setToolTip(QStringLiteral("Add an output (Settings > Stream)"));
	plus->setFixedWidth(30);
	head->addWidget(plus);
	v->addLayout(head);
	rows_ = new QVBoxLayout();
	theme::space(rows_, 4);
	v->addLayout(rows_);
	connect(plus, &QPushButton::clicked, this, &OutputsPanel::addRequested);
}

void OutputsPanel::refresh()
{
	if (busy_)
		return;
	busy_ = true;
	api_->get(QStringLiteral("ui/api/outputs/panel"), [this, alive = QPointer<QObject>(this)](bool ok, const QJsonObject &b, const QString &err) {
		if (!alive)
			return; // the page closed before the answer came
		busy_ = false;
		if (!ok) {
			if (data_.isEmpty())
				emit message(QStringLiteral("Outputs not available: ") + err);
			return;
		}
		// Rebuild only when the list changed; otherwise the switches follow the states.
		QStringList ids, was;
		for (const auto &x : b.value(QStringLiteral("outputs")).toArray())
			ids << x.toObject().value(QStringLiteral("id")).toString();
		for (const auto &x : data_.value(QStringLiteral("outputs")).toArray())
			was << x.toObject().value(QStringLiteral("id")).toString();
		const bool live = b.value(QStringLiteral("live")).toBool();
		if (ids != was || data_.isEmpty()) {
			while (QLayoutItem *it = rows_->takeAt(0)) {
				delete it->widget();
				delete it;
			}
			switches_.clear();
			for (const auto &x : b.value(QStringLiteral("outputs")).toArray()) {
				const QJsonObject o = x.toObject();
				auto *row = new QWidget(this);
				auto *h = new QHBoxLayout(row);
				h->setContentsMargins(0, 0, 0, 0);
				const QString p = s(o, "platform");
				h->addWidget(badge(p == QStringLiteral("youtube") ? QStringLiteral("YT") : p == QStringLiteral("twitch") ? QStringLiteral("TW") : p.left(1).toUpper(), row));
				auto *t = new QLabel(QStringLiteral("%1<br><span>%2</span>").arg(s(o, "name").toHtmlEscaped(), s(o, "summary").toHtmlEscaped()), row);
				t->setObjectName(QStringLiteral("outputRowText"));
				t->setWordWrap(true); // never wider than the column
				h->addWidget(t, 1);
				auto *sw = new Switch(row);
				sw->setObjectName(QStringLiteral("outputSwitch"));
				sw->setProperty("output", s(o, "id"));
				h->addWidget(sw);
				const QString id = s(o, "id");
				connect(sw, &QAbstractButton::toggled, this, [this, id](bool on) { toggle(id, on); });
				switches_.insert(id, sw);
				rows_->addWidget(row);
			}
			// Virtual Camera: not in this host build (no virtual camera method); shown, switched off.
			auto *vc = new QWidget(this);
			auto *vh = new QHBoxLayout(vc);
			vh->setContentsMargins(0, 0, 0, 0);
			vh->addWidget(badge(QStringLiteral("VC"), vc));
			const QJsonObject vco = b.value(QStringLiteral("virtualCamera")).toObject();
			auto *vcText = new QLabel(QStringLiteral("Virtual Camera<br><span>Not available in this build</span>"), vc);
			vcText->setWordWrap(true);
			vcText->setToolTip(s(vco, "reason"));
			vh->addWidget(vcText, 1);
			auto *vsw = new Switch(vc);
			vsw->setObjectName(QStringLiteral("virtualCameraSwitch"));
			vsw->setEnabled(vco.value(QStringLiteral("available")).toBool());
			vh->addWidget(vsw);
			rows_->addWidget(vc);
		}
		data_ = b;
		for (const auto &x : b.value(QStringLiteral("outputs")).toArray()) {
			const QJsonObject o = x.toObject();
			Switch *sw = switches_.value(s(o, "id"));
			if (!sw)
				continue;
			// Offline: the switch is the saved choice. Live: what the host is doing for that output.
			const QString st = s(o, "state");
			const bool on = live ? (st == QStringLiteral("live") || st == QStringLiteral("starting") || st == QStringLiteral("retrying")) : o.value(QStringLiteral("enabled")).toBool();
			sw->setCheckedSilently(on);
			sw->setEnabled(o.value(QStringLiteral("inPlan")).toBool() && (!live || !st.isEmpty()));
			sw->setToolTip(!o.value(QStringLiteral("inPlan")).toBool() ? QStringLiteral("Portrait outputs need Main + portrait canvas (Settings > Stream).")
				       : live ? QStringLiteral("Live: switching starts or stops this output only, at once.")
					      : QStringLiteral("Whether Start stream starts this output."));
		}
	});
}

void OutputsPanel::toggle(const QString &id, bool on)
{
	api_->post(QStringLiteral("ui/api/outputs/toggle"), QJsonObject{{QStringLiteral("id"), id}, {QStringLiteral("on"), on}}, [this, alive = QPointer<QObject>(this)](bool ok, const QJsonObject &b, const QString &err) {
		if (!alive)
			return; // the page closed before the answer came
		if (!ok) {
			emit message(QStringLiteral("Output not switched: ") + (b.value(QStringLiteral("detail")).toString().isEmpty() ? err : b.value(QStringLiteral("detail")).toString()));
		} else if (b.value(QStringLiteral("verdict")).toString() == QStringLiteral("confirm")) {
			emit confirmNeeded(b.value(QStringLiteral("pending")).toObject());
		}
		data_ = QJsonObject(); // the next refresh shows the real state (a refused or unconfirmed switch goes back)
		refresh();
	});
}

QJsonObject OutputsPanel::probe() const
{
	QJsonArray rows;
	for (auto it = switches_.cbegin(); it != switches_.cend(); ++it)
		rows.append(QJsonObject{{QStringLiteral("id"), it.key()}, {QStringLiteral("on"), it.value()->isChecked()}, {QStringLiteral("enabled"), it.value()->isEnabled()}});
	auto *vc = findChild<QAbstractButton *>(QStringLiteral("virtualCameraSwitch"));
	return QJsonObject{{QStringLiteral("rows"), rows}, {QStringLiteral("live"), data_.value(QStringLiteral("live")).toBool()},
			   {QStringLiteral("virtualCamera"), vc ? QJsonValue(vc->isEnabled()) : QJsonValue()}};
}

bool OutputsPanel::probeToggle(const QString &id, bool on)
{
	Switch *sw = switches_.value(id);
	if (!sw || !sw->isEnabled() || sw->isChecked() == on)
		return false;
	sw->click();
	return true;
}

} // namespace streampages
