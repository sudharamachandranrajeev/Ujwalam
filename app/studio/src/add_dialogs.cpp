// SPDX-License-Identifier: GPL-3.0-or-later
#include "add_dialogs.h"

#include "motion.h"
#include "theme.h"

#include <QColorDialog>
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QListWidget>
#include <QPointer>
#include <QPushButton>
#include <QRegularExpression>
#include <QShowEvent>
#include <QVBoxLayout>

namespace addui {

const LayerKind kLayerKinds[7] = {
	{"Copy of layer", "copy", "The same source again, placed on its own. A camera or capture card shown twice is opened once."},
	{"Colour", "color", "A solid colour fill."},
	{"Text", "text", "A line of text."},
	{"Capture device", "capture", "A camera or capture card from the project's devices."},
	{"Overlay", "overlay", "A page from the project's overlays (alerts, chat, counters)."},
	{"Image", "image", "A picture from the stream assets folder."},
	{"Video", "media", "A video from the stream assets folder."},
};

QList<QPair<QString, QString>> addChoices(const QJsonObject &st, const QString &kind)
{
	QList<QPair<QString, QString>> out;
	if (kind == QStringLiteral("copy")) {
		for (const auto &x : st.value(QStringLiteral("layers")).toArray()) {
			const QJsonObject l = x.toObject();
			out.append({l.value(QStringLiteral("sceneName")).toString() + QStringLiteral(" / ") + l.value(QStringLiteral("name")).toString(),
				    l.value(QStringLiteral("id")).toString()});
		}
	} else if (kind == QStringLiteral("capture") || kind == QStringLiteral("overlay")) {
		for (const auto &x : st.value(kind == QStringLiteral("capture") ? QStringLiteral("devices") : QStringLiteral("overlays")).toArray()) {
			const QJsonObject d = x.toObject();
			out.append({d.value(QStringLiteral("name")).toString(), d.value(QStringLiteral("id")).toString()});
		}
	} else if (kind == QStringLiteral("image") || kind == QStringLiteral("media")) {
		for (const auto &x : st.value(QStringLiteral("assets")).toArray()) {
			const QJsonObject a = x.toObject();
			if (a.value(QStringLiteral("kind")).toString() == kind)
				out.append({a.value(QStringLiteral("rel")).toString(), a.value(QStringLiteral("rel")).toString()});
		}
	}
	return out;
}

QJsonObject layerAddBody(const QString &scene, const QString &kind, const QString &pick, const QString &text, QString &err)
{
	QJsonObject b;
	b.insert(QStringLiteral("op"), QStringLiteral("layer.add"));
	b.insert(QStringLiteral("scene"), scene);
	b.insert(QStringLiteral("kind"), kind);
	if (kind == QStringLiteral("color") || kind == QStringLiteral("text")) {
		if (text.trimmed().isEmpty())
			err = kind == QStringLiteral("color") ? QStringLiteral("Type a colour as #RRGGBB.") : QStringLiteral("Type the text.");
		b.insert(kind, kind == QStringLiteral("color") ? text.trimmed() : text);
	} else {
		if (pick.isEmpty())
			err = QStringLiteral("Nothing to pick for this kind.");
		const QString key = kind == QStringLiteral("copy") ? QStringLiteral("of") : kind == QStringLiteral("capture") ? QStringLiteral("device")
				: kind == QStringLiteral("overlay") ? QStringLiteral("overlay") : QStringLiteral("file");
		b.insert(key, pick);
	}
	return b;
}

void polish(QWidget *w)
{
	// Keyboard focus, pressed and disabled looks that the app style leaves out. Tokens come from theme.h.
	w->setStyleSheet(w->styleSheet() + QStringLiteral(
		"QPushButton:focus, QToolButton:focus { border-color: %1; }"
		"QPushButton:pressed, QToolButton:pressed { background: %2; }"
		"QToolButton:disabled { color: #5d5972; border-color: %3; }"
		"QListWidget:focus { border-color: %1; }"
		"QListWidget::item:disabled { color: #5d5972; }"
		"QMenu::item:disabled { color: #5d5972; background: transparent; }"
		"QMenu::item:pressed { background: %4; }")
			.arg(QLatin1String(theme::kAccent), QLatin1String(theme::kBorder), QLatin1String(theme::kField), QLatin1String(theme::kAccentHi)));
}

void popIn(QWidget *w, bool grow)
{
	if (!motion::enabled(w))
		return;
	const QRect g = w->geometry();
	QPointer<QWidget> guard(w);
	w->setWindowOpacity(0.0);
	motion::run(w, 0.0, 1.0, 140, QEasingCurve::OutCubic, [guard, g, grow](const QVariant &v) {
		if (!guard)
			return;
		const qreal t = v.toReal();
		guard->setWindowOpacity(t);
		if (grow) { // 96 % -> 100 %, around the centre
			const qreal k = 0.96 + 0.04 * t;
			QRect r(0, 0, qRound(g.width() * k), qRound(g.height() * k));
			r.moveCenter(g.center());
			guard->setGeometry(r);
		}
	}, [guard, g]() {
		if (guard) {
			guard->setWindowOpacity(1.0);
			guard->setGeometry(g);
		}
	});
}

FadeDialog::FadeDialog(QWidget *parent) : QDialog(parent)
{
	setAttribute(Qt::WA_DeleteOnClose);
	polish(this);
}

void FadeDialog::showEvent(QShowEvent *e)
{
	QDialog::showEvent(e);
	if (!shown_) {
		shown_ = true;
		popIn(this, true);
	}
}

// Closing (OK, Cancel, Esc, the X) fades out first when motion is on; then the window goes and deletes itself.
void FadeDialog::done(int r)
{
	if (closing_)
		return;
	closing_ = true;
	QPointer<FadeDialog> guard(this);
	auto finish = [guard, r]() {
		if (!guard)
			return;
		guard->QDialog::done(r);
		guard->close(); // hidden now: accepts the close and deletes the window
	};
	if (!isVisible() || !motion::enabled(this))
		return finish();
	motion::run(this, 1.0, 0.0, 110, QEasingCurve::InCubic, [guard](const QVariant &v) {
		if (guard)
			guard->setWindowOpacity(v.toReal());
	}, finish);
}

// ---- Add layer ----

AddLayerDialog::AddLayerDialog(const QJsonObject &structure, const QString &sceneId, const QString &sceneName, QWidget *parent)
	: FadeDialog(parent), structure_(structure), scene_(sceneId)
{
	setWindowTitle(QStringLiteral("Add layer to \"%1\"").arg(sceneName));
	auto *h = new QHBoxLayout(this);
	kinds_ = new QListWidget(this);
	for (const auto &k : kLayerKinds) {
		auto *it = new QListWidgetItem(QString::fromLatin1(k.label), kinds_);
		const QString kind = QString::fromLatin1(k.kind);
		it->setData(Qt::UserRole, kind);
		const bool typed = kind == QStringLiteral("color") || kind == QStringLiteral("text");
		const bool can = typed || !addChoices(structure_, kind).isEmpty();
		it->setToolTip(QString::fromLatin1(k.about) + (can ? QString() : QStringLiteral("\nNothing to pick: the project has none.")));
		if (!can)
			it->setFlags(it->flags() & ~(Qt::ItemIsEnabled | Qt::ItemIsSelectable)); // greyed: it could not add anything
	}
	kinds_->setMaximumWidth(170);
	h->addWidget(kinds_);
	auto *right = new QVBoxLayout();
	about_ = new QLabel(this);
	about_->setWordWrap(true);
	search_ = new QLineEdit(this);
	search_->setPlaceholderText(QStringLiteral("Search"));
	search_->setClearButtonEnabled(true);
	choices_ = new QListWidget(this);
	text_ = new QLineEdit(this);
	text_->setMaxLength(2000);
	colour_ = new QPushButton(QStringLiteral("Pick colour..."), this);
	auto *row = new QHBoxLayout();
	add_ = new QPushButton(QStringLiteral("Add"), this);
	add_->setProperty("role", QStringLiteral("primary"));
	auto *cancel = new QPushButton(QStringLiteral("Close"), this);
	add_->setDefault(true);
	row->addStretch(1);
	row->addWidget(add_);
	row->addWidget(cancel);
	right->addWidget(about_);
	right->addWidget(search_);
	right->addWidget(choices_, 1);
	right->addWidget(text_);
	right->addWidget(colour_);
	right->addStretch(0);
	right->addLayout(row);
	h->addLayout(right, 1);
	connect(kinds_, &QListWidget::currentRowChanged, this, [this]() {
		const QListWidgetItem *k = kinds_->currentItem();
		const QString kind = k ? k->data(Qt::UserRole).toString() : QString();
		const bool typed = kind == QStringLiteral("color") || kind == QStringLiteral("text");
		about_->setText(k ? k->toolTip() : QString());
		search_->setVisible(!typed);
		choices_->setVisible(!typed);
		text_->setVisible(typed);
		colour_->setVisible(kind == QStringLiteral("color"));
		text_->setPlaceholderText(kind == QStringLiteral("color") ? QStringLiteral("#RRGGBB") : QStringLiteral("Text"));
		choices_->clear();
		search_->clear();
		for (const auto &c : addChoices(structure_, kind)) {
			auto *it = new QListWidgetItem(c.first, choices_);
			it->setData(Qt::UserRole, c.second);
		}
		choices_->setCurrentRow(0);
		add_->setEnabled(k != nullptr);
	});
	connect(search_, &QLineEdit::textChanged, this, [this](const QString &q) {
		for (int i = 0; i < choices_->count(); i++)
			choices_->item(i)->setHidden(!q.isEmpty() && !choices_->item(i)->text().contains(q, Qt::CaseInsensitive));
	});
	connect(colour_, &QPushButton::clicked, this, [this]() {
		const QColor c = QColorDialog::getColor(QColor(text_->text().trimmed()), this, QStringLiteral("Layer colour"));
		if (c.isValid())
			text_->setText(c.name(QColor::HexRgb));
	});
	connect(add_, &QPushButton::clicked, this, &AddLayerDialog::send);
	connect(text_, &QLineEdit::returnPressed, this, &AddLayerDialog::send);
	connect(choices_, &QListWidget::itemDoubleClicked, this, [this](QListWidgetItem *) { send(); });
	connect(cancel, &QPushButton::clicked, this, &QDialog::reject);
	for (int i = 0; i < kinds_->count(); i++) // first kind that can add something
		if (kinds_->item(i)->flags() & Qt::ItemIsEnabled) {
			kinds_->setCurrentRow(i);
			break;
		}
	resize(620, 380);
}

void AddLayerDialog::send()
{
	const QListWidgetItem *k = kinds_->currentItem();
	const QListWidgetItem *c = choices_->currentItem();
	QString err;
	const QJsonObject b = layerAddBody(scene_, k ? k->data(Qt::UserRole).toString() : QString(),
					   c && !c->isHidden() ? c->data(Qt::UserRole).toString() : QString(), text_->text(), err);
	if (err.isEmpty() && k && k->data(Qt::UserRole).toString() == QStringLiteral("color") &&
	    !QRegularExpression(QStringLiteral("^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")).match(text_->text().trimmed()).hasMatch())
		err = QStringLiteral("Colour must look like #RRGGBB.");
	if (!k || !err.isEmpty()) { // the message stays in the window: the main window's note would be hidden behind it
		about_->setText(k ? err : QStringLiteral("Pick a kind first."));
		return;
	}
	emit chosen(b);
	accept();
}

bool AddLayerDialog::probeKind(const QString &kind)
{
	for (int i = 0; i < kinds_->count(); i++)
		if (kinds_->item(i)->data(Qt::UserRole).toString() == kind && (kinds_->item(i)->flags() & Qt::ItemIsEnabled)) {
			kinds_->setCurrentRow(i);
			return true;
		}
	return false;
}

bool AddLayerDialog::probeChoice(int row)
{
	if (row < 0 || row >= choices_->count())
		return false;
	choices_->setCurrentRow(row);
	return true;
}

bool AddLayerDialog::probeText(const QString &text)
{
	if (text_->isHidden())
		return false;
	text_->setText(text);
	return true;
}

bool AddLayerDialog::probeSend()
{
	if (!add_->isEnabled())
		return false;
	add_->click();
	return true;
}

QJsonObject AddLayerDialog::probe() const
{
	QJsonArray ks;
	for (int i = 0; i < kinds_->count(); i++) {
		const QListWidgetItem *it = kinds_->item(i);
		ks.append(QJsonObject{{QStringLiteral("kind"), it->data(Qt::UserRole).toString()}, {QStringLiteral("label"), it->text()},
				      {QStringLiteral("enabled"), bool(it->flags() & Qt::ItemIsEnabled)}, {QStringLiteral("about"), it->toolTip()}});
	}
	const QListWidgetItem *cur = kinds_->currentItem();
	return QJsonObject{{QStringLiteral("kind"), QStringLiteral("layer")}, {QStringLiteral("kinds"), ks},
			   {QStringLiteral("current"), cur ? cur->data(Qt::UserRole).toString() : QString()},
			   {QStringLiteral("choices"), choices_->isHidden() ? 0 : choices_->count()}, {QStringLiteral("title"), windowTitle()}};
}

// ---- Add scene ----

AddSceneDialog::AddSceneDialog(const QStringList &canvases, QWidget *parent) : FadeDialog(parent)
{
	setWindowTitle(QStringLiteral("Add scene"));
	auto *v = new QVBoxLayout(this);
	v->addWidget(new QLabel(QStringLiteral("Scene name"), this));
	name_ = new QLineEdit(this);
	name_->setMaxLength(80);
	name_->setPlaceholderText(QStringLiteral("For example: Starting soon"));
	v->addWidget(name_);
	QStringList up;
	for (const QString &c : canvases)
		up << c.toUpper();
	where_ = new QLabel(QStringLiteral("The scene is made on every canvas of the project: %1.").arg(up.isEmpty() ? QStringLiteral("H") : up.join(QStringLiteral(" + "))), this);
	where_->setWordWrap(true);
	where_->setObjectName(QStringLiteral("heading"));
	v->addWidget(where_);
	auto *row = new QHBoxLayout();
	add_ = new QPushButton(QStringLiteral("Add scene"), this);
	add_->setProperty("role", QStringLiteral("primary"));
	add_->setDefault(true);
	add_->setEnabled(false);
	auto *cancel = new QPushButton(QStringLiteral("Close"), this);
	row->addStretch(1);
	row->addWidget(add_);
	row->addWidget(cancel);
	v->addLayout(row);
	connect(name_, &QLineEdit::textChanged, this, [this](const QString &t) { add_->setEnabled(!t.trimmed().isEmpty()); });
	connect(name_, &QLineEdit::returnPressed, this, &AddSceneDialog::send);
	connect(add_, &QPushButton::clicked, this, &AddSceneDialog::send);
	connect(cancel, &QPushButton::clicked, this, &QDialog::reject);
	resize(380, 160);
}

void AddSceneDialog::send()
{
	const QString n = name_->text().trimmed();
	if (n.isEmpty())
		return;
	emit chosen(QJsonObject{{QStringLiteral("op"), QStringLiteral("scene.add")}, {QStringLiteral("name"), n.left(80)}});
	accept();
}

bool AddSceneDialog::probeName(const QString &name)
{
	name_->setText(name);
	return true;
}

bool AddSceneDialog::probeSend()
{
	if (!add_->isEnabled())
		return false;
	add_->click();
	return true;
}

QJsonObject AddSceneDialog::probe() const
{
	return QJsonObject{{QStringLiteral("kind"), QStringLiteral("scene")}, {QStringLiteral("where"), where_->text()}, {QStringLiteral("canAdd"), add_->isEnabled()}};
}

} // namespace addui
