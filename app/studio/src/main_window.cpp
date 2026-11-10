// SPDX-License-Identifier: GPL-3.0-or-later
#include "main_window.h"
#include "guide.h"
#include "icons.h"
#include "add_dialogs.h"
#include "look_panel.h"
#include "appearance.h"
#include "motion.h"
#include "stats_cards.h"
#include "taskbar.h"
#include "tray.h"
#include "theme.h"
#include "layer_list.h"
#include "value_slider.h"

#include <QCheckBox>
#include <QDateTime>
#include <QColorDialog>
#include <QComboBox>
#include <QDoubleSpinBox>
#include <QFormLayout>
#include <QFrame>
#include <QGridLayout>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QApplication>
#include <QIcon>
#include <QJsonDocument>
#include <cstdio>
#include <QInputDialog>
#include <QJsonArray>
#include <QLabel>
#include <QLineEdit>
#include <QDesktopServices>
#include <QDialog>
#include <QDialogButtonBox>
#include <QDir>
#include <QFileDialog>
#include <QListWidget>
#include <QPlainTextEdit>
#include <QPointer>
#include <QMessageBox>
#include <QProgressBar>
#include <QRegularExpressionValidator>
#include <QMenu>
#include <QPushButton>
#include <QScrollArea>
#include <QScrollBar>
#include <QShortcut>
#include <QSignalBlocker>
#include <QSlider>
#include <QSpinBox>
#include <QSplitter>
#include <QStackedWidget>
#include <QStyledItemDelegate>
#include <QPainter>
#include <QStatusBar>
#include <QStyle>
#include <QTimer>
#include <QCloseEvent>
#include <QUrl>
#include <QUrlQuery>
#include <QToolButton>
#include <QVBoxLayout>
#include <algorithm>
#include <memory>
#include <tuple>
#include <cmath>

namespace {

// Effect editor (D260): every effect type the host knows (app/host/src/model.cpp, same ranges), its settings and the
// values a new one starts with. Numbers are canvas px, 0..1 shares or degrees, as in data/schemas/project.schema.json.
struct FxParam {
	const char *key, *label;
	bool colour;
	double lo, hi, def, step;
	int dec;
	const char *cdef;
};
// group (D290): where the effect is listed in the inspector: "shape" (corners, pin, blinds), "filter" (colour, blur,
// looks), "camera" (key, mask, mirror), "compositing" (blend, opacity, masks), "light" (shadow, glow).
struct FxType {
	const char *type, *label;
	std::vector<FxParam> params;
	const char *group = "filter";
};

FxParam fxNum(const char *k, const char *l, double lo, double hi, double def, double step, int dec)
{
	return {k, l, false, lo, hi, def, step, dec, ""};
}
FxParam fxCol(const char *k, const char *l, const char *def)
{
	return {k, l, true, 0, 0, 0, 0, 0, def};
}

const std::vector<FxType> &fxTypes()
{
	static const std::vector<FxType> t = {
		{"blur", "Blur", {fxNum("strength", "Strength (source px)", 1, 100, 10, 1, 1)}, "filter"},
		{"rounded", "Rounded corners", {fxNum("radius", "Radius (source px)", 0, 500, 20, 1, 1)}, "shape"},
		{"chromaKey", "Chroma key", {fxCol("color", "Key colour", "#00ff00"), fxNum("similarity", "Similarity", 1, 1000, 400, 10, 0),
					     fxNum("smoothness", "Smoothness", 1, 1000, 80, 10, 0)}, "camera"},
		{"shadow", "Shadow", {fxCol("color", "Colour", "#000000"), fxNum("opacity", "Opacity", 0, 1, 0.5, 0.05, 2),
				      fxNum("size", "Softness (px)", 0, 200, 10, 1, 1), fxNum("distance", "Distance (px)", 0, 200, 10, 1, 1),
				      fxNum("angle", "Light from (degrees)", -360, 360, 135, 5, 1)}, "light"},
		{"glow", "Glow", {fxCol("color", "Colour", "#ffffff"), fxNum("opacity", "Opacity", 0, 1, 1, 0.05, 2),
				  fxNum("size", "Size (px)", 0, 200, 15, 1, 1), fxNum("spread", "Spread", 0, 1, 0, 0.05, 2)}, "light"},
		{"color", "Colour correction", {fxNum("brightness", "Brightness", -1, 1, 0, 0.05, 2), fxNum("contrast", "Contrast", -1, 1, 0, 0.05, 2),
						fxNum("saturation", "Saturation", -1, 1, 0, 0.05, 2), fxNum("hue", "Hue (degrees)", -180, 180, 0, 5, 1)}, "filter"},
		{"toner", "Toner", {fxCol("shadows", "Shadows", "#000000"), fxCol("darktones", "Dark tones", "#404040"),
				    fxCol("midtones", "Mid tones", "#808080"), fxCol("brights", "Brights", "#c0c0c0"),
				    fxCol("highlights", "Highlights", "#ffffff"), fxNum("amount", "Amount", 0, 1, 1, 0.05, 2)}, "filter"},
		{"blinds", "Blinds", {fxNum("completion", "Hidden share", 0, 1, 0.5, 0.05, 2), fxNum("angle", "Angle (degrees)", -360, 360, 90, 5, 1),
					  fxNum("width", "Slat width (% of layer)", 1, 100, 10, 1, 1), fxNum("feather", "Feather (px)", 0, 100, 2, 1, 1)}, "shape"},
		{"cornerPin", "Corner pin", {fxNum("topLeftX", "Top left x", 0, 1, 0, 0.01, 3), fxNum("topLeftY", "Top left y", 0, 1, 0, 0.01, 3),
					     fxNum("topRightX", "Top right x", 0, 1, 1, 0.01, 3), fxNum("topRightY", "Top right y", 0, 1, 0, 0.01, 3),
					     fxNum("bottomRightX", "Bottom right x", 0, 1, 1, 0.01, 3),
					     fxNum("bottomRightY", "Bottom right y", 0, 1, 1, 0.01, 3),
					     fxNum("bottomLeftX", "Bottom left x", 0, 1, 0, 0.01, 3),
					     fxNum("bottomLeftY", "Bottom left y", 0, 1, 1, 0.01, 3)}, "shape"},
		// D291. lut and imageMask need a file field (not in this table yet): they are kept as they are, not editable here.
		{"sharpen", "Sharpen", {fxNum("amount", "Amount", 0, 1, 0.2, 0.05, 2)}, "filter"},
		{"vignette", "Vignette", {fxNum("amount", "Amount", 0, 1, 0.5, 0.05, 2), fxNum("size", "Clear centre", 0, 1, 0.4, 0.05, 2),
					  fxNum("softness", "Softness", 0, 1, 0.5, 0.05, 2), fxCol("color", "Colour", "#000000")}, "filter"},
		{"grain", "Film grain", {fxNum("amount", "Amount", 0, 1, 0.15, 0.05, 2), fxNum("size", "Grain size (px)", 1, 10, 1, 1, 0)}, "filter"},
		{"pixelate", "Pixelate", {fxNum("size", "Block size (px)", 2, 200, 16, 1, 0)}, "filter"},
		{"posterize", "Posterize", {fxNum("levels", "Levels", 2, 32, 6, 1, 0)}, "filter"},
		{"mirror", "Mirror", {}, "camera"},
		{"flip", "Flip upside down", {}, "camera"},
		{"circleMask", "Circle mask", {fxNum("feather", "Soft edge (%)", 0, 25, 0, 0.5, 1), fxNum("borderWidth", "Border (%)", 0, 25, 0, 0.5, 1),
					       fxCol("borderColor", "Border colour", "#ffffff")}, "camera"},
		{"roundMask", "Rounded mask", {fxNum("radius", "Corner (%)", 0, 50, 12, 1, 1), fxNum("feather", "Soft edge (%)", 0, 25, 0, 0.5, 1),
					       fxNum("borderWidth", "Border (%)", 0, 25, 0, 0.5, 1), fxCol("borderColor", "Border colour", "#ffffff")}, "camera"},
		{"opacity", "Opacity", {fxNum("opacity", "Opacity", 0, 1, 1, 0.05, 2)}, "compositing"},
		{"blendAdd", "Blend: add", {fxNum("opacity", "Opacity", 0, 1, 1, 0.05, 2)}, "compositing"},
		{"blendSubtract", "Blend: subtract", {fxNum("opacity", "Opacity", 0, 1, 1, 0.05, 2)}, "compositing"},
		{"blendMultiply", "Blend: multiply", {fxNum("opacity", "Opacity", 0, 1, 1, 0.05, 2)}, "compositing"},
		{"blendScreen", "Blend: screen", {fxNum("opacity", "Opacity", 0, 1, 1, 0.05, 2)}, "compositing"},
		{"blendLighten", "Blend: lighten", {fxNum("opacity", "Opacity", 0, 1, 1, 0.05, 2)}, "compositing"},
		{"blendDarken", "Blend: darken", {fxNum("opacity", "Opacity", 0, 1, 1, 0.05, 2)}, "compositing"},
		{"gradientMask", "Gradient fade", {fxNum("angle", "Direction (degrees)", -360, 360, 90, 5, 1), fxNum("start", "Fade starts", 0, 1, 0.6, 0.05, 2),
						   fxNum("end", "Fade ends", 0, 1, 1, 0.05, 2)}, "compositing"},
		// Face AI (flag face-ai, D295 proposed). personMask mode (remove | blur | replace) and its file, and faceSticker
		// (file), need a choice / file field (not in this table yet): mode is kept as it is (added: remove), faceSticker
		// is not editable here.
		{"personMask", "Background (AI)", {fxNum("threshold", "Edge threshold", 0, 1, 0.5, 0.05, 2),
						   fxNum("feather", "Edge softness", 0, 1, 0.2, 0.05, 2),
						   fxNum("smoothing", "Steadiness", 0, 0.95, 0.4, 0.05, 2),
						   fxNum("strength", "Blur strength (blur mode)", 1, 100, 20, 1, 1),
						   fxCol("color", "Colour (replace mode)", "#00b140")}, "camera"},
		{"autoFrame", "Follow face", {fxNum("zoom", "Zoom", 1, 4, 1.6, 0.1, 2), fxNum("smoothing", "Smoothing (s)", 0, 5, 0.5, 0.1, 2),
					      fxNum("deadzone", "Dead zone", 0, 0.5, 0.1, 0.01, 2)}, "camera"},
	};
	return t;
}

const FxType *fxType(const QString &type)
{
	for (const auto &t : fxTypes())
		if (type == QLatin1String(t.type))
			return &t;
	return nullptr;
}

QJsonObject fxDefault(const FxType &t)
{
	QJsonObject o;
	o.insert(QStringLiteral("type"), QLatin1String(t.type));
	for (const auto &p : t.params)
		o.insert(QLatin1String(p.key), p.colour ? QJsonValue(QLatin1String(p.cdef)) : QJsonValue(p.def));
	return o;
}

QString fxSummary(const QJsonObject &e)
{
	const QString type = e.value(QStringLiteral("type")).toString();
	const FxType *t = fxType(type);
	if (!t)
		return type + QStringLiteral(" (not editable here)");
	QStringList parts;
	for (const auto &p : t->params) {
		if (parts.size() == 3)
			break;
		const QJsonValue v = e.value(QLatin1String(p.key));
		parts << (p.colour ? v.toString() : QString::number(v.toDouble(), 'g', 4));
	}
	return QStringLiteral("%1  %2").arg(QLatin1String(t->label), parts.join(QStringLiteral(", ")));
}
QJsonArray unwrap(const QJsonObject &body, const char *key)
{
	const QJsonValue r = body.value(QStringLiteral("result"));
	if (r.isArray())
		return r.toArray();
	return r.toObject().value(QLatin1String(key)).toArray();
}

QStringList canvasesOf(const QJsonObject &s)
{
	QStringList out;
	const QJsonValue cs = s.value(QStringLiteral("canvases"));
	if (cs.isArray())
		for (const auto &c : cs.toArray())
			out << c.toString().toLower();
	else if (s.contains(QStringLiteral("canvas")))
		out << s.value(QStringLiteral("canvas")).toString().toLower();
	return out;
}

QLabel *pill(const QString &text)
{
	auto *l = new QLabel(text);
	l->setObjectName(QStringLiteral("pill"));
	l->setMargin(4);
	l->setFrameShape(QFrame::StyledPanel);
	return l;
}

int meterValue(const QJsonValue &peak)
{
	if (!peak.isDouble())
		return 0;
	return std::max(0, std::min(100, (int)std::lround((peak.toDouble() + 60.0) / 60.0 * 100.0)));
}
// Small upper-case caption with a little letter spacing (the reference's section labels).
QLabel *captionLabel(const QString &text, QWidget *parent)
{
	auto *l = new QLabel(text.toUpper(), parent);
	l->setObjectName(QStringLiteral("heading"));
	QFont f = l->font();
	f.setLetterSpacing(QFont::AbsoluteSpacing, 1.0);
	l->setFont(f);
	return l;
}

// The Look panel's view of fxTypes() (D290): one entry per effect type, so a type added to the table above shows up
// in the panel with no further code.
QList<LookType> lookTypes()
{
	QList<LookType> out;
	for (const auto &t : fxTypes()) {
		LookType lt;
		lt.type = QLatin1String(t.type);
		lt.label = QLatin1String(t.label);
		lt.group = QLatin1String(t.group);
		for (const auto &p : t.params) {
			LookParam lp;
			lp.key = QLatin1String(p.key);
			lp.label = QLatin1String(p.label);
			lp.colour = p.colour;
			lp.lo = p.lo;
			lp.hi = p.hi;
			lp.def = p.def;
			lp.step = p.step > 0 ? p.step : 1;
			lp.dec = p.dec;
			lp.cdef = QLatin1String(p.cdef);
			lt.params.append(lp);
		}
		out.append(lt);
	}
	return out;
}

// Scene list as cards (D290): a rounded card per scene, the name in bold, a small caption under it (canvases, active).
// Item data: UserRole = id, UserRole + 1 = caption, UserRole + 2 = active.
class SceneCardDelegate : public QStyledItemDelegate {
public:
	using QStyledItemDelegate::QStyledItemDelegate;
	QSize sizeHint(const QStyleOptionViewItem &, const QModelIndex &) const override { return QSize(100, 58); }
	void paint(QPainter *p, const QStyleOptionViewItem &o, const QModelIndex &i) const override
	{
		p->save();
		p->setRenderHint(QPainter::Antialiasing, true);
		const bool active = i.data(Qt::UserRole + 2).toBool();
		const bool sel = o.state & QStyle::State_Selected, hover = o.state & QStyle::State_MouseOver;
		const QRectF r = QRectF(o.rect).adjusted(2, 3, -2, -3);
		QColor fill(theme::color(QStringLiteral("field")));
		if (hover || sel)
			fill = motion::mix(fill, theme::color(QStringLiteral("accent")), sel ? 0.22 : 0.08);
		p->setBrush(fill);
		p->setPen(QPen(theme::color(active ? QStringLiteral("accent") : QStringLiteral("border")), active ? 1.6 : 1.0));
		p->drawRoundedRect(r, 12, 12);
		if (active) { // a small accent bar on the left edge
			p->setPen(Qt::NoPen);
			p->setBrush(theme::color(QStringLiteral("accent")));
			p->drawRoundedRect(QRectF(r.left() + 8, r.top() + 12, 4, r.height() - 24), 2, 2);
		}
		QFont f = o.font;
		f.setBold(true);
		f.setPointSizeF(12.5);
		p->setFont(f);
		p->setPen(theme::color(QStringLiteral("text")));
		const QRectF text = r.adjusted(active ? 22 : 16, 8, -12, -8);
		p->drawText(QRectF(text.left(), text.top(), text.width(), 22), Qt::AlignVCenter | Qt::AlignLeft, p->fontMetrics().elidedText(i.data(Qt::DisplayRole).toString(), Qt::ElideRight, (int)text.width()));
		QFont c = o.font;
		c.setPointSizeF(8);
		c.setLetterSpacing(QFont::AbsoluteSpacing, 0.8);
		p->setFont(c);
		p->setPen(theme::color(active ? QStringLiteral("accentHi") : QStringLiteral("muted")));
		p->drawText(QRectF(text.left(), text.top() + 22, text.width(), 16), Qt::AlignVCenter | Qt::AlignLeft, i.data(Qt::UserRole + 1).toString());
		p->restore();
	}
};

} // namespace

PreviewSlot::PreviewSlot(ApiClient *api, QString canvas, QWidget *parent)
	: QWidget(parent), api_(api), canvas_(std::move(canvas)), debounce_(new QTimer(this)), msg_(new QLabel(this))
{
	setAttribute(Qt::WA_NativeWindow, true); // a real window handle for the host's child window
	setAutoFillBackground(true);
	QPalette pal = palette();
	pal.setColor(QPalette::Window, QColor(10, 9, 14));
	pal.setColor(QPalette::WindowText, QColor(200, 200, 200));
	setPalette(pal);
	auto *l = new QVBoxLayout(this);
	// The preview surface stays dark in every theme, so its message keeps a fixed light colour (not a theme token).
	msg_->setStyleSheet(QStringLiteral("QLabel { color: #c8c8c8; background: transparent; }"));
	msg_->setAlignment(Qt::AlignCenter);
	msg_->setWordWrap(true);
	l->addWidget(msg_);
	setMessage(QStringLiteral("Preview loading..."));
	debounce_->setSingleShot(true);
	debounce_->setInterval(150);
	connect(debounce_, &QTimer::timeout, this, &PreviewSlot::embed);
}

void PreviewSlot::setMessage(const QString &text)
{
	msg_->setText(text);
}

QString PreviewSlot::message() const
{
	return msg_->text();
}

// One close for the whole app (D280): closing this window stops Ujwalam (host, previews, services; the launcher
// does that when the window exits with code 0). While live it stops every stream and the recording, so it needs the
// typed "yes, on air" first; anything else keeps the window open.
void MainWindow::closeEvent(QCloseEvent *e)
{
	if (live_) {
		bool ok = false;
		const QString typed = QInputDialog::getText(this, QStringLiteral("Close Ujwalam"),
							    QStringLiteral("You are live. Closing Ujwalam stops every stream and the recording.\n\nType: yes, on air"),
							    QLineEdit::Normal, QString(), &ok);
		if (!ok || typed.trimmed() != QStringLiteral("yes, on air")) {
			note(QStringLiteral("Still live: Ujwalam was not closed."));
			return e->ignore();
		}
	}
	// Tasks still running or waiting (user 2026-11-09, D311 proposed): nothing may go on unseen after the window is
	// gone, so the user picks: keep them in the tray (icon, progress, time left), stop them now, or keep the window.
	const int n = tasks_ ? tasks_->active() : 0;
	if (n > 0 && !live_) {
		QStringList names;
		for (const QJsonValue &v : tasks_->tasks()) {
			const QJsonObject t = v.toObject();
			const QString st = t.value(QStringLiteral("state")).toString();
			if (st == QStringLiteral("running") || st == QStringLiteral("waiting"))
				names << QStringLiteral("- %1 (%2)").arg(t.value(QStringLiteral("title")).toString(), tasktime::text(t));
		}
		QMessageBox box(this);
		box.setObjectName(QStringLiteral("closeTasks"));
		box.setIcon(QMessageBox::Question);
		box.setWindowTitle(QStringLiteral("Close Ujwalam"));
		closeAsked_ = QStringLiteral("%1 task%2 still running:\n%3\n\nWhat should happen to %4?")
				      .arg(n)
				      .arg(n == 1 ? QStringLiteral(" is") : QStringLiteral("s are"))
				      .arg(names.mid(0, 8).join(QLatin1Char('\n')))
				      .arg(n == 1 ? QStringLiteral("it") : QStringLiteral("them"));
		box.setText(closeAsked_);
		QPushButton *keep = box.addButton(QStringLiteral("Keep running in the tray"), QMessageBox::AcceptRole);
		QPushButton *stop = box.addButton(QStringLiteral("Stop them and close"), QMessageBox::DestructiveRole);
		QPushButton *cancel = box.addButton(QStringLiteral("Do not close"), QMessageBox::RejectRole);
		keep->setObjectName(QStringLiteral("closeTray"));
		stop->setObjectName(QStringLiteral("closeStop"));
		cancel->setObjectName(QStringLiteral("closeCancel"));
		box.setDefaultButton(keep);
		box.setEscapeButton(cancel);
		box.exec();
		if (box.clickedButton() == keep) {
			closeChoice_ = QStringLiteral("tray");
			e->ignore();
			QTimer::singleShot(0, this, &MainWindow::enterTray);
			return;
		}
		if (box.clickedButton() != stop) {
			closeChoice_ = QStringLiteral("cancel");
			note(QStringLiteral("Ujwalam was not closed; the tasks keep running."));
			return e->ignore();
		}
		closeChoice_ = QStringLiteral("stop");
		// Stop: the window ends with exit 0 and the launcher ends every task's whole process tree (python, ffmpeg).
		std::printf("studio close: stop tasks (%d)\n", n);
		std::fflush(stdout);
	}
	if (tray_ && tray_->active())
		tray_->end();
	e->accept();
}

// Keep running in the tray (D311 proposed): the window hides (its previews with it), the polls go on, the tray shows
// the tasks. The app no longer quits on the last window; it ends when the tasks finish or on Stop all.
void MainWindow::enterTray()
{
	QApplication::setQuitOnLastWindowClosed(false);
	hide();
	tray_->begin(tasks_->tasks());
	std::printf("studio tray: on (%d task(s))\n", tasks_->active());
	std::fflush(stdout);
}

void MainWindow::leaveTray()
{
	tray_->end();
	QApplication::setQuitOnLastWindowClosed(true);
	if (qEnvironmentVariable("UJWALAM_HEADLESS") != QStringLiteral("1")) { // the user asked for it: a normal show (D316)
		show();
		raise();
		activateWindow();
	}
	std::printf("studio tray: off (window open again)\n");
	std::fflush(stdout);
}

// Stop all from the tray: asked first on a real click (a long clip job is not ended by a slip of the mouse).
void MainWindow::stopAllFromTray(bool ask)
{
	if (ask && QMessageBox::question(nullptr, QStringLiteral("Stop all"),
					  QStringLiteral("Stop every running task and quit Ujwalam?\nUnfinished clip jobs run again at the next start.")) != QMessageBox::Yes)
		return;
	requestQuit([this](bool can, const QString &why, const QString &token) {
		if (can) {
			commitQuit(token, []() {
				std::printf("studio tray: stop all\n");
				std::fflush(stdout);
				QApplication::exit(0); // the launcher ends every task's whole process tree
			}, [this]() { note(QStringLiteral("Ujwalam did not close: the quit was no longer confirmed. Try Stop all again.")); });
			return;
		}
		// Live, recording or unknown: quitting would stop them. Stop the tasks only; the studio and host stay, and the
		// tray ends when the stopped tasks show as ended (allFinished, checked again).
		trayStay_ = why;
		std::printf("studio tray: stop tasks only (%s)\n", qUtf8Printable(why));
		std::fflush(stdout);
		api_->post(QStringLiteral("ui/api/tasks/stop"), {}, [this](bool ok, const QJsonObject &, const QString &err) {
			if (!ok)
				note(QStringLiteral("Could not stop the tasks: ") + err);
		});
	});
}

// Stop from the task panel (2026-11-10): the background jobs end (clip making, uploads; the same route as the tray's
// Stop all while live), the studio and host stay. Asked first on a real click.
void MainWindow::stopTasks(bool ask)
{
	if (ask && QMessageBox::question(this, QStringLiteral("Stop tasks"),
					  QStringLiteral("Stop the background jobs (clip making and uploads)?\nUnfinished clip jobs run again at the next start.")) !=
			   QMessageBox::Yes)
		return;
	taskStops_++;
	api_->post(QStringLiteral("ui/api/tasks/stop"), {}, [this](bool ok, const QJsonObject &, const QString &err) {
		note(ok ? QStringLiteral("Stopping the background jobs...") : QStringLiteral("Could not stop the tasks: ") + err);
	});
}

void MainWindow::requestQuit(std::function<void(bool, const QString &, const QString &)> then)
{
	api_->post(QStringLiteral("ui/api/quit/begin"), {}, [then](bool ok, const QJsonObject &r, const QString &) {
		const bool granted = ok && r.value(QStringLiteral("granted")).toBool(false) && r.value(QStringLiteral("token")).isString();
		if (granted)
			return then(true, QString(), r.value(QStringLiteral("token")).toString());
		const QString why = ok ? r.value(QStringLiteral("reason")).toString() : QString();
		then(false, why.isEmpty() ? QStringLiteral("unreadable") : why, QString());
	});
}

void MainWindow::commitQuit(const QString &token, std::function<void()> exitNow, std::function<void()> stay)
{
	api_->post(QStringLiteral("ui/api/quit/commit"), QJsonObject{{QStringLiteral("token"), token}},
		   [this, token, exitNow, stay](bool ok, const QJsonObject &r, const QString &) {
			   if (ok && r.value(QStringLiteral("ok")).toBool(false))
				   return exitNow();
			   releaseQuit(token);
			   std::printf("studio tray: quit not confirmed; staying open\n");
			   std::fflush(stdout);
			   stay();
		   });
}

void MainWindow::releaseQuit(const QString &token)
{
	if (!token.isEmpty())
		api_->post(QStringLiteral("ui/api/quit/cancel"), QJsonObject{{QStringLiteral("token"), token}}, [](bool, const QJsonObject &, const QString &) {});
}

void PreviewSlot::schedule()
{
	debounce_->start();
}

void PreviewSlot::resizeEvent(QResizeEvent *e)
{
	QWidget::resizeEvent(e);
	schedule();
}

void PreviewSlot::showEvent(QShowEvent *e)
{
	QWidget::showEvent(e);
	debounce_->start();
}

void PreviewSlot::embed()
{
	if (busy_) {
		again_ = true;
		return;
	}
	const qreal dpr = devicePixelRatioF();
	const int w = (int)std::lround(width() * dpr), h = (int)std::lround(height() * dpr);
	if (w < 160 || h < 90)
		return setMessage(QStringLiteral("Make this area larger to show the preview."));
	QJsonObject p;
	p.insert(QStringLiteral("canvas"), canvas_);
	p.insert(QStringLiteral("parent"), QString::number((qulonglong)winId()));
	p.insert(QStringLiteral("x"), 0);
	p.insert(QStringLiteral("y"), 0);
	p.insert(QStringLiteral("width"), w);
	p.insert(QStringLiteral("height"), h);
	busy_ = true;
	api_->host(QStringLiteral("preview.open"), p, [this](bool ok, const QJsonObject &b, const QString &err) {
		busy_ = false;
		if (!ok) {
			const QString detail = b.value(QStringLiteral("detail")).toString();
			setMessage(QStringLiteral("No preview here: ") + (detail.isEmpty() ? err : detail));
			// The host may still be starting or loading the project (no canvas yet): try again (D280).
			if (!again_ && isVisible())
				QTimer::singleShot(2000, this, [this]() { schedule(); });
		} else
			setMessage(QString());
		if (again_) {
			again_ = false;
			embed();
		}
	});
}

MainWindow::MainWindow(ApiClient *api, QWidget *parent) : QMainWindow(parent), api_(api)
{
	setWindowTitle(QStringLiteral("Ujwalam Studio"));
	auto *central = new QWidget(this);
	auto *outer = new QVBoxLayout(central);
	outer->setContentsMargins(6, 6, 6, 6);
	outer->addWidget(buildTop());
	// Live alerts (flag live-test-kit, D305 proposed): plain-words lines from the status snapshot ("alerts"): a sound
	// source that stopped, a stream restarted (or not) after a host crash, the Streamer.bot test-action reminder, the
	// viewer feedback result. Hidden while there is nothing to say. Text only (Qt::PlainText): nothing in it is markup.
	alertBar_ = new QLabel(central);
	alertBar_->setObjectName(QStringLiteral("alertBar"));
	alertBar_->setTextFormat(Qt::PlainText);
	alertBar_->setWordWrap(true);
	alertBar_->setContentsMargins(10, 6, 10, 6);
	alertBar_->hide();
	outer->addWidget(alertBar_);
	auto *split = new QSplitter(Qt::Horizontal, central);
	split->addWidget(buildLeft());
	auto *mid = new QSplitter(Qt::Vertical, split); // previews over the mixer strip (D285)
	mid->addWidget(buildCentre());
	mid->addWidget(buildMixer());
	mid->setStretchFactor(0, 1);
	mid->setStretchFactor(1, 0);
	mid->setSizes({620, 200});
	split->addWidget(mid);
	split->addWidget(buildRight());
	split->setStretchFactor(0, 0);
	split->setStretchFactor(1, 1);
	split->setStretchFactor(2, 0);
	split->setSizes({260, 780, 380});
	outer->addWidget(split, 1);
	setCentralWidget(central);
	note_ = new QLabel(this);
	statusBar()->addWidget(note_, 1);
	tasks_ = new TaskBar(this);
	// The task button sits in the top bar at the right, before My clips (user 2026-11-10: the status-bar strip was hard
	// to see); its panel and the notifications open under it. Hidden while no task is listed.
	if (QWidget *topBar = clipsFolderBtn_->parentWidget())
		if (auto *row = qobject_cast<QHBoxLayout *>(topBar->layout())) {
			row->insertWidget(row->indexOf(clipsFolderBtn_), tasks_->chip());
			row->insertSpacing(row->indexOf(clipsFolderBtn_), 6);
		}
	connect(tasks_, &TaskBar::stopRequested, this, [this](const QString &) { stopTasks(true); });
	{
		// Tray icon (D311 proposed): the app icon main() set from the embedded PNGs (res/png, no imageformats plugin
		// needed), else a standard one.
		QIcon ico = QApplication::windowIcon();
		if (ico.isNull())
			ico = style()->standardIcon(QStyle::SP_ComputerIcon);
		tray_ = new TrayKeeper(ico, this);
		connect(tray_, &TrayKeeper::openRequested, this, &MainWindow::leaveTray);
		connect(tray_, &TrayKeeper::stopAllRequested, this, [this]() { stopAllFromTray(true); });
		connect(tray_, &TrayKeeper::allFinished, this, [this](int countdown) {
			// Exit 0 makes the launcher stop the host: never while a stream or recording runs (it may have been started
			// from the control page while the window was in the tray). Then the window comes back instead.
			requestQuit([this, countdown](bool can, const QString &why, const QString &token) {
				// The request took a while: a task may have started (the countdown was cancelled) or the window come
				// back. Then nothing exits, and a granted lock is released so going live is not blocked.
				if (!tray_->stillFinished(countdown)) {
					releaseQuit(token);
					std::printf("studio tray: not quitting (a task started or the window came back meanwhile)\n");
					std::fflush(stdout);
					return;
				}
				if (!can) {
					trayStay_ = why;
					std::printf("studio tray: all tasks finished; staying open (%s)\n", qUtf8Printable(why));
					std::fflush(stdout);
					note(QStringLiteral("All tasks finished. Ujwalam stays open: %1.").arg(why == QStringLiteral("unreadable") ? QStringLiteral("could not confirm that nothing is live") : why));
					return leaveTray();
				}
				commitQuit(token, [this]() {
					std::printf("studio tray: all tasks finished; exiting\n");
					std::printf("studio tray probe: %s\n", QJsonDocument(tray_->probe()).toJson(QJsonDocument::Compact).constData());
					std::fflush(stdout);
					QApplication::exit(0); // exit 0: the launcher stops everything else (D280)
				}, [this]() {
					trayStay_ = QStringLiteral("not-confirmed");
					leaveTray();
				});
			});
		});
	}
	resize(1400, 860);
	// Tips and tour (D294 proposed): the parts of the window they point at, by name (data/guide/*.json).
	guide_ = new Guide(this, api_);
	QWidget *mixW = mixerBox_->parentWidget();
	while (mixW && !qobject_cast<QGroupBox *>(mixW))
		mixW = mixW->parentWidget();
	guide_->anchor(QStringLiteral("scenes"), {sceneList_});
	guide_->anchor(QStringLiteral("layers"), {layerList_});
	guide_->anchor(QStringLiteral("sceneAdd"), {addSceneBtn_});
	guide_->anchor(QStringLiteral("layerAdd"), {addLayerBtn_});
	guide_->anchor(QStringLiteral("previewH"), {slots_.value(0) ? slots_.value(0)->parentWidget() : nullptr});
	guide_->anchor(QStringLiteral("previewV"), {slots_.value(1) ? slots_.value(1)->parentWidget() : nullptr});
	guide_->anchor(QStringLiteral("look"), {look_});
	guide_->anchor(QStringLiteral("mixer"), {mixW});
	guide_->anchor(QStringLiteral("ctlStream"), {streamBtn_->parentWidget()});
	guide_->anchor(QStringLiteral("ctlRecord"), {recordBtn_->parentWidget()});
	guide_->anchor(QStringLiteral("ctlClip"), {clipBtn_->parentWidget()});
	guide_->anchor(QStringLiteral("ctlMark"), {markBtn_->parentWidget()});
	guide_->anchor(QStringLiteral("chips"), {pillLive_, pillRec_, pillClips_});
	guide_->anchor(QStringLiteral("chipClips"), {pillClips_});
	guide_->anchor(QStringLiteral("taskChip"), {tasks_->chip()});
	guide_->anchor(QStringLiteral("myClips"), {clipsFolderBtn_});
	guide_->anchor(QStringLiteral("settings"), {settingsBtn_});
	guide_->anchor(QStringLiteral("more"), {moreBtn_});
	guide_->attachHelpButton(helpBtn_);
}

// Slim top toolbar (D290, after the reference): icon + short label buttons on the left, state chips and the
// settings tools on the right. The four things you use while recording or streaming are round buttons in the
// "Controls" card (buildControls) at the bottom of the right column.
QWidget *MainWindow::buildTop()
{
	auto *w = new QWidget(this);
	auto *h = new QHBoxLayout(w);
	h->setContentsMargins(4, 0, 4, 0);
	h->setSpacing(4);
	const QColor ink(theme::color(QStringLiteral("text")));
	auto *brand = new QLabel(QStringLiteral("Ujwalam"), w);
	brand->setObjectName(QStringLiteral("brand"));
	h->addWidget(brand);
	h->addSpacing(18);
	auto tool = [&](const QString &icon, const QString &text, const QString &tip) {
		auto *b = new QPushButton(icons::make(icon, ink, 18), text, w);
		b->setObjectName(QStringLiteral("tb"));
		b->setProperty("themeIcon", icon + QStringLiteral(":18")); // drawn again when the theme changes (theme.cpp)
		b->setToolTip(tip);
		b->setFlat(true);
		b->setCursor(Qt::PointingHandCursor);
		return b;
	};
	// Undo / redo of layer edits (D238; inspector, layer list, preview mouse, effects): Ctrl+Z / Ctrl+Y too.
	undoBtn_ = tool(QStringLiteral("undo"), QStringLiteral("Undo"), QString());
	redoBtn_ = tool(QStringLiteral("redo"), QStringLiteral("Redo"), QString());
	undoBtn_->setEnabled(false);
	redoBtn_->setEnabled(false);
	connect(undoBtn_, &QPushButton::clicked, this, [this]() { undoRedo(true); });
	connect(redoBtn_, &QPushButton::clicked, this, [this]() { undoRedo(false); });
	h->addWidget(undoBtn_);
	h->addWidget(redoBtn_);
	h->addStretch(1);

	pillLive_ = pill(QStringLiteral("Offline"));
	pillRec_ = pill(QStringLiteral("Not recording"));
	pillStats_ = pill(QStringLiteral("-"));
	pillHost_ = pill(QStringLiteral("Host: ?"));
	pillCore_ = pill(QStringLiteral("Event core: ?"));
	pillClips_ = pill(QStringLiteral("Clips: off")); // clips from finished recordings (D283)
	for (QLabel *p : {pillLive_, pillRec_, pillClips_})
		h->addWidget(p);
	h->addSpacing(12);
	clipsFolderBtn_ = tool(QStringLiteral("folder"), QStringLiteral("My clips"), QStringLiteral("Open the folder with your finished clips."));
	connect(clipsFolderBtn_, &QPushButton::clicked, this, [this]() {
		api_->post(QStringLiteral("ui/api/clips/open"), {}, [this](bool ok, const QJsonObject &, const QString &err) {
			if (!ok)
				note(QStringLiteral("Could not open the clips folder: ") + err);
		});
	});
	settingsBtn_ = tool(QStringLiteral("gear"), QStringLiteral("Settings"), QStringLiteral("Clips, folders, layer effects and advanced options."));
	connect(settingsBtn_, &QPushButton::clicked, this, [this]() { openSettings(false); });
	h->addWidget(clipsFolderBtn_);
	h->addWidget(settingsBtn_);
	auto *more = new QToolButton(w);
	more->setObjectName(QStringLiteral("tb"));
	more->setIcon(icons::make(QStringLiteral("more"), ink, 18));
	more->setProperty("themeIcon", QStringLiteral("more:18"));
	more->setText(QStringLiteral("More"));
	more->setPopupMode(QToolButton::InstantPopup);
	more->setToolButtonStyle(Qt::ToolButtonTextBesideIcon);
	more->setCursor(Qt::PointingHandCursor);
	auto *menu = new QMenu(more);
	auto *imAct = menu->addAction(QStringLiteral("Import Meld session..."), this, &MainWindow::openImport);
	imAct->setToolTip(QStringLiteral("Make a new project file from the Meld session, check it against the host, then load it."));
	auto *fbAct = menu->addAction(QStringLiteral("Feedback notes..."), this, &MainWindow::openFeedback);
	fbAct->setToolTip(QStringLiteral("Add a note to each feedback moment (feedback hotkey while streaming)."));
	postsAct_ = menu->addAction(QStringLiteral("Posts..."), this, &MainWindow::openPosts);
	postsAct_->setToolTip(QStringLiteral("Review clip packages. Nothing is uploaded without a typed confirmation."));
	postsAct_->setVisible(false);
	reportAct_ = menu->addAction(QStringLiteral("Report a problem..."), this, &MainWindow::report);
	reportAct_->setToolTip(QStringLiteral("Opens a prefilled GitHub issue in your browser; you review it before submitting."));
	reportAct_->setVisible(false);
	menu->setToolTipsVisible(true);
	more->setMenu(menu);
	h->addWidget(more);
	moreBtn_ = more;
	helpBtn_ = new QPushButton(QStringLiteral("?"), w); // floating help and tips (guide.*)
	helpBtn_->setObjectName(QStringLiteral("tb"));
	helpBtn_->setToolTip(QStringLiteral("Help: how clips are made, how posting works, and the welcome tour."));
	helpBtn_->setFlat(true);
	helpBtn_->setCursor(Qt::PointingHandCursor);
	helpBtn_->setFixedWidth(34);
	h->addWidget(helpBtn_);
	pillStats_->setParent(this); // the numbers live in the stats cards now (D287)
	pillStats_->hide();
	statusBar()->addPermanentWidget(pillHost_);
	statusBar()->addPermanentWidget(pillCore_);
	return w;
}

// One round control: an icon in a circle, its caption under it (the caption follows setControl).
QPushButton *MainWindow::roundButton(QWidget *parent, const QString &icon, const QString &caption, const QString &tip, const QString &role, QLayout *into)
{
	auto *cell = new QWidget(parent);
	auto *v = new QVBoxLayout(cell);
	v->setContentsMargins(0, 0, 0, 0);
	v->setSpacing(6);
	auto *b = new QPushButton(cell);
	b->setObjectName(QStringLiteral("round"));
	b->setFixedSize(52, 52);
	b->setIconSize(QSize(24, 24));
	b->setCursor(Qt::PointingHandCursor);
	if (!role.isEmpty())
		b->setProperty("role", role);
	auto *cap = new QLabel(caption, cell);
	cap->setObjectName(QStringLiteral("ctlCaption"));
	cap->setAlignment(Qt::AlignCenter);
	cap->setWordWrap(true);
	b->setProperty("captionLabel", QVariant::fromValue<QObject *>(cap));
	b->setToolTip(tip);
	v->addWidget(b, 0, Qt::AlignHCenter);
	v->addWidget(cap);
	into->addWidget(cell);
	setControl(b, icon, caption);
	return b;
}

// Icon and caption of a round control (they change with the state: Start stream / Stop stream).
void MainWindow::setControl(QPushButton *b, const QString &icon, const QString &caption)
{
	const bool danger = b->property("role").toString() == QStringLiteral("danger");
	const bool primary = b->property("role").toString() == QStringLiteral("primary");
	const bool active = b->property("active").toBool();
	const QString state = icon + (active ? QStringLiteral("+") : QStringLiteral("-"));
	if (b->property("iconState").toString() == state && b->accessibleName() == caption)
		return; // nothing changed: no new picture every status poll
	const QColor ink = (primary || (danger && active)) ? theme::color(QStringLiteral("onAccent")) : danger ? theme::color(QStringLiteral("danger")) : theme::color(QStringLiteral("text"));
	b->setIcon(icons::make(icon, ink, 24, theme::color(QStringLiteral("muted")))); // disabled: muted on the field face (>= 3:1, tested)
	b->setProperty("iconState", state);
	b->setAccessibleName(caption);
	if (auto *cap = qobject_cast<QLabel *>(b->property("captionLabel").value<QObject *>()))
		cap->setText(caption);
}

// The four controls (D290, the reference's Controls block). Stream and record changes come back as a typed
// confirmation, as before; Save clip and Mark moment need none.
QWidget *MainWindow::buildControls()
{
	auto *card = new QFrame(this);
	card->setObjectName(QStringLiteral("card"));
	auto *v = new QVBoxLayout(card);
	v->setContentsMargins(14, 12, 14, 12);
	v->setSpacing(10);
	auto *cap = new QLabel(QStringLiteral("CONTROLS"), card);
	cap->setObjectName(QStringLiteral("heading"));
	v->addWidget(cap);
	auto *row = new QHBoxLayout();
	row->setSpacing(4);
	streamBtn_ = roundButton(card, QStringLiteral("play"), QStringLiteral("Start stream"), QString(), QStringLiteral("primary"), row);
	recordBtn_ = roundButton(card, QStringLiteral("record"), QStringLiteral("Record"), QString(), QStringLiteral("danger"), row);
	// Clipping (D281): save the replay buffer (last 60 s of H and V) now; mark a moment for the post-stream clipper.
	clipBtn_ = roundButton(card, QStringLiteral("clip"), QStringLiteral("Save clip"), QStringLiteral("Save the last 60 seconds of H and V as clip files (replay buffer)."), QString(), row);
	markBtn_ = roundButton(card, QStringLiteral("flag"), QStringLiteral("Mark moment"), QStringLiteral("Mark this moment for the clipper (same as the marker hotkey, Ctrl+Alt+Shift+M by default)."), QString(), row);
	v->addLayout(row);
	streamBtn_->setEnabled(false);
	recordBtn_->setEnabled(false);
	connect(streamBtn_, &QPushButton::clicked, this, [this]() { hostAction(live_ ? QStringLiteral("stream.stop") : QStringLiteral("stream.start")); });
	connect(recordBtn_, &QPushButton::clicked, this, [this]() { hostAction(recording_ ? QStringLiteral("record.stop") : QStringLiteral("record.start")); });
	connect(clipBtn_, &QPushButton::clicked, this, [this]() {
		api_->host(QStringLiteral("replay.save"), {}, [this](bool ok, const QJsonObject &b, const QString &err) {
			if (!ok)
				return note(QStringLiteral("Clip not saved: ") + err);
			const int n = b.value(QStringLiteral("result")).toObject().value(QStringLiteral("saved")).toArray().size();
			note(n ? QStringLiteral("Clip saved: %1 file(s) in the replay folder.").arg(n) : QStringLiteral("Clip not saved: the replay buffer is not running."));
		});
	});
	connect(markBtn_, &QPushButton::clicked, this, [this]() {
		QJsonObject p;
		p.insert(QStringLiteral("source"), QStringLiteral("api"));
		api_->host(QStringLiteral("marker.add"), p, [this](bool ok, const QJsonObject &, const QString &err) {
			note(ok ? QStringLiteral("Moment marked.") : QStringLiteral("Moment not marked: ") + err);
		});
	});
	return card;
}

QWidget *MainWindow::buildLeft()
{
	auto *w = new QWidget(this);
	auto *v = new QVBoxLayout(w);
	v->setContentsMargins(0, 0, 0, 0);
	v->setSpacing(8);
	auto *shdr = new QHBoxLayout();
	shdr->addWidget(captionLabel(QStringLiteral("Scenes"), w));
	shdr->addStretch(1);
	addSceneBtn_ = new QToolButton(w);
	addSceneBtn_->setObjectName(QStringLiteral("addMini"));
	const auto plusScene = [btn = addSceneBtn_]() { btn->setIcon(icons::make(QStringLiteral("plus"), theme::color(QStringLiteral("text")), 14)); };
	plusScene();
	connect(theme::notifier(), &theme::Notifier::changed, addSceneBtn_, plusScene);
	addSceneBtn_->setIconSize(QSize(14, 14));
	addSceneBtn_->setStyleSheet(QStringLiteral("QToolButton { padding: 0; }")); // the app style's side padding would squeeze the icon to a dot
	addSceneBtn_->setAccessibleName(QStringLiteral("Add scene"));
	addSceneBtn_->setAutoRaise(false);
	addSceneBtn_->setFixedSize(28, 24);
	addui::polish(addSceneBtn_);
	connect(addSceneBtn_, &QToolButton::clicked, this, [this]() { openAddScene(); });
	shdr->addWidget(addSceneBtn_);
	v->addLayout(shdr);
	sceneList_ = new QListWidget(w);
	sceneList_->setObjectName(QStringLiteral("sceneCards"));
	sceneList_->setItemDelegate(new SceneCardDelegate(sceneList_));
	sceneList_->setMouseTracking(true);
	sceneList_->setFrameShape(QFrame::NoFrame);
	sceneList_->setVerticalScrollMode(QAbstractItemView::ScrollPerPixel);
	sceneList_->setMaximumHeight(240);
	sceneList_->setToolTip(QStringLiteral("Double-click a scene to switch to it."));
	connect(sceneList_, &QListWidget::itemActivated, this, [this](QListWidgetItem *it) {
		const QString id = it->data(Qt::UserRole).toString();
		QJsonObject p;
		p.insert(QStringLiteral("scene"), id);
		api_->host(QStringLiteral("scenes.activate"), p, [this, id](bool ok, const QJsonObject &, const QString &err) {
			if (!ok)
				return note(QStringLiteral("Scene switch failed: ") + err);
			activeScene_ = id;
			loadScenes();
		});
	});
	sceneList_->setContextMenuPolicy(Qt::CustomContextMenu);
	connect(sceneList_, &QWidget::customContextMenuRequested, this, &MainWindow::showSceneMenu);
	{
		auto sceneKey = [this](const QKeySequence &k, std::function<void(const QString &)> fn) {
			auto *sc = new QShortcut(k, sceneList_);
			sc->setContext(Qt::WidgetShortcut);
			connect(sc, &QShortcut::activated, this, [this, fn]() { fn(sceneKeyId()); });
		};
		sceneKey(QKeySequence(Qt::Key_F2), [this](const QString &id) { sceneRename(id); });
		sceneKey(QKeySequence(Qt::Key_Delete), [this](const QString &id) { sceneDelete(id); });
	}
	v->addWidget(sceneList_);

	auto *hdr = new QHBoxLayout();
	hdr->addWidget(captionLabel(QStringLiteral("Layers"), w));
	hdr->addStretch(1);
	addLayerBtn_ = new QToolButton(w);
	addLayerBtn_->setObjectName(QStringLiteral("addMini"));
	const auto plusLayer = [btn = addLayerBtn_]() { btn->setIcon(icons::make(QStringLiteral("plus"), theme::color(QStringLiteral("text")), 14)); };
	plusLayer();
	connect(theme::notifier(), &theme::Notifier::changed, addLayerBtn_, plusLayer);
	addLayerBtn_->setIconSize(QSize(14, 14));
	addLayerBtn_->setStyleSheet(QStringLiteral("QToolButton { padding: 0; }")); // the app style's side padding would squeeze the icon to a dot
	addLayerBtn_->setAccessibleName(QStringLiteral("Add layer"));
	addLayerBtn_->setAutoRaise(false);
	addLayerBtn_->setFixedSize(28, 24);
	addui::polish(addLayerBtn_);
	connect(addLayerBtn_, &QToolButton::clicked, this, [this]() { openAddLayer(); });
	hdr->addWidget(addLayerBtn_);
	delLayerBtn_ = new QToolButton(w); // D330: delete in plain sight (it was only in the menu, behind a flag)
	delLayerBtn_->setObjectName(QStringLiteral("addMini"));
	const auto binIcon = [btn = delLayerBtn_]() { btn->setIcon(icons::make(QStringLiteral("trash"), theme::color(QStringLiteral("text")), 14)); };
	binIcon();
	connect(theme::notifier(), &theme::Notifier::changed, delLayerBtn_, binIcon);
	delLayerBtn_->setIconSize(QSize(14, 14));
	delLayerBtn_->setStyleSheet(QStringLiteral("QToolButton { padding: 0; }"));
	delLayerBtn_->setAccessibleName(QStringLiteral("Delete layer"));
	delLayerBtn_->setToolTip(QStringLiteral("Delete the selected layer (Del). Asks first."));
	delLayerBtn_->setFixedSize(28, 24);
	addui::polish(delLayerBtn_);
	connect(delLayerBtn_, &QToolButton::clicked, this, [this]() { layerDelete(); });
	hdr->addWidget(delLayerBtn_);
	updateAddButtons();
	tabH_ = new QPushButton(QStringLiteral("H"), w);
	tabV_ = new QPushButton(QStringLiteral("V"), w);
	for (QPushButton *b : {tabH_, tabV_}) {
		b->setCheckable(true);
		b->setMaximumWidth(36);
		hdr->addWidget(b);
	}
	tabH_->setChecked(true);
	connect(tabH_, &QPushButton::clicked, this, [this]() { canvas_ = QStringLiteral("h"); tabV_->setChecked(false); tabH_->setChecked(true); selected_.clear(); loadLayers(); });
	connect(tabV_, &QPushButton::clicked, this, [this]() { canvas_ = QStringLiteral("v"); tabH_->setChecked(false); tabV_->setChecked(true); selected_.clear(); loadLayers(); });
	v->addLayout(hdr);
	auto *dragList = new LayerList(w); // press and drag a row to reorder (D330)
	layerList_ = dragList;
	connect(dragList, &LayerList::moveRequested, this, [this](const QString &id, int to) {
		if (id != selected_)
			return;
		layerMoveTo(layers_.size() - 1 - to); // list rows are top first, host order bottom first
	});
	connect(layerList_, &QListWidget::currentItemChanged, this, [this](QListWidgetItem *it) {
		selected_ = it ? it->data(Qt::UserRole).toString() : QString();
		renderInspector();
	});
	v->addWidget(layerList_, 1);
	// D292: right-click menu and keys on the list (the keys work while the list has focus).
	layerList_->setContextMenuPolicy(Qt::CustomContextMenu);
	connect(layerList_, &QWidget::customContextMenuRequested, this, &MainWindow::showLayerMenu);
	auto layerKey = [this](const QKeySequence &k, std::function<void()> fn) {
		auto *sc = new QShortcut(k, layerList_);
		sc->setContext(Qt::WidgetShortcut);
		connect(sc, &QShortcut::activated, this, [fn]() { fn(); });
	};
	layerKey(QKeySequence(QStringLiteral("Ctrl+D")), [this]() { layerDuplicate(); });
	layerKey(QKeySequence(Qt::Key_F2), [this]() { layerRename(); });
	layerKey(QKeySequence(Qt::Key_Delete), [this]() { layerDelete(); });
	layerKey(QKeySequence(QStringLiteral("Ctrl+Shift+C")), [this]() { lookCopy(); });
	layerKey(QKeySequence(QStringLiteral("Ctrl+Shift+V")), [this]() { lookPaste(); });
	auto *order = new QHBoxLayout();
	auto *up = new QPushButton(QStringLiteral("Move up"), w);
	auto *dn = new QPushButton(QStringLiteral("Move down"), w);
	auto *vis = new QPushButton(QStringLiteral("Show / hide"), w);
	order->addWidget(up);
	order->addWidget(dn);
	order->addWidget(vis);
	auto moveBy = [this](int delta) {
		const int n = layers_.size();
		for (int i = 0; i < n; i++) {
			if (layers_.at(i).toObject().value(QStringLiteral("id")).toString() != selected_)
				continue;
			const int to = i + delta; // host order: bottom first; up = higher index
			if (to < 0 || to >= n)
				return;
			layerMoveTo(to); // saved into the project offline, live-only with "yes, on air" while live (D330)
			return;
		}
	};
	connect(up, &QPushButton::clicked, this, [moveBy]() { moveBy(1); });
	connect(dn, &QPushButton::clicked, this, [moveBy]() { moveBy(-1); });
	connect(vis, &QPushButton::clicked, this, [this]() {
		const QJsonObject l = selectedLayer();
		if (l.isEmpty())
			return;
		QJsonObject x;
		x.insert(QStringLiteral("layer"), selected_);
		x.insert(QStringLiteral("visible"), !l.value(QStringLiteral("visible")).toBool());
		api_->host(QStringLiteral("layers.setVisible"), layerArgs(x), [this](bool ok, const QJsonObject &, const QString &err) {
			if (!ok)
				note(QStringLiteral("Show/hide failed: ") + err);
			loadLayers();
		});
	});
	v->addLayout(order);

	// Structure edits (D240, flag scene-edit): add and remove scenes and layers; the project file is saved too.
	structBox_ = new QGroupBox(QStringLiteral("Edit scenes and layers"), w);
	auto *sv = new QVBoxLayout(structBox_);
	auto *srow = new QHBoxLayout();
	auto *addScene = new QPushButton(QStringLiteral("Add scene"), structBox_);
	auto *rmScene = new QPushButton(QStringLiteral("Remove scene"), structBox_);
	auto *rmLayer = new QPushButton(QStringLiteral("Remove layer"), structBox_);
	srow->addWidget(addScene);
	srow->addWidget(rmScene);
	srow->addWidget(rmLayer);
	sv->addLayout(srow);
	auto *arow = new QHBoxLayout();
	addKind_ = new QComboBox(structBox_);
	for (const auto &k : addui::kLayerKinds)
		addKind_->addItem(QString::fromLatin1(k.label), QString::fromLatin1(k.kind));
	addPick_ = new QComboBox(structBox_);
	addText_ = new QLineEdit(structBox_);
	addText_->setMaxLength(2000);
	auto *addLayer = new QPushButton(QStringLiteral("Add layer"), structBox_);
	arow->addWidget(addKind_);
	arow->addWidget(addPick_, 1);
	arow->addWidget(addText_, 1);
	arow->addWidget(addLayer);
	sv->addLayout(arow);
	auto *browse = new QPushButton(QStringLiteral("Add layer..."), structBox_);
	browse->setToolTip(QStringLiteral("Choose what to add, with a short note on each kind and a searchable list"));
	srow->addWidget(browse);
	connect(browse, &QPushButton::clicked, this, [this]() { openAddLayer(); });
	structBox_->setVisible(false);
	v->addWidget(structBox_);
	connect(addKind_, &QComboBox::currentIndexChanged, this, [this]() { renderAddPick(); });
	connect(addScene, &QPushButton::clicked, this, [this]() {
		bool ok = false;
		const QString name = QInputDialog::getText(this, QStringLiteral("Add scene"), QStringLiteral("Scene name"), QLineEdit::Normal, QString(), &ok).trimmed();
		if (!ok || name.isEmpty())
			return;
		QJsonObject b;
		b.insert(QStringLiteral("op"), QStringLiteral("scene.add"));
		b.insert(QStringLiteral("name"), name.left(120));
		structureEdit(b);
	});
	connect(rmScene, &QPushButton::clicked, this, [this]() {
		QListWidgetItem *it = sceneList_->currentItem();
		if (!it)
			return note(QStringLiteral("Select a scene first."));
		if (QMessageBox::question(this, QStringLiteral("Remove scene"), QStringLiteral("Remove scene \"%1\" and all its layers from the project?").arg(it->text())) != QMessageBox::Yes)
			return;
		QJsonObject b;
		b.insert(QStringLiteral("op"), QStringLiteral("scene.remove"));
		b.insert(QStringLiteral("scene"), it->data(Qt::UserRole).toString());
		structureEdit(b);
	});
	connect(rmLayer, &QPushButton::clicked, this, [this]() {
		const QJsonObject l = selectedLayer();
		if (l.isEmpty())
			return note(QStringLiteral("Select a layer first."));
		if (QMessageBox::question(this, QStringLiteral("Remove layer"), QStringLiteral("Remove layer \"%1\" from this scene on every canvas?").arg(l.value(QStringLiteral("name")).toString(selected_))) != QMessageBox::Yes)
			return;
		QJsonObject b;
		b.insert(QStringLiteral("op"), QStringLiteral("layer.remove"));
		b.insert(QStringLiteral("scene"), activeScene_);
		b.insert(QStringLiteral("layer"), selected_);
		structureEdit(b);
	});
	connect(addLayer, &QPushButton::clicked, this, [this]() {
		QString err;
		const QJsonObject b = addui::layerAddBody(activeScene_, addKind_->currentData().toString(), addPick_->currentData().toString(), addText_->text(), err);
		if (!err.isEmpty())
			return note(err);
		structureEdit(b);
	});
	renderAddPick();

	// Feature flags (D149): new features ship off; switch them in Settings > Advanced (D290). Turning one on asks for
	// the typed phrase ("yes, on air" while live), turning one off is instant. The list follows the server on every
	// status poll; the widget lives here, hidden, and the Settings window borrows it while it is open.
	// It sits in a hidden holder, never directly in the window (2026-11-10 Advanced offset bug): the embedded previews
	// carry native window handles (PreviewSlot), and Qt then gives every direct child of the main window its own native
	// handle as well. A list with a native handle, moved into the Settings dialog, kept being placed as a separate
	// child window (its own position, outside the dialog's fade and DPI scaling) and showed up shifted on the Advanced
	// page. The holder takes that native handle; the list inside it stays an ordinary (alien) widget.
	flagHome_ = new QWidget(this);
	flagHome_->hide();
	flagList_ = new QListWidget(flagHome_);
	connect(flagList_, &QListWidget::itemChanged, this, [this](QListWidgetItem *it) {
		setFlag(it->data(Qt::UserRole).toString(), it->checkState() == Qt::Checked);
	});
	return w;
}

QWidget *MainWindow::buildCentre()
{
	auto *w = new QWidget(this);
	auto *h = new QHBoxLayout(w);
	for (const char *cv : {"h", "v"}) {
		auto *box = new QGroupBox(QString::fromLatin1(cv).toUpper() == QStringLiteral("H") ? QStringLiteral("HORIZONTAL (H)") : QStringLiteral("VERTICAL (V)"), w);
		auto *bv = new QVBoxLayout(box);
		auto *slot = new PreviewSlot(api_, QString::fromLatin1(cv), box); // h|v, as the UI server's canvas enum (D280)
		slot->setMinimumSize(cv[0] == 'h' ? QSize(480, 270) : QSize(180, 320));
		bv->addWidget(slot, 1);
		slots_ << slot;
		auto *row = new QHBoxLayout();
		// Fallback when the preview cannot sit in the window (D280): its own host window. Small, right-aligned (D285).
		auto *open = new QPushButton(QStringLiteral("Own window"), box);
		auto *front = new QPushButton(QStringLiteral("To front"), box);
		open->setToolTip(QStringLiteral("Open this preview in its own window (if it does not show here)."));
		front->setToolTip(QStringLiteral("Bring that preview window to the front."));
		const QString canvas = QString::fromLatin1(cv);
		connect(open, &QPushButton::clicked, this, [this, canvas]() {
			QJsonObject p;
			p.insert(QStringLiteral("canvas"), canvas);
			api_->host(QStringLiteral("preview.open"), p, [this](bool ok, const QJsonObject &, const QString &err) { note(ok ? QStringLiteral("Preview opened.") : QStringLiteral("Preview failed: ") + err); });
		});
		connect(front, &QPushButton::clicked, this, [this, canvas]() {
			QJsonObject p;
			p.insert(QStringLiteral("canvas"), canvas);
			api_->host(QStringLiteral("preview.focus"), p, [this](bool ok, const QJsonObject &, const QString &err) { if (!ok) note(QStringLiteral("Preview failed: ") + err); });
		});
		row->addStretch(1);
		row->addWidget(open);
		row->addWidget(front);
		bv->addLayout(row);
		h->addWidget(box, cv[0] == 'h' ? 3 : 1);
	}
	return w;
}

QWidget *MainWindow::buildRight()
{
	auto *w = new QWidget(this);
	auto *outer = new QVBoxLayout(w);
	outer->setContentsMargins(0, 0, 0, 0);
	outer->setSpacing(10);
	// The inspector, looks, transitions and bots scroll; the controls and the stats cards stay in view.
	auto *scroll = new QScrollArea(w);
	scroll->setWidgetResizable(true);
	scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
	scroll->setFrameShape(QFrame::NoFrame);
	auto *body = new QWidget(scroll);
	body->setObjectName(QStringLiteral("scrollBody"));
	auto *v = new QVBoxLayout(body);
	v->setContentsMargins(0, 0, 6, 0);
	v->setSpacing(10);
	scroll->setWidget(body);
	outer->addWidget(buildControls());
	outer->addWidget(scroll, 1);

	auto *insp = new QGroupBox(QStringLiteral("INSPECTOR"), body);
	auto *iv = new QVBoxLayout(insp);
	inspEmpty_ = new QLabel(QStringLiteral("Select a layer to edit its position, size and crop."), insp);
	inspEmpty_->setWordWrap(true);
	iv->addWidget(inspEmpty_);
	inspForm_ = new QWidget(insp);
	auto *f = new QGridLayout(inspForm_);
	f->setContentsMargins(0, 0, 0, 0);
	f->setHorizontalSpacing(10);
	f->setVerticalSpacing(6);
	inspTitle_ = new QLabel(inspForm_);
	f->addWidget(inspTitle_, 0, 0, 1, 4);
	// A captioned field: a small muted caption over the box.
	auto field = [&](const QString &label, QWidget *x) {
		auto *cell = new QWidget(inspForm_);
		auto *cv = new QVBoxLayout(cell);
		cv->setContentsMargins(0, 0, 0, 0);
		cv->setSpacing(2);
		auto *cl = new QLabel(label, cell);
		cl->setObjectName(QStringLiteral("muted"));
		cv->addWidget(cl);
		cv->addWidget(x);
		return cell;
	};
	auto dbl = [this](double lo, double hi, int dec) {
		auto *s = new QDoubleSpinBox(inspForm_);
		s->setRange(lo, hi);
		s->setDecimals(dec);
		s->setButtonSymbols(QAbstractSpinBox::NoButtons);
		s->setMinimumWidth(40);
		return s;
	};
	inX_ = dbl(-16384, 16384, 0);
	inY_ = dbl(-16384, 16384, 0);
	inW_ = dbl(1, 16384, 0);
	inH_ = dbl(1, 16384, 0);
	inRot_ = dbl(-360, 360, 1);
	// Position and size in one row; rotation under it; the four crop boxes always shown (D330: crop is a first-class
	// edit, also by Alt+drag on an edge handle in the preview).
	f->addWidget(field(QStringLiteral("X"), inX_), 1, 0);
	f->addWidget(field(QStringLiteral("Y"), inY_), 1, 1);
	f->addWidget(field(QStringLiteral("Width"), inW_), 1, 2);
	f->addWidget(field(QStringLiteral("Height"), inH_), 1, 3);
	f->addWidget(field(QStringLiteral("Rotation"), inRot_), 2, 0, 1, 2);
	auto crop = [this]() {
		auto *s = new QSpinBox(inspForm_);
		s->setRange(0, 16384);
		s->setButtonSymbols(QAbstractSpinBox::NoButtons);
		return s;
	};
	crL_ = crop();
	crT_ = crop();
	crR_ = crop();
	crB_ = crop();
	auto *cropRow = new QWidget(inspForm_);
	auto *crl = new QHBoxLayout(cropRow);
	crl->setContentsMargins(0, 0, 0, 0);
	crl->setSpacing(10);
	crl->addWidget(field(QStringLiteral("Crop left"), crL_));
	crl->addWidget(field(QStringLiteral("Crop top"), crT_));
	crl->addWidget(field(QStringLiteral("Crop right"), crR_));
	crl->addWidget(field(QStringLiteral("Crop bottom"), crB_));
	f->addWidget(cropRow, 3, 0, 1, 4);
	auto *btns = new QHBoxLayout();
	auto *apply = new QPushButton(QStringLiteral("Apply"), inspForm_);
	auto *undo = new QPushButton(QStringLiteral("Undo changes"), inspForm_);
	btns->addWidget(apply);
	btns->addWidget(undo);
	f->addLayout(btns, 4, 0, 1, 4);
	connect(apply, &QPushButton::clicked, this, &MainWindow::applyInspector);
	connect(undo, &QPushButton::clicked, this, &MainWindow::renderInspector);
	iv->addWidget(inspForm_);
	inspForm_->setVisible(false);
	v->addWidget(insp);

	// Look (D290): the friendly effect controls for the selected layer. No flag: this is how rounded corners, shadows and
	// the other looks are set. Offline every change goes to the host after a short pause (layers.setEffects, saved into the
	// project, undoable); live the Apply button sends it and the server asks for "yes, on air".
	lookCap_ = captionLabel(QStringLiteral("Look"), body);
	v->addWidget(lookCap_);
	look_ = new LookPanel(body);
	look_->setTypes(lookTypes());
	look_->setMax(6);
	connect(look_, &LookPanel::edited, this, [this](const QJsonArray &fx) {
		effEdit_ = fx; // the shared working list (the Advanced list shows it too)
		effDirty_ = true;
		effRev_++;
		if (effBox_ && effBox_->isVisible())
			renderEffects();
	});
	connect(look_, &LookPanel::commit, this, &MainWindow::applyLook);
	connect(look_, &LookPanel::limit, this, [this](const QString &why) { note(why); });
	v->addWidget(look_);
	lookCap_->setVisible(false);
	look_->setVisible(false);

	effBox_ = new QGroupBox(QStringLiteral("ADVANCED EFFECTS"), body);
	auto *ev = new QVBoxLayout(effBox_);
	effList_ = new QListWidget(effBox_);
	effList_->setMaximumHeight(120);
	ev->addWidget(effList_);
	auto *erow = new QHBoxLayout();
	auto *addType = new QComboBox(effBox_);
	for (const auto &t : fxTypes())
		addType->addItem(QLatin1String(t.label), QLatin1String(t.type));
	auto *add = new QPushButton(QStringLiteral("Add"), effBox_);
	auto *up = new QPushButton(QStringLiteral("Up"), effBox_);
	auto *down = new QPushButton(QStringLiteral("Down"), effBox_);
	auto *rm = new QPushButton(QStringLiteral("Remove"), effBox_);
	erow->addWidget(addType, 1);
	erow->addWidget(add);
	ev->addLayout(erow);
	auto *erow2 = new QHBoxLayout();
	erow2->addWidget(up);
	erow2->addWidget(down);
	erow2->addWidget(rm);
	ev->addLayout(erow2);
	auto *formHost = new QWidget(effBox_);
	effForm_ = new QFormLayout(formHost);
	ev->addWidget(formHost);
	auto *ebtn = new QHBoxLayout();
	auto *eapply = new QPushButton(QStringLiteral("Apply effects"), effBox_);
	auto *erevert = new QPushButton(QStringLiteral("Revert"), effBox_);
	ebtn->addWidget(eapply);
	ebtn->addWidget(erevert);
	ev->addLayout(ebtn);
	effBox_->setVisible(false);
	v->addWidget(effBox_);
	connect(effList_, &QListWidget::currentRowChanged, this, [this](int) { renderEffectForm(); });
	connect(add, &QPushButton::clicked, this, [this, addType]() {
		const FxType *t = fxType(addType->currentData().toString());
		if (!t)
			return;
		if (effEdit_.size() >= 6)
			return note(QStringLiteral("A layer has at most 6 effects."));
		editEffects([t](QJsonArray &a, int &row) {
			a.append(fxDefault(*t));
			row = (int)a.size() - 1;
		});
	});
	connect(rm, &QPushButton::clicked, this, [this]() {
		editEffects([](QJsonArray &a, int &row) {
			if (row < 0 || row >= a.size())
				return;
			a.removeAt(row);
			row = std::min(row, (int)a.size() - 1);
		});
	});
	auto shift = [this](int by) {
		editEffects([by](QJsonArray &a, int &row) {
			const int to = row + by;
			if (row < 0 || to < 0 || to >= a.size())
				return;
			const QJsonValue x = a.at(row);
			a.replace(row, a.at(to));
			a.replace(to, x);
			row = to;
		});
	};
	connect(up, &QPushButton::clicked, this, [shift]() { shift(-1); });
	connect(down, &QPushButton::clicked, this, [shift]() { shift(1); });
	connect(eapply, &QPushButton::clicked, this, &MainWindow::applyEffects);
	connect(erevert, &QPushButton::clicked, this, [this]() {
		effDirty_ = false;
		effLayer_.clear();
		renderInspector();
	});

	// Transitions (D242, flag transitions): per canvas cut, fade or stinger, saved into the project; the UI server
	// applies it to the host on the next status poll.
	transBox_ = new QGroupBox(QStringLiteral("TRANSITIONS"), body);
	auto *tf = new QFormLayout(transBox_);
	trCanvas_ = new QComboBox(transBox_);
	trCanvas_->addItem(QStringLiteral("H"), QStringLiteral("h"));
	trCanvas_->addItem(QStringLiteral("V"), QStringLiteral("v"));
	trType_ = new QComboBox(transBox_);
	for (const char *t : {"cut", "fade", "stinger"})
		trType_->addItem(QString::fromLatin1(t), QString::fromLatin1(t));
	trMs_ = new QSpinBox(transBox_);
	trMs_->setRange(0, 10000);
	trMs_->setSuffix(QStringLiteral(" ms"));
	trFile_ = new QComboBox(transBox_);
	trPoint_ = new QSpinBox(transBox_);
	trPoint_->setRange(0, 10000);
	trPoint_->setSuffix(QStringLiteral(" ms"));
	trAudio_ = new QCheckBox(QStringLiteral("Play the video's sound"), transBox_);
	auto *trApply = new QPushButton(QStringLiteral("Apply transition"), transBox_);
	tf->addRow(QStringLiteral("Canvas"), trCanvas_);
	tf->addRow(QStringLiteral("Type"), trType_);
	tf->addRow(QStringLiteral("Duration"), trMs_);
	tf->addRow(QStringLiteral("Video"), trFile_);
	tf->addRow(QStringLiteral("Switch at"), trPoint_);
	tf->addRow(trAudio_);
	tf->addRow(trApply);
	transBox_->setVisible(false);
	v->addWidget(transBox_);
	connect(trCanvas_, &QComboBox::currentIndexChanged, this, [this]() { renderTransition(); });
	connect(trType_, &QComboBox::currentIndexChanged, this, [this]() {
		const QString t = trType_->currentData().toString();
		trMs_->setEnabled(t == QStringLiteral("fade"));
		for (QWidget *x : {(QWidget *)trFile_, (QWidget *)trPoint_, (QWidget *)trAudio_})
			x->setEnabled(t == QStringLiteral("stinger"));
	});
	connect(trApply, &QPushButton::clicked, this, &MainWindow::applyTransition);

	botBox_ = new QGroupBox(QStringLiteral("BOTS"), body);
	botRows_ = new QVBoxLayout(botBox_);
	botBox_->setVisible(false);
	v->addWidget(botBox_);

	v->addStretch(1);
	stats_ = new StatsCards(body);
	v->addWidget(stats_);
	return w;
}

// The audio mixer as a strip under the previews (D285, as in the reference): one card per sound, side by side.
QWidget *MainWindow::buildMixer()
{
	auto *mix = new QGroupBox(QStringLiteral("AUDIO MIXER"), this);
	auto *scroll = new QScrollArea(mix);
	scroll->setWidgetResizable(true);
	scroll->setVerticalScrollBarPolicy(Qt::ScrollBarAsNeeded);
	auto *inner = new QWidget(scroll);
	mixerBox_ = new QHBoxLayout(inner);
	mixerBox_->setSpacing(10);
	mixerBox_->addStretch(1);
	scroll->setWidget(inner);
	auto *mv = new QVBoxLayout(mix);
	mv->setContentsMargins(4, 4, 4, 4);
	mv->addWidget(scroll);
	return mix;
}

void MainWindow::resizeEvent(QResizeEvent *e)
{
	QMainWindow::resizeEvent(e);
	if (tasks_)
		tasks_->reposition();
}

void MainWindow::moveEvent(QMoveEvent *e)
{
	QMainWindow::moveEvent(e);
	if (tasks_)
		tasks_->reposition();
	for (PreviewSlot *s : slots_)
		s->schedule();
}

void MainWindow::start()
{
	// Arrow-key nudges (D254), as on the web page: 1 canvas px, Shift 10 px. Text and number fields keep their own
	// arrow keys (they take the key before a window shortcut).
	const std::pair<Qt::Key, QPoint> keys[] = {{Qt::Key_Left, {-1, 0}}, {Qt::Key_Right, {1, 0}}, {Qt::Key_Up, {0, -1}}, {Qt::Key_Down, {0, 1}}};
	for (const auto &k : keys) {
		for (const bool shift : {false, true}) {
			auto *sc = new QShortcut(QKeySequence(QKeyCombination(shift ? Qt::ShiftModifier : Qt::NoModifier, k.first)), this);
			sc->setContext(Qt::WindowShortcut);
			const QPoint d = k.second * (shift ? 10 : 1);
			connect(sc, &QShortcut::activated, this, [this, d]() { nudge(d.x(), d.y()); });
		}
	}
	// Text and number fields keep their own Ctrl+Z (they take the key before a window shortcut).
	for (const bool undo : {true, false}) {
		auto *sc = new QShortcut(undo ? QKeySequence::Undo : QKeySequence::Redo, this);
		sc->setContext(Qt::WindowShortcut);
		connect(sc, &QShortcut::activated, this, [this, undo]() { undoRedo(undo); });
	}
	loadUiSettings();
	guide_->start();
	loadScenes();
	pollStatus();
	auto *st = new QTimer(this);
	connect(st, &QTimer::timeout, this, &MainWindow::pollStatus);
	st->start(2000);
	auto *mt = new QTimer(this);
	connect(mt, &QTimer::timeout, this, &MainWindow::pollMeters);
	mt->start(250);
}

void MainWindow::note(const QString &text)
{
	note_->setText(text);
}

QJsonObject MainWindow::layerArgs(const QJsonObject &extra) const
{
	QJsonObject o;
	o.insert(QStringLiteral("scene"), activeScene_);
	for (const auto &s : scenes_) {
		const QJsonObject so = s.toObject();
		if (so.value(QStringLiteral("id")).toString() == activeScene_ && canvasesOf(so).size() > 1)
			o.insert(QStringLiteral("canvas"), canvas_);
	}
	for (auto it = extra.begin(); it != extra.end(); ++it)
		o.insert(it.key(), it.value());
	return o;
}

QJsonObject MainWindow::selectedLayer() const
{
	for (const auto &l : layers_)
		if (l.toObject().value(QStringLiteral("id")).toString() == selected_)
			return l.toObject();
	return {};
}

void MainWindow::loadScenes()
{
	api_->host(QStringLiteral("scenes.list"), {}, [this](bool ok, const QJsonObject &b, const QString &err) {
		if (!ok)
			return note(QStringLiteral("Scenes: ") + err);
		// the host lists a scene once per canvas; merge by id
		QJsonArray merged;
		QMap<QString, int> at;
		for (const auto &x : unwrap(b, "scenes")) {
			QJsonObject s = x.toObject();
			const QString id = s.value(QStringLiteral("id")).toString();
			if (!at.contains(id)) {
				QJsonArray cv;
				for (const QString &c : canvasesOf(s))
					cv.append(c);
				s.insert(QStringLiteral("canvases"), cv);
				at[id] = merged.size();
				merged.append(s);
			} else {
				QJsonObject e = merged.at(at[id]).toObject();
				QJsonArray cv = e.value(QStringLiteral("canvases")).toArray();
				for (const QString &c : canvasesOf(s))
					if (!cv.contains(c))
						cv.append(c);
				e.insert(QStringLiteral("canvases"), cv);
				if (s.value(QStringLiteral("active")).toBool())
					e.insert(QStringLiteral("active"), true);
				merged.replace(at[id], e);
			}
		}
		scenes_ = merged;
		bool known = false;
		for (const auto &s : scenes_)
			known |= s.toObject().value(QStringLiteral("id")).toString() == activeScene_;
		if (!known) {
			activeScene_.clear();
			for (const auto &s : scenes_)
				if (s.toObject().value(QStringLiteral("active")).toBool()) {
					activeScene_ = s.toObject().value(QStringLiteral("id")).toString();
					break;
				}
			if (activeScene_.isEmpty() && !scenes_.isEmpty())
				activeScene_ = scenes_.first().toObject().value(QStringLiteral("id")).toString();
		}
		renderScenes();
		loadLayers();
		loadMixer();
	});
}

void MainWindow::renderScenes()
{
	sceneList_->clear();
	for (const auto &x : scenes_) {
		const QJsonObject s = x.toObject();
		auto *it = new QListWidgetItem(s.value(QStringLiteral("name")).toString(), sceneList_);
		const bool active = s.value(QStringLiteral("id")).toString() == activeScene_;
		it->setData(Qt::UserRole, s.value(QStringLiteral("id")).toString());
		QStringList cv;
		for (const QString &c : canvasesOf(s))
			cv << c.toUpper();
		it->setData(Qt::UserRole + 1, (active ? QStringLiteral("ACTIVE  ·  ") : QString()) + cv.join(QStringLiteral(" + ")));
		it->setData(Qt::UserRole + 2, active);
	}
	bool both = false;
	for (const auto &s : scenes_)
		if (s.toObject().value(QStringLiteral("id")).toString() == activeScene_)
			both = canvasesOf(s.toObject()).size() > 1;
	tabH_->setVisible(both);
	tabV_->setVisible(both);
}

void MainWindow::loadLayers()
{
	if (activeScene_.isEmpty()) {
		layers_ = {};
		renderLayers();
		return;
	}
	api_->host(QStringLiteral("layers.list"), layerArgs(), [this](bool ok, const QJsonObject &b, const QString &err) {
		if (!ok)
			return note(QStringLiteral("Layers: ") + err);
		layers_ = unwrap(b, "layers");
		renderLayers();
		renderInspector();
	});
}

void MainWindow::renderLayers()
{
	const QSignalBlocker block(layerList_);
	layerList_->clear();
	for (int i = layers_.size() - 1; i >= 0; i--) { // top layer first
		const QJsonObject l = layers_.at(i).toObject();
		const bool vis = l.value(QStringLiteral("visible")).toBool();
		auto *it = new QListWidgetItem((vis ? QStringLiteral("◉  ") : QStringLiteral("○  ")) + l.value(QStringLiteral("name")).toString(), layerList_);
		it->setData(Qt::UserRole, l.value(QStringLiteral("id")).toString());
		if (!vis)
			it->setForeground(palette().color(QPalette::Disabled, QPalette::Text));
		if (l.value(QStringLiteral("id")).toString() == selected_)
			layerList_->setCurrentItem(it);
	}
}

void MainWindow::renderInspector()
{
	const QJsonObject l = selectedLayer();
	const QJsonObject p = l.value(QStringLiteral("placement")).toObject();
	const bool editable = !l.isEmpty() && l.contains(QStringLiteral("placement"));
	inspForm_->setVisible(editable);
	effBox_->setVisible(editable && effectEditing_);
	lookCap_->setVisible(editable);
	look_->setVisible(editable);
	if (const QString key = activeScene_ + QLatin1Char('/') + selected_; key != effLayer_ || !effDirty_) {
		// a reload keeps unsent effect changes of the same layer
		const bool other = key != effLayer_;
		effLayer_ = key;
		effEdit_ = l.value(QStringLiteral("effects")).toArray();
		effDirty_ = false;
		renderEffects();
		look_->setEffects(effEdit_);
		if (other)
			look_->clearPending();
		guide_->onLayerEffects(editable && !effEdit_.isEmpty());
	}
	inspEmpty_->setVisible(!editable);
	if (!l.isEmpty() && !editable)
		inspEmpty_->setText(l.value(QStringLiteral("name")).toString() + QStringLiteral(" has no editable placement."));
	else if (l.isEmpty())
		inspEmpty_->setText(QStringLiteral("Select a layer to edit its position, size and crop."));
	if (!editable)
		return;
	QString sub = canvas_.toUpper() + QStringLiteral(" canvas");
	if (l.value(QStringLiteral("width")).toInt() > 0)
		sub += QStringLiteral(", source %1x%2").arg(l.value(QStringLiteral("width")).toInt()).arg(l.value(QStringLiteral("height")).toInt());
	inspTitle_->setText(QStringLiteral("<b>%1</b><br>%2").arg(l.value(QStringLiteral("name")).toString().toHtmlEscaped(), sub));
	inX_->setValue(p.value(QStringLiteral("x")).toDouble());
	inY_->setValue(p.value(QStringLiteral("y")).toDouble());
	inW_->setValue(p.value(QStringLiteral("width")).toDouble());
	inH_->setValue(p.value(QStringLiteral("height")).toDouble());
	inRot_->setValue(p.value(QStringLiteral("rotation")).toDouble(0));
	const QJsonObject c = p.value(QStringLiteral("crop")).toObject();
	crL_->setValue(c.value(QStringLiteral("left")).toInt());
	crT_->setValue(c.value(QStringLiteral("top")).toInt());
	crR_->setValue(c.value(QStringLiteral("right")).toInt());
	crB_->setValue(c.value(QStringLiteral("bottom")).toInt());
}

void MainWindow::applyInspector()
{
	const QJsonObject l = selectedLayer();
	if (l.isEmpty())
		return;
	const QJsonObject p = l.value(QStringLiteral("placement")).toObject();
	const QJsonObject c = p.value(QStringLiteral("crop")).toObject();
	QJsonObject patch, crop;
	auto num = [&](const char *k, double v, double def) {
		if (std::abs(v - p.value(QLatin1String(k)).toDouble(def)) > 1e-6)
			patch.insert(QLatin1String(k), v);
	};
	num("x", inX_->value(), 0);
	num("y", inY_->value(), 0);
	num("width", inW_->value(), 0);
	num("height", inH_->value(), 0);
	num("rotation", inRot_->value(), 0);
	auto cr = [&](const char *k, int v) {
		if (v != c.value(QLatin1String(k)).toInt())
			crop.insert(QLatin1String(k), v);
	};
	cr("left", crL_->value());
	cr("top", crT_->value());
	cr("right", crR_->value());
	cr("bottom", crB_->value());
	if (!crop.isEmpty())
		patch.insert(QStringLiteral("crop"), crop);
	if (patch.isEmpty())
		return note(QStringLiteral("Nothing changed."));
	QJsonObject x;
	x.insert(QStringLiteral("layer"), selected_);
	x.insert(QStringLiteral("placement"), patch);
	api_->host(QStringLiteral("layers.setPlacement"), layerArgs(x), [this](bool ok, const QJsonObject &b, const QString &err) {
		if (ok && b.value(QStringLiteral("verdict")).toString() == QStringLiteral("confirm"))
			return confirm(b.value(QStringLiteral("pending")).toObject()); // live: "yes, on air" (D233)
		note(ok ? QStringLiteral("Applied.") : QStringLiteral("Not applied: ") + err);
		loadLayers();
	});
}

// ---- effect editor (D260) -------------------------------------------------------------------------------------------

void MainWindow::editEffects(const std::function<void(QJsonArray &, int &)> &change)
{
	int row = effList_->currentRow();
	change(effEdit_, row);
	effDirty_ = true;
	effRev_++;
	renderEffects();
	look_->setEffects(effEdit_);
	if (row >= 0 && row < effList_->count())
		effList_->setCurrentRow(row);
}

void MainWindow::renderEffects()
{
	const int keep = effList_->currentRow();
	{
		const QSignalBlocker block(effList_);
		effList_->clear();
		for (const auto &x : effEdit_)
			effList_->addItem(fxSummary(x.toObject()));
		if (effList_->count())
			effList_->setCurrentRow(std::clamp(keep, 0, effList_->count() - 1));
	}
	renderEffectForm();
}

void MainWindow::renderEffectForm()
{
	while (effForm_->rowCount())
		effForm_->removeRow(0);
	const int row = effList_->currentRow();
	if (row < 0 || row >= effEdit_.size()) {
		effForm_->addRow(new QLabel(effEdit_.isEmpty() ? QStringLiteral("No effects. Pick one and press Add.") : QString()));
		return;
	}
	const QJsonObject e = effEdit_.at(row).toObject();
	const FxType *t = fxType(e.value(QStringLiteral("type")).toString());
	if (!t) {
		effForm_->addRow(new QLabel(QStringLiteral("This effect type has no settings here; it is kept as it is.")));
		return;
	}
	auto set = [this, row](const QString &key, const QJsonValue &v) {
		if (row >= effEdit_.size())
			return;
		QJsonObject o = effEdit_.at(row).toObject();
		o.insert(key, v);
		effEdit_.replace(row, o);
		effDirty_ = true;
		effRev_++;
		if (QListWidgetItem *it = effList_->item(row))
			it->setText(fxSummary(o));
	};
	for (const auto &p : t->params) {
		const QString key = QLatin1String(p.key);
		if (p.colour) {
			auto *line = new QLineEdit(e.value(key).toString(QLatin1String(p.cdef)));
			line->setValidator(new QRegularExpressionValidator(QRegularExpression(QStringLiteral("^#[0-9a-fA-F]{6}$")), line));
			line->setMaxLength(7);
			auto *swatch = new QLabel();
			swatch->setFixedSize(22, 22);
			auto paint = [swatch](const QString &c) { swatch->setStyleSheet(QStringLiteral("background:%1;border:1px solid #888;").arg(c)); };
			paint(line->text());
			auto *rowBox = new QHBoxLayout();
			rowBox->addWidget(line, 1);
			rowBox->addWidget(swatch);
			effForm_->addRow(QLatin1String(p.label), rowBox);
			connect(line, &QLineEdit::textChanged, this, [line, set, paint, key](const QString &txt) {
				if (!line->hasAcceptableInput())
					return;
				paint(txt);
				set(key, txt.toLower());
			});
		} else {
			auto *spin = new QDoubleSpinBox();
			spin->setRange(p.lo, p.hi);
			spin->setDecimals(p.dec);
			spin->setSingleStep(p.step);
			spin->setValue(e.value(key).toDouble(p.def));
			effForm_->addRow(QLatin1String(p.label), spin);
			connect(spin, &QDoubleSpinBox::valueChanged, this, [set, key](double v) { set(key, v); });
		}
	}
}

// The whole list goes to the host for every canvas of the scene (layers.setEffects); while live the UI server asks
// for "yes, on air" first. The host checks each effect; the UI server saves the list into the project (undoable).
void MainWindow::applyEffects()
{
	if (selected_.isEmpty() || activeScene_.isEmpty())
		return;
	QJsonObject x;
	x.insert(QStringLiteral("scene"), activeScene_);
	x.insert(QStringLiteral("layer"), selected_);
	x.insert(QStringLiteral("effects"), effEdit_);
	const QString key = activeScene_ + QLatin1Char('/') + selected_;
	const int rev = effRev_;
	api_->host(QStringLiteral("layers.setEffects"), x, [this, key, rev](bool ok, const QJsonObject &b, const QString &err) {
		if (ok && b.value(QStringLiteral("verdict")).toString() == QStringLiteral("confirm"))
			return confirm(b.value(QStringLiteral("pending")).toObject());
		if (ok && effLayer_ == key && effRev_ == rev) // not when the draft changed or moved on while it was sent
			effDirty_ = false;
		note(ok ? QStringLiteral("Effects applied.") : QStringLiteral("Effects not applied: ") + err);
		loadLayers();
	});
}

// The Look panel's send (D290): the whole working list, one send at a time (a change made while one is on its way
// goes out right after it). Live, the server asks for "yes, on air" first (the Apply button started this).
void MainWindow::applyLook()
{
	if (lookSending_) {
		lookAgain_ = true;
		return;
	}
	if (selected_.isEmpty() || activeScene_.isEmpty())
		return;
	lookSending_ = true;
	QJsonObject x;
	x.insert(QStringLiteral("scene"), activeScene_);
	x.insert(QStringLiteral("layer"), selected_);
	x.insert(QStringLiteral("effects"), effEdit_);
	const QString key = activeScene_ + QLatin1Char('/') + selected_;
	const int rev = effRev_;
	api_->host(QStringLiteral("layers.setEffects"), x, [this, key, rev](bool ok, const QJsonObject &b, const QString &err) {
		lookSending_ = false;
		if (ok && b.value(QStringLiteral("verdict")).toString() == QStringLiteral("confirm")) {
			lookAgain_ = false;
			return confirm(b.value(QStringLiteral("pending")).toObject());
		}
		if (ok && effLayer_ == key && effRev_ == rev) // not when the draft changed or moved on while it was sent
			effDirty_ = false;
		note(ok ? QStringLiteral("Look applied.") : QStringLiteral("Look not applied: ") + err);
		if (lookAgain_) {
			lookAgain_ = false;
			return applyLook();
		}
		loadLayers();
	});
}

// Arrow-key nudge (D254): only while preview editing is on and a layer with a placement is selected; off while live
// (each press would need "yes, on air"). Presses made while a move is on its way add up into one layers.setPlacement.
void MainWindow::nudge(int dx, int dy)
{
	if (!previewEditing_ || selectedLayer().value(QStringLiteral("placement")).toObject().isEmpty())
		return;
	if (live_)
		return note(QStringLiteral("Live: arrow keys are off. Use the inspector."));
	nudgeDx_ += dx;
	nudgeDy_ += dy;
	sendNudge();
}

void MainWindow::sendNudge()
{
	if (nudgeBusy_ || (!nudgeDx_ && !nudgeDy_))
		return;
	const QJsonObject p = selectedLayer().value(QStringLiteral("placement")).toObject();
	if (p.isEmpty()) {
		nudgeDx_ = nudgeDy_ = 0;
		return;
	}
	QJsonObject patch;
	if (nudgeDx_)
		patch.insert(QStringLiteral("x"), std::round((p.value(QStringLiteral("x")).toDouble() + nudgeDx_) * 100) / 100);
	if (nudgeDy_)
		patch.insert(QStringLiteral("y"), std::round((p.value(QStringLiteral("y")).toDouble() + nudgeDy_) * 100) / 100);
	nudgeDx_ = nudgeDy_ = 0;
	nudgeBusy_ = true;
	QJsonObject x;
	x.insert(QStringLiteral("layer"), selected_);
	x.insert(QStringLiteral("placement"), patch);
	const QString layer = selected_;
	api_->host(QStringLiteral("layers.setPlacement"), layerArgs(x), [this, patch, layer](bool ok, const QJsonObject &b, const QString &err) {
		nudgeBusy_ = false;
		if (ok && b.value(QStringLiteral("verdict")).toString() == QStringLiteral("confirm")) {
			QJsonObject body;
			body.insert(QStringLiteral("pendingId"), b.value(QStringLiteral("pending")).toObject().value(QStringLiteral("pendingId")));
			api_->post(QStringLiteral("ui/api/cancel"), body, [](bool, const QJsonObject &, const QString &) {});
			nudgeDx_ = nudgeDy_ = 0;
			return note(QStringLiteral("Live: arrow keys are off. Use the inspector."));
		}
		if (!ok) {
			nudgeDx_ = nudgeDy_ = 0;
			note(QStringLiteral("Not moved: ") + err);
			return loadLayers();
		}
		// keep the cached placement current so the next nudge adds to it before the list reloads
		for (int i = 0; i < layers_.size(); i++) {
			QJsonObject l = layers_.at(i).toObject();
			if (l.value(QStringLiteral("id")).toString() != layer)
				continue;
			QJsonObject pl = l.value(QStringLiteral("placement")).toObject();
			for (auto it = patch.begin(); it != patch.end(); ++it)
				pl.insert(it.key(), it.value());
			l.insert(QStringLiteral("placement"), pl);
			layers_.replace(i, l);
		}
		if (nudgeDx_ || nudgeDy_)
			return sendNudge();
		renderInspector();
		loadLayers();
	});
}

void MainWindow::loadMixer()
{
	api_->host(QStringLiteral("mixer.list"), {}, [this](bool ok, const QJsonObject &b, const QString &err) {
		if (!ok)
			return note(QStringLiteral("Mixer: ") + err);
		mixer_ = unwrap(b, "sources");
		mixerTracks_ = unwrap(b, "tracks");
		renderMixer();
	});
}

void MainWindow::renderMixer()
{
	while (mixerBox_->count() > 1) { // keep the trailing stretch
		QLayoutItem *it = mixerBox_->takeAt(0);
		if (it->widget())
			it->widget()->deleteLater();
		delete it;
	}
	meters_.clear();
	routeButtons_ = 0;
	QStringList offMix;
	int row = 0;
	const bool routing = mixerRoutingOn_ && !mixerTracks_.isEmpty();
	for (const auto &x : mixer_) {
		const QJsonObject m = x.toObject();
		// With track routing on, a sound with a project audio entry stays listed on no track, so it can be put back.
		const bool routable = routing && m.value(QStringLiteral("audioSource")).isString();
		if (!routable && m.contains(QStringLiteral("mixers")) && m.value(QStringLiteral("mixers")).toInt() == 0) {
			offMix << m.value(QStringLiteral("name")).toString();
			continue;
		}
		const QString id = m.value(QStringLiteral("id")).toString();
		auto *strip = new QFrame();
		strip->setObjectName(QStringLiteral("strip")); // a card (theme.cpp)
		strip->setMinimumWidth(240);
		strip->setMaximumWidth(320);
		auto *g = new QVBoxLayout(strip);
		g->setContentsMargins(10, 8, 10, 8);
		auto *top = new QHBoxLayout();
		top->addWidget(new QLabel(QStringLiteral("<b>%1</b>").arg(m.value(QStringLiteral("name")).toString().toHtmlEscaped())), 1);
		const bool muted = m.value(QStringLiteral("muted")).toBool();
		auto *mute = new QPushButton(muted ? QStringLiteral("Unmute") : QStringLiteral("Mute"));
		mute->setObjectName(QStringLiteral("mute"));
		mute->setCheckable(true);
		mute->setChecked(muted);
		connect(mute, &QPushButton::clicked, this, [this, id](bool on) {
			QJsonObject p;
			p.insert(QStringLiteral("id"), id);
			p.insert(QStringLiteral("muted"), on);
			api_->host(QStringLiteral("mixer.setMute"), p, [this](bool ok, const QJsonObject &, const QString &err) {
				if (!ok)
					note(QStringLiteral("Mute failed: ") + err);
				loadMixer();
			});
		});
		// CUE: hear this channel in the headphones (Meld's per-channel button), applied at once.
		const bool cueOn = m.value(QStringLiteral("cue")).toBool();
		auto *cue = new QPushButton(QStringLiteral("CUE"));
		cue->setCheckable(true);
		cue->setChecked(cueOn);
		if (m.value(QStringLiteral("cueDelayed")).toBool())
			cue->setToolTip(QStringLiteral("This channel has video: libobs delays its headphone sound to match the picture"));
		connect(cue, &QPushButton::clicked, this, [this, id](bool on) {
			QJsonObject p;
			p.insert(QStringLiteral("id"), id);
			p.insert(QStringLiteral("cue"), on);
			api_->host(QStringLiteral("mixer.setCue"), p, [this](bool ok, const QJsonObject &, const QString &err) {
				if (!ok)
					note(QStringLiteral("CUE failed: ") + err);
				loadMixer();
			});
		});
		top->addWidget(cue);
		top->addWidget(mute);
		g->addLayout(top);
		if (routable) { // track routing (D273): one button per project track; track 1 is what every output encodes
			auto *tr = new QHBoxLayout();
			tr->addWidget(new QLabel(QStringLiteral("Tracks:")));
			QStringList on;
			for (const auto &t : m.value(QStringLiteral("tracks")).toArray())
				on << t.toString();
			for (int n = 0; n < mixerTracks_.size(); n++) {
				const QJsonObject t = mixerTracks_.at(n).toObject();
				const QString tid = t.value(QStringLiteral("id")).toString();
				auto *b = new QPushButton(t.value(QStringLiteral("name")).toString());
				b->setObjectName(QStringLiteral("track:") + tid);
				b->setCheckable(true);
				b->setChecked(on.contains(tid));
				b->setToolTip(n == 0 ? QStringLiteral("Track 1: what the stream and the recording hear") : QStringLiteral("Not used by the outputs yet"));
				connect(b, &QPushButton::clicked, this, [this, id, on, tid](bool checked) {
					QStringList next;
					for (const auto &t : mixerTracks_) { // keep the project's track order
						const QString x = t.toObject().value(QStringLiteral("id")).toString();
						if (x == tid ? checked : on.contains(x))
							next << x;
					}
					setTracks(id, next);
				});
				tr->addWidget(b);
				routeButtons_++;
			}
			tr->addStretch(1);
			g->addLayout(tr);
		}
		auto *meter = new QProgressBar();
		meter->setRange(0, 100);
		meter->setTextVisible(false);
		meter->setMaximumHeight(8);
		meter->setValue(meterValue(m.value(QStringLiteral("peakDb"))));
		meters_[id] = meter;
		g->addWidget(meter);
		auto *bottom = new QHBoxLayout();
		// D330: the shared slider (click jumps, typed dB, keys); the volume is sent once the user is done (committed).
		auto *slider = new ValueSlider(-60, 0, 1, 0);
		slider->setObjectName(QStringLiteral("vol:") + id); // probes find it by the source id
		slider->setSuffix(QStringLiteral(" dB"));
		slider->setPageStep(6);
		slider->setValue(std::max(-60.0, std::min(0.0, m.value(QStringLiteral("volumeDb")).toDouble(0))));
		slider->setAccessibleName(QStringLiteral("Volume"));
		connect(slider, &ValueSlider::committed, this, [this, id](double v) {
			QJsonObject p;
			p.insert(QStringLiteral("id"), id);
			p.insert(QStringLiteral("db"), (int)std::lround(v));
			api_->host(QStringLiteral("mixer.setVolume"), p, [this](bool ok, const QJsonObject &, const QString &err) { if (!ok) note(QStringLiteral("Volume failed: ") + err); });
		});
		bottom->addWidget(slider, 1);
		g->addLayout(bottom);
		mixerBox_->insertWidget(row++, strip);
	}
	if (!offMix.isEmpty()) {
		auto *n = new QLabel(QStringLiteral("Not in the stream mix (layer sound off): ") + offMix.join(QStringLiteral(", ")) + QStringLiteral("."));
		n->setWordWrap(true);
		n->setMaximumWidth(260);
		mixerBox_->insertWidget(row++, n);
	}
}

void MainWindow::setTracks(const QString &id, const QStringList &tracks)
{
	if (routeBusy_) { // the buttons show the routing before the change on its way: building on them would drop it
		note(QStringLiteral("A track change is still on its way; try again in a moment."));
		return loadMixer();
	}
	routeBusy_ = true;
	QJsonObject p;
	p.insert(QStringLiteral("id"), id);
	p.insert(QStringLiteral("tracks"), QJsonArray::fromStringList(tracks));
	api_->host(QStringLiteral("mixer.setTracks"), p, [this](bool ok, const QJsonObject &b, const QString &err) {
		routeBusy_ = false;
		if (ok && b.value(QStringLiteral("verdict")).toString() == QStringLiteral("confirm"))
			confirm(b.value(QStringLiteral("pending")).toObject()); // live: "yes, on air"; reloads the mixer after
		else if (!ok)
			note(QStringLiteral("Tracks not changed: ") + err);
		else
			note(b.value(QStringLiteral("saved")).toString() == QStringLiteral("pending")
				     ? QStringLiteral("Tracks changed.")
				     : QStringLiteral("Tracks changed, live only: not saved to the project file."));
		loadMixer();
	});
}

void MainWindow::pollMeters()
{
	if (meterBusy_ || meters_.isEmpty() || isMinimized())
		return;
	meterBusy_ = true;
	api_->host(QStringLiteral("mixer.list"), {}, [this](bool ok, const QJsonObject &b, const QString &) {
		meterBusy_ = false;
		if (!ok)
			return; // a missed meter frame is harmless
		for (const auto &x : unwrap(b, "sources")) {
			const QJsonObject m = x.toObject();
			if (QProgressBar *bar = meters_.value(m.value(QStringLiteral("id")).toString()))
				bar->setValue(meterValue(m.value(QStringLiteral("peakDb"))));
		}
	});
}

// The live alert strip (D305 proposed): one line per alert, the worst level colours the strip (danger for an error,
// accent for a warning, the panel colour for information). Empty or missing (flag off): hidden.
void MainWindow::updateAlerts(const QJsonArray &alerts)
{
	QStringList lines;
	int worst = 0; // 0 info, 1 warn, 2 error
	for (const auto &x : alerts) {
		const QJsonObject a = x.toObject();
		const QString t = a.value(QStringLiteral("text")).toString().left(400);
		if (t.isEmpty())
			continue;
		const QString lv = a.value(QStringLiteral("level")).toString();
		worst = std::max(worst, lv == QStringLiteral("error") ? 2 : lv == QStringLiteral("warn") ? 1 : 0);
		lines.append(t);
		if (lines.size() >= 8)
			break;
	}
	alertLevel_ = lines.isEmpty() ? QString() : QString::fromLatin1(worst == 2 ? "error" : worst == 1 ? "warn" : "info");
	const QString text = lines.join(QLatin1Char('\n'));
	if (text == alertBar_->text() && alertBar_->isHidden() == lines.isEmpty())
		return;
	alertBar_->setText(text);
	const QColor edge = theme::color(worst == 2 ? QStringLiteral("danger") : worst == 1 ? QStringLiteral("accent") : QStringLiteral("border"));
	alertBar_->setStyleSheet(QStringLiteral("QLabel#alertBar { background: %1; color: %2; border: 1px solid %3; border-radius: 6px; }")
					 .arg(theme::color(QStringLiteral("panel")).name(), theme::color(QStringLiteral("text")).name(), edge.name()));
	alertBar_->setVisible(!lines.isEmpty());
}

void MainWindow::pollStatus()
{
	api_->get(QStringLiteral("ui/api/status"), [this](bool ok, const QJsonObject &s, const QString &err) {
		if (!ok) {
			pillHost_->setText(QStringLiteral("UI server: down"));
			return note(QStringLiteral("Status: ") + err);
		}
		const QJsonObject h = s.value(QStringLiteral("host")).toObject(), c = s.value(QStringLiteral("core")).toObject();
		live_ = h.value(QStringLiteral("live")).toBool();
		look_->setLive(live_);
		// A restarted host (crash supervisor) lost the previews it drew in our slots: embed them again (D280).
		const double up = h.value(QStringLiteral("uptimeMs")).toDouble(-1);
		if (up >= 0 && hostUptime_ >= 0 && up < hostUptime_)
			for (PreviewSlot *slot : slots_)
				slot->schedule();
		if (up >= 0)
			hostUptime_ = up;
		previewEditing_ = h.value(QStringLiteral("previewEditing")).toBool();
		if (const bool ee = h.value(QStringLiteral("effectEditing")).toBool(); ee != effectEditing_) {
			effectEditing_ = ee;
			renderInspector();
		}
		recording_ = h.value(QStringLiteral("recording")).toBool();
		pillLive_->setText(live_ ? QStringLiteral("LIVE") : QStringLiteral("Offline"));
		motion::setChip(pillLive_, live_, theme::color(QStringLiteral("danger")));
		pillRec_->setText(recording_ ? QStringLiteral("Recording") : QStringLiteral("Not recording"));
		motion::setChip(pillRec_, recording_, theme::color(QStringLiteral("danger")));
		pillStats_->setText(QStringLiteral("Dropped %1 · %2 fps · CPU %3% · GPU %4%")
					    .arg(h.value(QStringLiteral("droppedFrames")).toInt())
					    .arg(h.value(QStringLiteral("fps")).toDouble(), 0, 'f', 1)
					    .arg(h.value(QStringLiteral("cpuPct")).toDouble(), 0, 'f', 1)
					    .arg(h.value(QStringLiteral("gpuPct")).toDouble(), 0, 'f', 0));
		pillHost_->setText(h.value(QStringLiteral("blockedOnHost")).toBool() ? QStringLiteral("BLOCKED-ON-HOST (fake)")
				   : h.value(QStringLiteral("available")).toBool()   ? QStringLiteral("Host: up")
										     : QStringLiteral("Host: down"));
		pillCore_->setText(c.value(QStringLiteral("available")).toBool() ? QStringLiteral("Event core: up") : QStringLiteral("Event core: down"));
		stats_->sample(h.value(QStringLiteral("cpuPct")).toDouble(), h.value(QStringLiteral("gpuPct")).toDouble(), h.value(QStringLiteral("fps")).toDouble(),
			       h.value(QStringLiteral("droppedFrames")).toInt(), live_, recording_);
		updateAlerts(s.value(QStringLiteral("alerts")).toArray());
		tasks_->update(s.value(QStringLiteral("tasks")).toArray(), s.value(QStringLiteral("at")).toDouble());
		if (tray_ && tray_->active())
			tray_->update(tasks_->tasks());
		updateClips(s.value(QStringLiteral("clips")).toObject());
		guide_->onStatus(s);
		// A layer moved or resized with the mouse on the embedded preview (D230): select it, reload layers + inspector.
		const QJsonObject pe = h.value(QStringLiteral("previewEdit")).toObject();
		if (!pe.isEmpty()) {
			const int seq = pe.value(QStringLiteral("seq")).toInt();
			if (previewSeq_ >= 0 && seq != previewSeq_ && pe.value(QStringLiteral("scene")).toString() == activeScene_) {
				selected_ = pe.value(QStringLiteral("layer")).toString();
				loadLayers();
			}
			previewSeq_ = seq;
		}
		const QJsonObject ready = h.value(QStringLiteral("outputsReady")).toObject();
		streamBtn_->setEnabled(ready.value(QStringLiteral("stream")).toBool());
		recordBtn_->setEnabled(ready.value(QStringLiteral("record")).toBool());
		// Say why a button is off (D281): no stream target unless Ujwalam was started for live.
		streamBtn_->setToolTip(streamBtn_->isEnabled() ? (live_ ? QStringLiteral("Stop the stream (you type a confirmation first).") : QStringLiteral("Go live (you type: yes, on air)."))
							       : QStringLiteral("Streaming needs the LIVE start: the \"Ujwalam (alpha, LIVE)\" shortcut, or Ujwalam.cmd --live."));
		recordBtn_->setToolTip(recordBtn_->isEnabled() ? (recording_ ? QStringLiteral("Stop recording.") : QStringLiteral("Start recording to a file."))
								    : QStringLiteral("No recording output is set up in this start."));
		// The round controls change icon and caption with the state (D290); a red fill says "on".
		for (const auto &ctl : {std::make_tuple(streamBtn_, live_, "stop", "Stop stream", "play", "Start stream"),
				      std::make_tuple(recordBtn_, recording_, "stop", "Stop recording", "record", "Record")}) {
			QPushButton *b = std::get<0>(ctl);
			const bool on = std::get<1>(ctl);
			if (b->property("active").toBool() != on) {
				b->setProperty("active", on);
				b->style()->unpolish(b);
				b->style()->polish(b);
			}
			setControl(b, QLatin1String(on ? std::get<2>(ctl) : std::get<4>(ctl)), QLatin1String(on ? std::get<3>(ctl) : std::get<5>(ctl)));
		}
		loadEdits();
		loadFlags();
	});
}

void MainWindow::loadFlags()
{
	api_->get(QStringLiteral("ui/api/flags"), [this](bool ok, const QJsonObject &b, const QString &) {
		if (!ok)
			return;
		const QJsonArray fl = b.value(QStringLiteral("flags")).toArray();
		const QSignalBlocker block(flagList_); // a refresh is not a click
		bool same = flagList_->count() == fl.size();
		for (int i = 0; same && i < fl.size(); i++)
			same = flagList_->item(i)->data(Qt::UserRole).toString() == fl.at(i).toObject().value(QStringLiteral("id")).toString();
		if (!same)
			flagList_->clear();
		for (int i = 0; i < fl.size(); i++) {
			const QJsonObject f = fl.at(i).toObject();
			QListWidgetItem *it = same ? flagList_->item(i) : new QListWidgetItem(f.value(QStringLiteral("id")).toString(), flagList_);
			if (!same) {
				it->setData(Qt::UserRole, f.value(QStringLiteral("id")).toString());
				it->setToolTip(f.value(QStringLiteral("description")).toString());
				it->setFlags(it->flags() | Qt::ItemIsUserCheckable);
			}
			it->setCheckState(f.value(QStringLiteral("on")).toBool() ? Qt::Checked : Qt::Unchecked);
		}
		bool se = false, tr = false;
		for (const auto &x : fl) {
			const QJsonObject f = x.toObject();
			if (f.value(QStringLiteral("id")).toString() == QStringLiteral("scene-edit"))
				se = f.value(QStringLiteral("on")).toBool();
			else if (f.value(QStringLiteral("id")).toString() == QStringLiteral("transitions"))
				tr = f.value(QStringLiteral("on")).toBool();
		}
		if (se != sceneEditOn_) {
			sceneEditOn_ = se;
			structBox_->setVisible(se);
			if (se)
				loadStructure();
		}
		if (tr != transitionsOn_) {
			transitionsOn_ = tr;
			transBox_->setVisible(tr);
			if (tr)
				loadTransitions();
		}
		bool bo = false;
		for (const auto &x : fl)
			if (x.toObject().value(QStringLiteral("id")).toString() == QStringLiteral("bot-manager"))
				bo = x.toObject().value(QStringLiteral("on")).toBool();
		bool mr = false;
		for (const auto &x : fl)
			if (x.toObject().value(QStringLiteral("id")).toString() == QStringLiteral("mixer-routing"))
				mr = x.toObject().value(QStringLiteral("on")).toBool();
		if (mr != mixerRoutingOn_) {
			mixerRoutingOn_ = mr;
			loadMixer();
		}
		bool rep = false;
		for (const auto &x : fl)
			if (x.toObject().value(QStringLiteral("id")).toString() == QStringLiteral("report-button"))
				rep = x.toObject().value(QStringLiteral("on")).toBool();
		reportAct_->setVisible(rep);
		bool po = false;
		for (const auto &x : fl)
			if (x.toObject().value(QStringLiteral("id")).toString() == QStringLiteral("posting"))
				po = x.toObject().value(QStringLiteral("on")).toBool();
		postsAct_->setVisible(po);
		bool ap = false;
		for (const auto &x : fl)
			if (x.toObject().value(QStringLiteral("id")).toString() == QStringLiteral("auto-post"))
				ap = x.toObject().value(QStringLiteral("on")).toBool();
		guide_->setFlags(po, ap);
		if (bo != botsOn_) {
			botsOn_ = bo;
			botBox_->setVisible(bo);
			botPoll_ = 0;
		}
		if (botsOn_ && botPoll_++ % 5 == 0)
			loadBots();
		// Both edit the project and are refused while live (the server checks too).
		structBox_->setEnabled(!live_);
		transBox_->setEnabled(!live_);
		updateAddButtons();
	});
}

void MainWindow::loadBots()
{
	api_->get(QStringLiteral("ui/api/bots"), [this](bool ok, const QJsonObject &b, const QString &err) {
		while (QLayoutItem *it = botRows_->takeAt(0)) {
			delete it->widget();
			delete it;
		}
		if (!ok) {
			botRows_->addWidget(new QLabel(QStringLiteral("Bots: ") + err, botBox_));
			return;
		}
		const auto yn = [](const QJsonObject &o, const char *k) { return o.value(QLatin1String(k)).toBool() ? QStringLiteral("yes") : QStringLiteral("no"); };
		for (const auto &x : b.value(QStringLiteral("bots")).toArray()) {
			const QJsonObject o = x.toObject();
			const QString bot = o.value(QStringLiteral("bot")).toString();
			const bool running = o.value(QStringLiteral("running")).toBool();
			const QString state = o.value(QStringLiteral("ok")).toBool() ? QStringLiteral("up")
					      : running ? QStringLiteral("running, port not answering")
					      : o.value(QStringLiteral("installed")).toBool() ? QStringLiteral("stopped") : QStringLiteral("not installed");
			auto *row = new QWidget(botBox_);
			auto *rv = new QVBoxLayout(row);
			rv->setContentsMargins(0, 0, 0, 0);
			auto *top = new QHBoxLayout();
			top->addWidget(new QLabel(QStringLiteral("<b>%1</b> %2").arg(o.value(QStringLiteral("label")).toString(bot).toHtmlEscaped(), state), row), 1);
			auto *start = new QPushButton(QStringLiteral("Start"), row);
			auto *stop = new QPushButton(QStringLiteral("Stop"), row);
			start->setEnabled(o.value(QStringLiteral("installed")).toBool() && !running && !o.contains(QStringLiteral("error")));
			stop->setEnabled(o.value(QStringLiteral("startedByUs")).toBool()); // a copy the user started is never stopped here
			connect(start, &QPushButton::clicked, this, [this, bot]() { botAction(bot, true); });
			connect(stop, &QPushButton::clicked, this, [this, bot]() { botAction(bot, false); });
			top->addWidget(start);
			top->addWidget(stop);
			rv->addLayout(top);
			QString facts = QStringLiteral("installed: %1, running: %2, port %3 answering: %4, started by Ujwalam: %5")
						.arg(yn(o, "installed"), yn(o, "running"), o.value(QStringLiteral("port")).toVariant().toString(), yn(o, "portAnswering"), yn(o, "startedByUs"));
			if (o.contains(QStringLiteral("error")))
				facts += QStringLiteral("\nCheck failed: ") + o.value(QStringLiteral("error")).toString();
			if (o.contains(QStringLiteral("wsError")))
				facts += QStringLiteral("\nPort setting refused: ") + o.value(QStringLiteral("wsError")).toString();
			auto *fl = new QLabel(facts, row);
			fl->setWordWrap(true);
			fl->setEnabled(false); // muted text
			rv->addWidget(fl);
			botRows_->addWidget(row);
		}
		auto *hint = new QLabel(QStringLiteral("Start and Stop ask you to type yes. Stop only ends a bot that Ujwalam started."), botBox_);
		hint->setWordWrap(true);
		botRows_->addWidget(hint);
	});
}

// Meld import: the server writes a new project file (never changes the current one), the host plans it (counts only),
// and Load asks for the typed phrase before project.load replaces the scenes.
void MainWindow::openImport()
{
	auto *dlg = new QDialog(this);
	dlg->setAttribute(Qt::WA_DeleteOnClose);
	dlg->setWindowTitle(QStringLiteral("Import Meld session"));
	dlg->resize(520, 420);
	auto *v = new QVBoxLayout(dlg);
	auto *info = new QLabel(QStringLiteral("Importing and checking against the host..."), dlg);
	info->setWordWrap(true);
	auto *counts = new QListWidget(dlg);
	auto *skip = new QCheckBox(QStringLiteral("Skip the items the host cannot show (missing files or devices)"), dlg);
	skip->setVisible(false);
	auto *load = new QPushButton(QStringLiteral("Load into the studio"), dlg);
	load->setEnabled(false);
	v->addWidget(info);
	v->addWidget(counts, 1);
	v->addWidget(skip);
	v->addWidget(load);
	QPointer<QDialog> guard(dlg);
	connect(load, &QPushButton::clicked, dlg, [this, dlg, skip]() {
		QJsonObject b;
		if (skip->isVisible() && skip->isChecked())
			b.insert(QStringLiteral("skipUnavailable"), true);
		dlg->close();
		api_->post(QStringLiteral("ui/api/project/load"), b, [this](bool ok, const QJsonObject &r, const QString &err) {
			if (!ok)
				return note(QStringLiteral("Not loaded: ") + err);
			if (r.value(QStringLiteral("verdict")).toString() == QStringLiteral("confirm"))
				confirm(r.value(QStringLiteral("pending")).toObject());
		});
	});
	api_->post(QStringLiteral("ui/api/project/import-meld"), {}, [=](bool ok, const QJsonObject &r, const QString &err) {
		if (!guard)
			return;
		if (!ok)
			return info->setText(err.startsWith(QStringLiteral("HTTP 503"))
						 ? QStringLiteral("No Meld session file is configured (set UJWALAM_MELD_SESSION or paths.meld_session in the local profile).")
						 : QStringLiteral("Import failed: ") + err);
		const QJsonObject imp = r.value(QStringLiteral("imported")).toObject();
		const QJsonObject plan = r.value(QStringLiteral("plan")).toObject();
		QStringList bits{QStringLiteral("Created a new project file (%1).").arg(imp.value(QStringLiteral("file")).toString())};
		if (imp.value(QStringLiteral("skipped")).toInt() > 0)
			bits << QStringLiteral("%1 item(s) skipped by the importer.").arg(imp.value(QStringLiteral("skipped")).toInt());
		if (r.contains(QStringLiteral("planError")) && !r.value(QStringLiteral("planError")).isNull())
			bits << QStringLiteral("Host check failed (%1).").arg(r.value(QStringLiteral("planError")).toString());
		info->setText(bits.join(QLatin1Char(' ')));
		const auto add = [counts](const QString &prefix, const QJsonObject &o) {
			for (auto k = o.begin(); k != o.end(); ++k)
				if (k.value().isDouble() || k.value().isBool())
					counts->addItem(prefix + k.key() + QStringLiteral(": ") + k.value().toVariant().toString());
		};
		add(QStringLiteral("imported "), imp.value(QStringLiteral("counts")).toObject());
		add(QStringLiteral("skipped "), imp.value(QStringLiteral("skippedByKind")).toObject());
		add(QStringLiteral("plan "), plan);
		skip->setVisible(plan.value(QStringLiteral("unavailable")).toInt() > 0);
		load->setEnabled(!plan.isEmpty());
	});
	dlg->show();
}

// Posts (P16a, flag posting): the browser page's review form. Edit, approve and reject change local files only.
// YouTube upload is private, needs the package approved, a CLI sign-in, and the typed phrase in the request;
// the server refuses it while live. The clip itself is watched from its folder (Open folder).
void MainWindow::openPosts()
{
	auto *dlg = new QDialog(this);
	dlg->setAttribute(Qt::WA_DeleteOnClose);
	dlg->setWindowTitle(QStringLiteral("Posts"));
	dlg->resize(760, 620);
	auto *v = new QVBoxLayout(dlg);
	auto *info = new QLabel(QStringLiteral("Loading..."), dlg);
	info->setWordWrap(true);
	auto *autoInfo = new QLabel(dlg);
	autoInfo->setWordWrap(true);
	autoInfo->setTextInteractionFlags(Qt::TextSelectableByMouse);
	auto *previewB = new QPushButton(QStringLiteral("Preview auto-post rules"), dlg);
	auto *previewInfo = new QLabel(dlg);
	previewInfo->setWordWrap(true);
	previewInfo->setTextInteractionFlags(Qt::TextSelectableByMouse);
	previewInfo->setVisible(false);
	auto *queueInfo = new QLabel(dlg);
	queueInfo->setWordWrap(true);
	auto *list = new QListWidget(dlg);
	list->setMaximumHeight(170);
	auto *form = new QWidget(dlg);
	auto *ff = new QFormLayout(form);
	ff->setContentsMargins(0, 0, 0, 0);
	auto *meta = new QLabel(form);
	meta->setWordWrap(true);
	auto *limits = new QLabel(form);
	limits->setWordWrap(true);
	auto *title = new QLineEdit(form);
	auto *desc = new QPlainTextEdit(form);
	auto *tags = new QLineEdit(form);
	auto *hash = new QLineEdit(form);
	tags->setPlaceholderText(QStringLiteral("comma separated"));
	hash->setPlaceholderText(QStringLiteral("comma separated"));
	auto *row = new QHBoxLayout();
	auto *saveB = new QPushButton(QStringLiteral("Save"), form);
	auto *approveB = new QPushButton(QStringLiteral("Approve"), form);
	auto *rejectB = new QPushButton(QStringLiteral("Reject"), form);
	auto *openB = new QPushButton(QStringLiteral("Open folder"), form);
	for (QPushButton *b : {saveB, approveB, rejectB, openB})
		row->addWidget(b);
	// D301 upload queue of the auto-post chain: state, plain reason, link when uploaded, "Retry now" for a failed or waiting item.
	auto *qBox = new QGroupBox(QStringLiteral("Auto-upload queue"), form);
	auto *qv = new QVBoxLayout(qBox);
	auto *queueSel = new QLabel(qBox);
	queueSel->setWordWrap(true);
	queueSel->setTextInteractionFlags(Qt::TextSelectableByMouse);
	auto *retryB = new QPushButton(QStringLiteral("Retry now"), qBox);
	qv->addWidget(queueSel);
	qv->addWidget(retryB, 0, Qt::AlignLeft);
	auto *yt = new QGroupBox(QStringLiteral("YouTube (private upload)"), form);
	auto *yv = new QVBoxLayout(yt);
	auto *ytInfo = new QLabel(yt);
	ytInfo->setWordWrap(true);
	auto *ytConfirm = new QLineEdit(yt);
	auto *yrow = new QHBoxLayout();
	auto *upB = new QPushButton(QStringLiteral("Upload as private"), yt);
	auto *chkB = new QPushButton(QStringLiteral("Check status"), yt);
	yrow->addWidget(ytConfirm, 1);
	yrow->addWidget(upB);
	yrow->addWidget(chkB);
	yv->addWidget(ytInfo);
	yv->addLayout(yrow);
	ff->addRow(meta);
	ff->addRow(limits);
	ff->addRow(QStringLiteral("Title"), title);
	ff->addRow(QStringLiteral("Description"), desc);
	ff->addRow(QStringLiteral("Tags"), tags);
	ff->addRow(QStringLiteral("Hashtags"), hash);
	ff->addRow(row);
	ff->addRow(qBox);
	ff->addRow(yt);
	form->setVisible(false);
	v->addWidget(info);
	v->addWidget(autoInfo);
	v->addWidget(previewB, 0, Qt::AlignLeft);
	v->addWidget(previewInfo);
	v->addWidget(queueInfo);
	v->addWidget(list);
	v->addWidget(form, 1);

	struct State {
		QJsonArray posts;
		QString sel;
		bool signedIn = false, busy = false;
		QString phrase = QStringLiteral("yes, upload");
	};
	auto st = std::make_shared<State>();
	QPointer<QDialog> guard(dlg);
	const auto selPost = [st]() {
		for (const auto &x : st->posts)
			if (x.toObject().value(QStringLiteral("id")).toString() == st->sel)
				return x.toObject();
		return QJsonObject();
	};
	const auto join = [](const QJsonArray &a) {
		QStringList out;
		for (const auto &x : a)
			out << x.toString();
		return out.join(QStringLiteral(", "));
	};
	const auto csv = [](const QString &s) {
		QJsonArray out;
		for (const QString &x : s.split(QLatin1Char(',')))
			if (!x.trimmed().isEmpty())
				out.append(x.trimmed());
		return out;
	};
	const auto renderQueue = [=]() {
		const QJsonObject p = selPost();
		const QString qs = p.value(QStringLiteral("queueState")).toString();
		qBox->setVisible(!qs.isEmpty());
		if (qs.isEmpty())
			return;
		QStringList bits;
		bits << (qs == QStringLiteral("queued") ? QStringLiteral("waiting") : qs == QStringLiteral("done") ? QStringLiteral("uploaded") : qs);
		if (!p.value(QStringLiteral("queueReasonText")).toString().isEmpty())
			bits << p.value(QStringLiteral("queueReasonText")).toString();
		if (qs == QStringLiteral("queued") && !p.value(QStringLiteral("queueNextAt")).toString().isEmpty())
			bits << QStringLiteral("next try ") + QDateTime::fromString(p.value(QStringLiteral("queueNextAt")).toString(), Qt::ISODate).toLocalTime().toString(Qt::TextDate);
		if (!p.value(QStringLiteral("queuePublishAt")).toString().isEmpty()) // post-schedule (D310 proposed)
			bits << (qs == QStringLiteral("done") ? QStringLiteral("goes public ") : QStringLiteral("will go public ")) +
					QDateTime::fromString(p.value(QStringLiteral("queuePublishAt")).toString(), Qt::ISODate).toLocalTime().toString(Qt::TextDate);
		if (!p.value(QStringLiteral("videoUrl")).toString().isEmpty())
			bits << QStringLiteral("link (private): ") + p.value(QStringLiteral("videoUrl")).toString();
		queueSel->setText(bits.join(QStringLiteral(". ")) + QLatin1Char('.'));
		retryB->setVisible(qs == QStringLiteral("failed") || (qs == QStringLiteral("queued") && !p.value(QStringLiteral("queueReasonText")).toString().isEmpty()));
		retryB->setEnabled(!st->busy);
	};
	const auto renderYt = [=]() {
		const QJsonObject p = selPost();
		const bool isYt = p.value(QStringLiteral("target")).toString().startsWith(QStringLiteral("youtube"));
		yt->setVisible(isYt);
		if (!isYt)
			return;
		const QString status = p.value(QStringLiteral("status")).toString();
		const bool uploaded = status == QStringLiteral("uploaded");
		ytInfo->setText(uploaded ? QStringLiteral("Uploaded as private video %1. Use Check status to see if YouTube finished processing.").arg(p.value(QStringLiteral("videoId")).toString(QStringLiteral("?")))
				: !st->signedIn ? QStringLiteral("Not signed in. Run in a terminal: node services/posting/cli.mjs youtube signin")
				: status == QStringLiteral("approved") ? QStringLiteral("Approved. Ready to upload as private. Type: %1").arg(st->phrase)
								       : QStringLiteral("Approve the package first."));
		ytConfirm->setPlaceholderText(st->phrase);
		upB->setEnabled(!st->busy && !uploaded && st->signedIn && status == QStringLiteral("approved"));
		chkB->setEnabled(!st->busy && uploaded);
		ytConfirm->setEnabled(!uploaded);
	};
	const auto fill = [=]() {
		const QJsonObject p = selPost();
		form->setVisible(!p.isEmpty());
		if (p.isEmpty())
			return;
		meta->setText(QStringLiteral("%1  %2  %3-%4 s  privacy %5  status %6")
				      .arg(p.value(QStringLiteral("target")).toString(), p.value(QStringLiteral("layout")).toString(),
					   p.value(QStringLiteral("startSec")).toVariant().toString(), p.value(QStringLiteral("endSec")).toVariant().toString(),
					   p.value(QStringLiteral("privacy")).toString(), p.value(QStringLiteral("status")).toString()));
		title->setText(p.value(QStringLiteral("title")).toString());
		desc->setPlainText(p.value(QStringLiteral("description")).toString());
		tags->setText(join(p.value(QStringLiteral("tags")).toArray()));
		hash->setText(join(p.value(QStringLiteral("hashtags")).toArray()));
		const QJsonObject lim = p.value(QStringLiteral("limits")).toObject();
		QStringList bits;
		for (const auto &x : lim.value(QStringLiteral("checks")).toArray()) {
			const QJsonObject c = x.toObject();
			bits << QStringLiteral("%1 %2/%3%4%5").arg(c.value(QStringLiteral("field")).toString(), c.value(QStringLiteral("value")).toVariant().toString(),
								 c.value(QStringLiteral("max")).toVariant().toString(),
								 c.value(QStringLiteral("unit")).toString().isEmpty() ? QString() : QStringLiteral(" ") + c.value(QStringLiteral("unit")).toString(),
								 c.value(QStringLiteral("ok")).toBool() ? QString() : QStringLiteral(" OVER"));
		}
		const QJsonArray un = p.value(QStringLiteral("unresolved")).toArray();
		if (!un.isEmpty())
			bits << QStringLiteral("unresolved: ") + join(un);
		limits->setText((bits.isEmpty() ? QStringLiteral("no limits checked") : bits.join(QStringLiteral("  "))) +
				(lim.value(QStringLiteral("status")).toString() == QStringLiteral("unverified") ? QStringLiteral("  (limits UNVERIFIED)") : QString()));
		renderQueue();
		renderYt();
	};
	const auto render = [=]() {
		const QSignalBlocker block(list);
		list->clear();
		for (const auto &x : st->posts) {
			const QJsonObject p = x.toObject();
			const bool flagged = (p.value(QStringLiteral("limits")).toObject().value(QStringLiteral("ok")) == QJsonValue(false)) ||
					     !p.value(QStringLiteral("unresolved")).toArray().isEmpty();
			auto *it = new QListWidgetItem(p.value(QStringLiteral("clipId")).toString() + QStringLiteral("  ") + p.value(QStringLiteral("target")).toString() +
							 QStringLiteral("   ") + p.value(QStringLiteral("status")).toString() + (flagged ? QStringLiteral(" / check") : QString()) +
							 (p.value(QStringLiteral("queueState")).toString().isEmpty() ? QString() : QStringLiteral(" / ") + p.value(QStringLiteral("queueState")).toString()),
						 list);
			it->setData(Qt::UserRole, p.value(QStringLiteral("id")).toString());
			if (p.value(QStringLiteral("id")).toString() == st->sel)
				list->setCurrentItem(it);
		}
		info->setText(st->posts.isEmpty() ? QStringLiteral("No packages yet. Make them with services/posting/cli.mjs after a stream.")
						   : QStringLiteral("%1 package(s). Private drafts only; approving marks a package. Upload to YouTube is separate and needs a typed confirmation.").arg(st->posts.size()));
		fill();
	};
	const auto reload = [=]() {
		api_->get(QStringLiteral("ui/api/posts"), [=](bool ok, const QJsonObject &r, const QString &err) {
			if (!guard)
				return;
			if (!ok)
				return info->setText(QStringLiteral("Posts unavailable: ") + err);
			st->posts = r.value(QStringLiteral("posts")).toArray();
			const QJsonObject q = r.value(QStringLiteral("queue")).toObject();
			queueInfo->setText(q.isEmpty() ? QString()
						       : QStringLiteral("Upload queue: %1 waiting, %2 uploading, %3 done, %4 failed. %5")
								 .arg(q.value(QStringLiteral("queued")).toInt())
								 .arg(q.value(QStringLiteral("uploading")).toInt())
								 .arg(q.value(QStringLiteral("done")).toInt())
								 .arg(q.value(QStringLiteral("failed")).toInt())
								 .arg(q.value(QStringLiteral("message")).toString()));
			render();
		});
	};
	connect(list, &QListWidget::currentItemChanged, dlg, [=](QListWidgetItem *it) {
		st->sel = it ? it->data(Qt::UserRole).toString() : QString();
		ytConfirm->clear();
		fill();
	});
	// Edit / approve / reject: local files only; the reply carries the updated package.
	const auto postAction = [=](const QString &route, const QJsonObject &body) {
		api_->post(route, body, [=](bool ok, const QJsonObject &r, const QString &err) {
			if (!guard)
				return;
			if (!ok)
				return info->setText(QStringLiteral("Not done: ") + err);
			const QJsonObject np = r.value(QStringLiteral("post")).toObject();
			for (int i = 0; i < st->posts.size(); i++)
				if (st->posts.at(i).toObject().value(QStringLiteral("id")) == np.value(QStringLiteral("id")))
					st->posts.replace(i, np);
			render();
			info->setText(QStringLiteral("Saved."));
		});
	};
	connect(saveB, &QPushButton::clicked, dlg, [=]() {
		QJsonObject b;
		b.insert(QStringLiteral("id"), st->sel);
		b.insert(QStringLiteral("title"), title->text());
		b.insert(QStringLiteral("description"), desc->toPlainText());
		b.insert(QStringLiteral("tags"), csv(tags->text()));
		b.insert(QStringLiteral("hashtags"), csv(hash->text()));
		postAction(QStringLiteral("ui/api/posts/edit"), b);
	});
	for (const auto &[btn, status] : {std::pair{approveB, "approved"}, std::pair{rejectB, "rejected"}}) {
		const QString s = QString::fromLatin1(status);
		connect(btn, &QPushButton::clicked, dlg, [=]() {
			QJsonObject b;
			b.insert(QStringLiteral("id"), st->sel);
			b.insert(QStringLiteral("status"), s);
			postAction(QStringLiteral("ui/api/posts/status"), b);
		});
	}
	connect(openB, &QPushButton::clicked, dlg, [=]() {
		QJsonObject b;
		b.insert(QStringLiteral("id"), st->sel);
		api_->post(QStringLiteral("ui/api/posts/open"), b, [=](bool ok, const QJsonObject &, const QString &err) {
			if (guard && !ok)
				info->setText(QStringLiteral("Could not open the folder: ") + err);
		});
	});
	// Upload / check: one call at a time; the list is re-read afterwards (status and video id come from the server).
	const auto ytAction = [=](bool upload) {
		if (st->busy || st->sel.isEmpty())
			return;
		st->busy = true;
		renderYt();
		QJsonObject b;
		b.insert(QStringLiteral("id"), st->sel);
		if (upload)
			b.insert(QStringLiteral("confirm"), ytConfirm->text());
		info->setText(upload ? QStringLiteral("Uploading... this can take a while. Keep this window open.") : QStringLiteral("Checking..."));
		api_->post(upload ? QStringLiteral("ui/api/posts/youtube/upload") : QStringLiteral("ui/api/posts/youtube/check"), b,
			   [=](bool ok, const QJsonObject &r, const QString &err) {
				   if (!guard)
					   return;
				   st->busy = false;
				   if (!ok)
					   info->setText(QStringLiteral("Not done: ") + err);
				   else if (upload) {
					   ytConfirm->clear();
					   info->setText(QStringLiteral("Uploaded as private video %1.").arg(r.value(QStringLiteral("videoId")).toString()));
				   } else
					   info->setText(QStringLiteral("Video %1: %2").arg(r.value(QStringLiteral("videoId")).toString(),
										      r.value(QStringLiteral("found")).toBool()
											      ? QStringLiteral("upload %1, processing %2, privacy %3")
													.arg(r.value(QStringLiteral("uploadStatus")).toString(QStringLiteral("?")),
													     r.value(QStringLiteral("processingStatus")).toString(QStringLiteral("?")),
													     r.value(QStringLiteral("privacyStatus")).toString(QStringLiteral("?")))
											      : QStringLiteral("not found")));
				   reload();
			   });
	};
	connect(retryB, &QPushButton::clicked, dlg, [=]() {
		if (st->busy || st->sel.isEmpty())
			return;
		QJsonObject b;
		b.insert(QStringLiteral("id"), st->sel);
		api_->post(QStringLiteral("ui/api/posts/queue/retry"), b, [=](bool ok, const QJsonObject &, const QString &err) {
			if (!guard)
				return;
			info->setText(ok ? QStringLiteral("Queued again. It uploads at the next check if no stream is live.") : QStringLiteral("Not done: ") + err);
			reload();
		});
	});
	connect(upB, &QPushButton::clicked, dlg, [=]() { ytAction(true); });
	connect(chkB, &QPushButton::clicked, dlg, [=]() { ytAction(false); });
	// Auto-post mode (F7): read-only line.
	api_->get(QStringLiteral("ui/api/posts/auto"), [=](bool ok, const QJsonObject &r, const QString &) {
		if (!guard || !ok)
			return;
		const QJsonObject m = r.value(QStringLiteral("mode")).toObject();
		const QString rf = r.value(QStringLiteral("rulesFile")).toString();
		autoInfo->setText(QStringLiteral("Auto-post: %1, %2 rule(s), %3. %4 planned action(s).%5")
					  .arg(m.value(QStringLiteral("enabled")).toBool() ? QStringLiteral("ON") : QStringLiteral("off (review-first)"))
					  .arg(m.value(QStringLiteral("ruleCount")).toInt())
					  .arg(m.value(QStringLiteral("autoUpload")).toBool() ? QStringLiteral("approve and upload (private)") : QStringLiteral("approve only"))
					  .arg(r.value(QStringLiteral("plan")).toArray().size())
					  .arg(rf.isEmpty() ? QString() : QStringLiteral("\nRules file: ") + rf));
	});
	// Read-only dry run: what the rules would queue and skip. Nothing is written or sent.
	connect(previewB, &QPushButton::clicked, dlg, [=]() {
		previewInfo->setVisible(true);
		previewInfo->setText(QStringLiteral("Checking..."));
		api_->get(QStringLiteral("ui/api/posts/auto/preview"), [=](bool ok, const QJsonObject &r, const QString &err) {
			if (!guard)
				return;
			if (!ok || r.contains(QStringLiteral("error"))) {
				previewInfo->setText(QStringLiteral("Preview unavailable.") + (ok ? QString() : QStringLiteral(" ") + err));
				return;
			}
			const QJsonArray q = r.value(QStringLiteral("queued")).toArray();
			const QJsonArray sk = r.value(QStringLiteral("skipped")).toArray();
			constexpr int kMax = 12;
			QStringList L;
			const QString rf = r.value(QStringLiteral("rulesFile")).toString();
			if (!rf.isEmpty())
				L << QStringLiteral("Rules file: ") + rf;
			L << QStringLiteral("Dry run: %1 would be queued, %2 skipped. Nothing is written or sent.").arg(q.size()).arg(sk.size());
			const QString blocked = r.value(QStringLiteral("blocked")).toString();
			if (!blocked.isEmpty())
				L << QStringLiteral("A stream looks live (%1): a run would be refused.").arg(blocked);
			int n = 0;
			for (const auto &x : q) {
				if (n++ >= kMax) {
					L << QStringLiteral("  ... and %1 more").arg(q.size() - kMax);
					break;
				}
				const QJsonObject o = x.toObject();
				QStringList acts;
				for (const auto &a : o.value(QStringLiteral("actions")).toArray())
					acts << a.toString();
				QString line = QStringLiteral("  would %1: %2 to %3 (rule %4) %5").arg(acts.join(QStringLiteral(" + ")), o.value(QStringLiteral("kind")).toString(QStringLiteral("?")), o.value(QStringLiteral("target")).toString(QStringLiteral("-")), o.value(QStringLiteral("ruleId")).toString(), o.value(QStringLiteral("id")).toString());
				if (o.value(QStringLiteral("publishAt")).isString())
					line += QStringLiteral(", goes public about ") + o.value(QStringLiteral("publishAt")).toString();
				else if (o.value(QStringLiteral("publishNote")).toString() == QStringLiteral("beyond-cap"))
					line += QStringLiteral(", waits: public time too far ahead");
				L << line;
			}
			n = 0;
			for (const auto &x : sk) {
				if (n++ >= kMax) {
					L << QStringLiteral("  ... and %1 more skipped").arg(sk.size() - kMax);
					break;
				}
				const QJsonObject o = x.toObject();
				const QString d = o.value(QStringLiteral("detail")).toString();
				L << QStringLiteral("  skip %1 %2 %3: %4%5").arg(o.value(QStringLiteral("kind")).toString(QStringLiteral("?")), o.value(QStringLiteral("target")).toString(QStringLiteral("-")), o.value(QStringLiteral("id")).toString(), o.value(QStringLiteral("reason")).toString(), d.isEmpty() ? QString() : QStringLiteral(" (") + d + QStringLiteral(")"));
			}
			previewInfo->setText(L.join(QLatin1Char('\n')));
		});
	});
	api_->get(QStringLiteral("ui/api/posts/youtube/status"), [=](bool ok, const QJsonObject &r, const QString &) {
		if (!guard)
			return;
		st->signedIn = ok && r.value(QStringLiteral("signedIn")).toBool();
		if (ok && r.value(QStringLiteral("phrase")).isString())
			st->phrase = r.value(QStringLiteral("phrase")).toString();
		renderYt();
	});
	reload();
	dlg->show();
}

// Report (D199): the server builds and redacts the link; only an https github.com link is opened, in the user's
// browser, where the user reviews it before submitting. Nothing is sent from here.
void MainWindow::report()
{
	bool ok = false;
	const QString title = QInputDialog::getText(this, QStringLiteral("Report a problem"), QStringLiteral("Title"), QLineEdit::Normal, QString(), &ok);
	if (!ok)
		return;
	const QString text = QInputDialog::getMultiLineText(this, QStringLiteral("Report a problem"), QStringLiteral("What happened"), QString(), &ok);
	if (!ok)
		return;
	QUrlQuery q;
	q.addQueryItem(QStringLiteral("title"), title.left(120)); // report.mjs MAX_TITLE / MAX_NOTE
	q.addQueryItem(QStringLiteral("note"), text.left(1500));
	api_->get(QStringLiteral("ui/api/report-url?") + q.toString(QUrl::FullyEncoded), [this](bool ok2, const QJsonObject &r, const QString &err) {
		if (!ok2)
			return note(QStringLiteral("Report failed: ") + err);
		if (!r.value(QStringLiteral("configured")).toBool())
			return note(r.value(QStringLiteral("message")).toString(QStringLiteral("Report: set links.issues_url in the profile")));
		const QUrl u(r.value(QStringLiteral("url")).toString(), QUrl::StrictMode);
		if (!u.isValid() || u.scheme() != QStringLiteral("https") || u.host() != QStringLiteral("github.com"))
			return note(QStringLiteral("Report: the link was refused"));
		if (!QDesktopServices::openUrl(u))
			return note(QStringLiteral("Report: no browser opened the link"));
		note((r.value(QStringLiteral("truncated")).toBool() ? QStringLiteral("Shortened to fit: attach the diag bundle. ") : QString()) +
		     QStringLiteral("Review it in your browser, then submit."));
	});
}

// Feedback notes (D150): pick a moment, write a note with tag and severity, Save. Notes stay in the gitignored
// feedback folder; the server checks every field.
void MainWindow::openFeedback()
{
	auto *dlg = new QDialog(this);
	dlg->setAttribute(Qt::WA_DeleteOnClose);
	dlg->setWindowTitle(QStringLiteral("Feedback notes"));
	dlg->resize(560, 460);
	auto *v = new QVBoxLayout(dlg);
	auto *info = new QLabel(QStringLiteral("Loading..."), dlg);
	info->setWordWrap(true);
	auto *list = new QListWidget(dlg);
	auto *meta = new QLabel(dlg);
	meta->setWordWrap(true);
	auto *text = new QPlainTextEdit(dlg);
	text->setPlaceholderText(QStringLiteral("What happened (up to 2000 characters)"));
	auto *tag = new QComboBox(dlg);
	for (const char *t : {"bug", "annoying", "wish", "works-well"})
		tag->addItem(QString::fromLatin1(t));
	auto *sev = new QComboBox(dlg);
	for (const char *s : {"high", "medium", "low"})
		sev->addItem(QString::fromLatin1(s));
	auto *save = new QPushButton(QStringLiteral("Save note"), dlg);
	auto *form = new QWidget(dlg);
	auto *ff = new QFormLayout(form);
	ff->setContentsMargins(0, 0, 0, 0);
	ff->addRow(meta);
	ff->addRow(QStringLiteral("Note"), text);
	ff->addRow(QStringLiteral("Tag"), tag);
	ff->addRow(QStringLiteral("Severity"), sev);
	ff->addRow(save);
	form->setVisible(false);
	v->addWidget(info);
	v->addWidget(list, 1);
	v->addWidget(form);
	auto moments = std::make_shared<QJsonArray>();
	auto render = [list, info, moments]() {
		const QString sel = list->currentItem() ? list->currentItem()->data(Qt::UserRole).toString() : QString();
		const QSignalBlocker block(list);
		list->clear();
		for (const auto &x : *moments) {
			const QJsonObject m = x.toObject(), n = m.value(QStringLiteral("note")).toObject();
			const QString id = m.value(QStringLiteral("id")).toString();
			const QString t = n.value(QStringLiteral("tag")).toString();
			auto *it = new QListWidgetItem(id + QStringLiteral("  ") + m.value(QStringLiteral("scene")).toString() + QStringLiteral("   ") +
							 (t.isEmpty() ? QStringLiteral("no note") : t + QStringLiteral("/") + n.value(QStringLiteral("severity")).toString(QStringLiteral("-"))),
						 list);
			it->setData(Qt::UserRole, id);
			if (id == sel)
				list->setCurrentItem(it);
		}
		info->setText(moments->isEmpty() ? QStringLiteral("No feedback moments yet. Press the feedback hotkey while streaming.")
						: QStringLiteral("%1 moment(s). Pick one to add a note.").arg(moments->size()));
	};
	connect(list, &QListWidget::currentItemChanged, dlg, [=](QListWidgetItem *it) {
		form->setVisible(it != nullptr);
		if (!it)
			return;
		for (const auto &x : *moments) {
			const QJsonObject m = x.toObject();
			if (m.value(QStringLiteral("id")).toString() != it->data(Qt::UserRole).toString())
				continue;
			QStringList stats;
			const QJsonObject s = m.value(QStringLiteral("stats")).toObject();
			for (auto k = s.begin(); k != s.end(); ++k)
				stats << k.key() + QStringLiteral("=") + k.value().toVariant().toString();
			const QJsonValue ts = m.value(QStringLiteral("timestamp"));
			meta->setText((ts.isNull() || ts.isUndefined() ? QString() : ts.toVariant().toString() + QStringLiteral("  ")) +
				      m.value(QStringLiteral("scene")).toString() + QStringLiteral("  ") + stats.join(QLatin1Char(' ')));
			const QJsonObject n = m.value(QStringLiteral("note")).toObject();
			text->setPlainText(n.value(QStringLiteral("text")).toString());
			tag->setCurrentText(n.value(QStringLiteral("tag")).toString(QStringLiteral("bug")));
			sev->setCurrentText(n.value(QStringLiteral("severity")).toString(QStringLiteral("medium")));
		}
	});
	QPointer<QDialog> guard(dlg);
	connect(save, &QPushButton::clicked, dlg, [=]() {
		if (!list->currentItem())
			return;
		if (text->toPlainText().size() > 2000)
			return info->setText(QStringLiteral("The note is over 2000 characters."));
		QJsonObject b;
		b.insert(QStringLiteral("id"), list->currentItem()->data(Qt::UserRole).toString());
		b.insert(QStringLiteral("text"), text->toPlainText());
		b.insert(QStringLiteral("tag"), tag->currentText());
		b.insert(QStringLiteral("severity"), sev->currentText());
		api_->post(QStringLiteral("ui/api/feedback/note"), b, [=](bool ok, const QJsonObject &r, const QString &err) {
			if (!guard)
				return; // closed meanwhile
			if (!ok)
				return info->setText(QStringLiteral("Save failed: ") + err);
			*moments = r.value(QStringLiteral("moments")).toArray();
			render();
			info->setText(QStringLiteral("Saved."));
		});
	});
	api_->get(QStringLiteral("ui/api/feedback"), [=](bool ok, const QJsonObject &r, const QString &err) {
		if (!guard)
			return;
		if (!ok)
			return info->setText(QStringLiteral("Feedback unavailable: ") + err);
		*moments = r.value(QStringLiteral("moments")).toArray();
		render();
	});
	dlg->show();
}

void MainWindow::botAction(const QString &bot, bool start)
{
	QJsonObject b;
	b.insert(QStringLiteral("bot"), bot);
	api_->post(start ? QStringLiteral("ui/api/bots/start") : QStringLiteral("ui/api/bots/stop"), b, [this](bool ok, const QJsonObject &r, const QString &err) {
		if (!ok)
			return note(QStringLiteral("Not done: ") + err);
		if (r.value(QStringLiteral("verdict")).toString() == QStringLiteral("confirm"))
			confirm(r.value(QStringLiteral("pending")).toObject());
	});
}

void MainWindow::loadStructure()
{
	api_->get(QStringLiteral("ui/api/project/structure"), [this](bool ok, const QJsonObject &b, const QString &err) {
		if (!ok)
			return note(QStringLiteral("Scene editing unavailable: ") + err);
		structure_ = b;
		if (!b.value(QStringLiteral("available")).toBool())
			note(QStringLiteral("Scene editing needs a loaded project file."));
		renderAddPick();
	});
}

// The second field of the add-layer row: a list from the project (layers, devices, overlays, assets) or free text.
void MainWindow::renderAddPick()
{
	const QString kind = addKind_->currentData().toString();
	const bool typed = kind == QStringLiteral("color") || kind == QStringLiteral("text");
	addText_->setVisible(typed);
	addPick_->setVisible(!typed);
	addText_->setPlaceholderText(kind == QStringLiteral("color") ? QStringLiteral("#RRGGBB") : QStringLiteral("Text"));
	addPick_->clear();
	for (const auto &c : addui::addChoices(structure_, kind))
		addPick_->addItem(c.first, c.second);
}

// Add-layer window (D274, D292): the kinds on the left with what each one is (a kind the project cannot supply is
// greyed), on the right a searchable list of what it can be made from (or a text / colour field). The window only builds
// the layer.add body; the same structure route as the old row sends it. Adding needs no flag, only "not live". The
// choices are read fresh each time (new assets, devices). User-opened only; fades in and out with the motion setting.
void MainWindow::openAddLayer(const QString &sceneId)
{
	if (live_)
		return note(QStringLiteral("Not while live."));
	if (addDlg_)
		return;
	const QString scene = sceneId.isEmpty() ? activeScene_ : sceneId;
	if (scene.isEmpty())
		return note(QStringLiteral("Pick a scene first."));
	QString name = scene;
	for (const auto &x : scenes_)
		if (x.toObject().value(QStringLiteral("id")).toString() == scene)
			name = x.toObject().value(QStringLiteral("name")).toString(scene);
	api_->get(QStringLiteral("ui/api/project/structure"), [this, scene, name](bool ok, const QJsonObject &b, const QString &err) {
		if (!ok)
			return note(QStringLiteral("Cannot add a layer: ") + err);
		if (!b.value(QStringLiteral("available")).toBool())
			return note(QStringLiteral("Adding needs a loaded project file."));
		structure_ = b;
		if (addDlg_)
			return;
		auto *dlg = new addui::AddLayerDialog(b, scene, name, this);
		addDlg_ = dlg;
		connect(dlg, &addui::AddLayerDialog::chosen, this, [this](const QJsonObject &body) { structureEdit(body); });
		dlg->show();
	});
}

// Add-scene window: a name; the scene is made on every canvas of the project.
void MainWindow::openAddScene()
{
	if (live_)
		return note(QStringLiteral("Not while live."));
	if (addDlg_)
		return;
	api_->get(QStringLiteral("ui/api/project/structure"), [this](bool ok, const QJsonObject &b, const QString &err) {
		if (!ok)
			return note(QStringLiteral("Cannot add a scene: ") + err);
		if (!b.value(QStringLiteral("available")).toBool())
			return note(QStringLiteral("Adding needs a loaded project file."));
		if (addDlg_)
			return;
		QStringList canvases;
		for (const auto &c : b.value(QStringLiteral("canvases")).toArray())
			canvases << c.toString();
		auto *dlg = new addui::AddSceneDialog(canvases, this);
		addDlg_ = dlg;
		connect(dlg, &addui::AddSceneDialog::chosen, this, [this](const QJsonObject &body) { structureEdit(body); });
		dlg->show();
	});
}

// The + buttons above the scene and layer lists follow the live lock.
void MainWindow::updateAddButtons()
{
	if (!addSceneBtn_ || !addLayerBtn_)
		return;
	addSceneBtn_->setEnabled(!live_);
	addLayerBtn_->setEnabled(!live_);
	addSceneBtn_->setToolTip(live_ ? QStringLiteral("Not while live") : QStringLiteral("Add scene"));
	addLayerBtn_->setToolTip(live_ ? QStringLiteral("Not while live") : QStringLiteral("Add layer"));
	if (delLayerBtn_) { // D330: delete follows the same lock
		delLayerBtn_->setEnabled(!live_);
		delLayerBtn_->setToolTip(live_ ? QStringLiteral("Not while live") : QStringLiteral("Delete the selected layer (Del). Asks first."));
	}
}

// ---- Right-click menus and keys on the layer and scene lists (D292) ----

namespace {
// What the UI server's short error codes mean, in plain words.
QString plainStructureError(const QString &code)
{
	static const QHash<QString, QString> words = {
		{QStringLiteral("live-locked"), QStringLiteral("Not while live.")},
		{QStringLiteral("scene-edit-off"), QStringLiteral("Turn on scene editing in Settings > Advanced first.")},
		{QStringLiteral("scene-active"), QStringLiteral("That scene is the one the project starts with; make another scene the start scene first.")},
		{QStringLiteral("last-scene"), QStringLiteral("The last scene cannot be deleted.")},
		{QStringLiteral("layer-copied"), QStringLiteral("Another layer shows this one; delete that copy first.")},
		{QStringLiteral("layer-has-audio"), QStringLiteral("Its sound is in the mixer, so it cannot be deleted here.")},
		{QStringLiteral("bad-name"), QStringLiteral("Type a name of 1 to 80 characters.")},
		{QStringLiteral("no-project-file"), QStringLiteral("No project file is open, so nothing can be saved.")},
		{QStringLiteral("too-many-layers"), QStringLiteral("This scene has the most layers it can hold.")},
		{QStringLiteral("too-many-scenes"), QStringLiteral("The project has the most scenes it can hold.")},
		{QStringLiteral("host-unavailable"), QStringLiteral("The studio host is not reachable.")},
	};
	return words.value(code, code);
}

// One menu item: a real action (objectName = id) so the probe can trigger it, and a record of it for the probe.
void addMenuItem(QMenu *menu, QJsonArray &items, QObject *ctx, const char *id, const QString &text, const QString &keys, bool enabled, const QString &tip,
		 std::function<void()> fn)
{
	QAction *a = menu->addAction(keys.isEmpty() ? text : text + QLatin1Char('\t') + keys);
	a->setObjectName(QString::fromLatin1(id));
	a->setEnabled(enabled);
	a->setToolTip(tip);
	QObject::connect(a, &QAction::triggered, ctx, [fn]() { fn(); });
	QJsonObject o;
	o.insert(QStringLiteral("id"), QString::fromLatin1(id));
	o.insert(QStringLiteral("text"), text);
	o.insert(QStringLiteral("keys"), keys);
	o.insert(QStringLiteral("enabled"), enabled);
	o.insert(QStringLiteral("tip"), tip);
	items.append(o);
}
} // namespace

QString MainWindow::sceneKeyId() const
{
	const QListWidgetItem *it = sceneList_->currentItem();
	return it ? it->data(Qt::UserRole).toString() : QString();
}

QMenu *MainWindow::buildLayerMenu(QWidget *parent, bool blank)
{
	const QJsonObject l = selectedLayer();
	const bool has = !l.isEmpty();
	const bool hasPlacement = has && l.contains(QStringLiteral("placement"));
	int at = -1; // host order: bottom first
	for (int i = 0; i < layers_.size(); i++)
		if (layers_.at(i).toObject().value(QStringLiteral("id")).toString() == selected_)
			at = i;
	const int n = layers_.size();
	auto *menu = new QMenu(parent);
	menu->setToolTipsVisible(true);
	QJsonArray items;
	auto add = [&](const char *id, const QString &text, const QString &keys, bool enabled, const QString &tip, std::function<void()> fn) {
		addMenuItem(menu, items, this, id, text, keys, enabled, tip, fn);
	};
	const QString lockTip = live_ ? QStringLiteral("Not while live") : QString();
	addui::polish(menu);
	add("add", QStringLiteral("Add layer…"), QString(), !live_ && !activeScene_.isEmpty(), lockTip, [this]() { openAddLayer(); });
	if (blank) { // right-click on empty space in the list: only what needs no layer
		lastMenu_ = QJsonObject{{QStringLiteral("kind"), QStringLiteral("layer")}, {QStringLiteral("blank"), true}, {QStringLiteral("items"), items}};
		return menu;
	}
	menu->addSeparator();
	add("duplicate", QStringLiteral("Duplicate"), QStringLiteral("Ctrl+D"), has && !live_, lockTip, [this]() { layerDuplicate(); });
	add("rename", QStringLiteral("Rename…"), QStringLiteral("F2"), has && !live_, lockTip, [this]() { layerRename(); });
	menu->addSeparator();
	add("visible", l.value(QStringLiteral("visible")).toBool() ? QStringLiteral("Hide") : QStringLiteral("Show"), QString(), has, QString(), [this]() { layerToggleVisible(); });
	add("up", QStringLiteral("Move up"), QString(), has && at >= 0 && at < n - 1, QString(), [this, at]() { layerMoveTo(at + 1); });
	add("down", QStringLiteral("Move down"), QString(), has && at > 0, QString(), [this, at]() { layerMoveTo(at - 1); });
	add("top", QStringLiteral("Move to top"), QString(), has && at >= 0 && at < n - 1, QString(), [this, n]() { layerMoveTo(n - 1); });
	add("bottom", QStringLiteral("Move to bottom"), QString(), has && at > 0, QString(), [this]() { layerMoveTo(0); });
	menu->addSeparator();
	add("copylook", QStringLiteral("Copy look"), QStringLiteral("Ctrl+Shift+C"), hasPlacement, QString(), [this]() { lookCopy(); });
	add("pastelook", QStringLiteral("Paste look"), QStringLiteral("Ctrl+Shift+V"), hasPlacement && hasLookClip_,
	    hasLookClip_ ? QString() : QStringLiteral("Copy a look first"), [this]() { lookPaste(); });
	add("look", QStringLiteral("Look…"), QString(), hasPlacement, QString(), [this]() { lookFocus(); });
	menu->addSeparator();
	add("delete", QStringLiteral("Delete…"), QStringLiteral("Del"), has && !live_, lockTip, [this]() { layerDelete(); }); // no flag (D330)
	lastMenu_ = QJsonObject{{QStringLiteral("kind"), QStringLiteral("layer")}, {QStringLiteral("items"), items}};
	return menu;
}

QMenu *MainWindow::buildSceneMenu(QWidget *parent, const QString &sceneId, bool blank)
{
	const bool has = !sceneId.isEmpty();
	const bool active = sceneId == activeScene_;
	auto *menu = new QMenu(parent);
	menu->setToolTipsVisible(true);
	QJsonArray items;
	auto add = [&](const char *id, const QString &text, const QString &keys, bool enabled, const QString &tip, std::function<void()> fn) {
		addMenuItem(menu, items, this, id, text, keys, enabled, tip, fn);
	};
	const QString lockTip = live_ ? QStringLiteral("Not while live") : QString();
	addui::polish(menu);
	add("addscene", QStringLiteral("Add scene…"), QString(), !live_, lockTip, [this]() { openAddScene(); });
	if (blank) {
		lastMenu_ = QJsonObject{{QStringLiteral("kind"), QStringLiteral("scene")}, {QStringLiteral("blank"), true}, {QStringLiteral("items"), items}};
		return menu;
	}
	add("add", QStringLiteral("Add layer…"), QString(), has && !live_, lockTip, [this, sceneId]() { openAddLayer(sceneId); });
	menu->addSeparator();
	add("rename", QStringLiteral("Rename…"), QStringLiteral("F2"), has && !live_, lockTip, [this, sceneId]() { sceneRename(sceneId); });
	add("duplicate", QStringLiteral("Duplicate scene"), QString(), has && !live_, lockTip, [this, sceneId]() { sceneDuplicate(sceneId); });
	menu->addSeparator();
	QString delTip = lockTip;
	if (delTip.isEmpty() && !sceneEditOn_)
		delTip = QStringLiteral("Turn on scene editing in Settings > Advanced");
	else if (delTip.isEmpty() && active)
		delTip = QStringLiteral("Switch to another scene first");
	add("delete", QStringLiteral("Delete…"), QStringLiteral("Del"), has && !live_ && sceneEditOn_ && !active, delTip, [this, sceneId]() { sceneDelete(sceneId); });
	lastMenu_ = QJsonObject{{QStringLiteral("kind"), QStringLiteral("scene")}, {QStringLiteral("items"), items}};
	return menu;
}

void MainWindow::showLayerMenu(const QPoint &pos)
{
	QListWidgetItem *it = layerList_->itemAt(pos);
	if (it)
		layerList_->setCurrentItem(it); // the layer under the pointer
	QMenu *menu = buildLayerMenu(this, !it);
	menu->setAttribute(Qt::WA_DeleteOnClose);
	menu->popup(layerList_->viewport()->mapToGlobal(pos));
	addui::popIn(menu, false);
}

void MainWindow::showSceneMenu(const QPoint &pos)
{
	QListWidgetItem *it = sceneList_->itemAt(pos);
	if (it)
		sceneList_->setCurrentItem(it);
	QMenu *menu = buildSceneMenu(this, it ? it->data(Qt::UserRole).toString() : QString(), !it);
	menu->setAttribute(Qt::WA_DeleteOnClose);
	menu->popup(sceneList_->viewport()->mapToGlobal(pos));
	addui::popIn(menu, false);
}

void MainWindow::layerDuplicate()
{
	if (selectedLayer().isEmpty())
		return note(QStringLiteral("Select a layer first."));
	if (live_)
		return note(QStringLiteral("Not while live."));
	structureEdit(QJsonObject{{QStringLiteral("op"), QStringLiteral("layer.duplicate")}, {QStringLiteral("scene"), activeScene_}, {QStringLiteral("layer"), selected_}});
}

void MainWindow::layerRename()
{
	const QJsonObject l = selectedLayer();
	if (l.isEmpty())
		return note(QStringLiteral("Select a layer first."));
	if (live_)
		return note(QStringLiteral("Not while live."));
	bool ok = false;
	const QString name = QInputDialog::getText(this, QStringLiteral("Rename layer"), QStringLiteral("Layer name"), QLineEdit::Normal, l.value(QStringLiteral("name")).toString(), &ok).trimmed();
	if (!ok || name.isEmpty() || name == l.value(QStringLiteral("name")).toString())
		return;
	structureEdit(QJsonObject{{QStringLiteral("op"), QStringLiteral("layer.rename")}, {QStringLiteral("scene"), activeScene_}, {QStringLiteral("layer"), selected_}, {QStringLiteral("name"), name.left(80)}});
}

void MainWindow::layerDelete()
{
	const QJsonObject l = selectedLayer();
	if (l.isEmpty())
		return note(QStringLiteral("Select a layer first."));
	if (live_)
		return note(QStringLiteral("Not while live."));
	if (QMessageBox::question(this, QStringLiteral("Delete layer"), QStringLiteral("Delete the layer \"%1\" from this scene?\nIt goes from both the H and the V picture.").arg(l.value(QStringLiteral("name")).toString(selected_))) != QMessageBox::Yes)
		return;
	structureEdit(QJsonObject{{QStringLiteral("op"), QStringLiteral("layer.remove")}, {QStringLiteral("scene"), activeScene_}, {QStringLiteral("layer"), selected_}});
}

// Host order is bottom first, so a higher index is higher in the picture. Offline the move is saved into the project
// (structure op layer.move to a target layer, D330); live, or for a layer the project does not have, it goes to the
// host only (layers.move) and the server asks for "yes, on air".
void MainWindow::layerMoveTo(int index)
{
	if (selected_.isEmpty() || index < 0 || index >= layers_.size())
		return;
	QStringList order; // host order with the moved layer taken out
	for (const auto &l : layers_)
		if (const QString id = l.toObject().value(QStringLiteral("id")).toString(); id != selected_)
			order << id;
	if (!live_ && order.size() == layers_.size() - 1 && !order.isEmpty()) {
		const bool below = index == 0; // to the bottom: under the layer that is lowest now
		const QString target = below ? order.first() : order.at(std::min<int>(index, order.size()) - 1);
		const QJsonObject body{{QStringLiteral("op"), QStringLiteral("layer.move")}, {QStringLiteral("scene"), activeScene_}, {QStringLiteral("layer"), selected_},
				       {QStringLiteral("canvas"), canvas_}, {QStringLiteral("target"), target}, {QStringLiteral("place"), below ? QStringLiteral("below") : QStringLiteral("above")}};
		api_->post(QStringLiteral("ui/api/project/structure"), body, [this, index](bool ok, const QJsonObject &b, const QString &err) {
			if (!ok && (err.contains(QStringLiteral("unknown-layer")) || err.contains(QStringLiteral("not-on-canvas")) || err.contains(QStringLiteral("unknown-scene")) ||
				    err.contains(QStringLiteral("no-project-file"))))
				return layerMoveHost(index); // not a project layer: the live-only order, as before
			if (!ok)
				note(QStringLiteral("Not moved: ") + plainStructureError(b.value(QStringLiteral("error")).toString(err)));
			else if (!b.value(QStringLiteral("saved")).toBool())
				note(QStringLiteral("Moved. Not saved to the project file: the change is live only."));
			loadScenes();
			if (sceneEditOn_)
				loadStructure();
			loadEdits(); // a structure edit clears the undo history
		});
		return;
	}
	layerMoveHost(index);
}

void MainWindow::layerMoveHost(int index)
{
	if (selected_.isEmpty() || index < 0 || index >= layers_.size())
		return;
	QJsonObject x;
	x.insert(QStringLiteral("layer"), selected_);
	x.insert(QStringLiteral("index"), index);
	api_->host(QStringLiteral("layers.move"), layerArgs(x), [this](bool ok, const QJsonObject &b, const QString &err) {
		if (!ok)
			note(QStringLiteral("Move failed: ") + err);
		else if (b.value(QStringLiteral("verdict")).toString() == QStringLiteral("confirm"))
			return confirm(b.value(QStringLiteral("pending")).toObject());
		loadLayers();
	});
}

void MainWindow::layerToggleVisible()
{
	const QJsonObject l = selectedLayer();
	if (l.isEmpty())
		return;
	QJsonObject x;
	x.insert(QStringLiteral("layer"), selected_);
	x.insert(QStringLiteral("visible"), !l.value(QStringLiteral("visible")).toBool());
	api_->host(QStringLiteral("layers.setVisible"), layerArgs(x), [this](bool ok, const QJsonObject &, const QString &err) {
		if (!ok)
			note(QStringLiteral("Show/hide failed: ") + err);
		loadLayers();
	});
}

void MainWindow::lookCopy()
{
	const QJsonObject l = selectedLayer();
	if (l.isEmpty() || !l.contains(QStringLiteral("placement")))
		return note(QStringLiteral("Select a layer first."));
	const bool draft = effLayer_ == activeScene_ + QLatin1Char('/') + selected_; // the Look panel's list for this layer
	lookClip_ = draft ? effEdit_ : l.value(QStringLiteral("effects")).toArray();
	hasLookClip_ = true;
	note(lookClip_.isEmpty() ? QStringLiteral("Copied: this layer has no look.") : QStringLiteral("Look copied (%1 effect(s)).").arg(lookClip_.size()));
}

// Sets the copied list on the selected layer through the Look panel's own send (layers.setEffects, "yes, on air" while live).
void MainWindow::lookPaste()
{
	const QJsonObject l = selectedLayer();
	if (!hasLookClip_)
		return note(QStringLiteral("Copy a look first."));
	if (l.isEmpty() || !l.contains(QStringLiteral("placement")))
		return note(QStringLiteral("Select a layer first."));
	effEdit_ = lookClip_;
	effRev_++;
	effDirty_ = true;
	look_->setEffects(effEdit_);
	renderEffects();
	applyLook();
}

void MainWindow::lookFocus()
{
	if (look_->isHidden())
		return note(QStringLiteral("Select a layer first."));
	look_->setFocus();
	for (QWidget *w = look_->parentWidget(); w; w = w->parentWidget())
		if (auto *sa = qobject_cast<QScrollArea *>(w)) {
			sa->ensureWidgetVisible(look_);
			break;
		}
}

void MainWindow::sceneRename(const QString &id)
{
	if (live_)
		return note(QStringLiteral("Not while live."));
	QString cur;
	for (const auto &s : scenes_)
		if (s.toObject().value(QStringLiteral("id")).toString() == id)
			cur = s.toObject().value(QStringLiteral("name")).toString();
	bool ok = false;
	const QString name = QInputDialog::getText(this, QStringLiteral("Rename scene"), QStringLiteral("Scene name"), QLineEdit::Normal, cur, &ok).trimmed();
	if (!ok || name.isEmpty() || name == cur)
		return;
	structureEdit(QJsonObject{{QStringLiteral("op"), QStringLiteral("scene.rename")}, {QStringLiteral("scene"), id}, {QStringLiteral("name"), name.left(80)}});
}

void MainWindow::sceneDuplicate(const QString &id)
{
	if (live_)
		return note(QStringLiteral("Not while live."));
	structureEdit(QJsonObject{{QStringLiteral("op"), QStringLiteral("scene.duplicate")}, {QStringLiteral("scene"), id}});
}

void MainWindow::sceneDelete(const QString &id)
{
	if (live_)
		return note(QStringLiteral("Not while live."));
	if (!sceneEditOn_)
		return note(QStringLiteral("Turn on scene editing in Settings > Advanced to delete scenes."));
	QString cur = id;
	for (const auto &s : scenes_)
		if (s.toObject().value(QStringLiteral("id")).toString() == id)
			cur = s.toObject().value(QStringLiteral("name")).toString();
	if (QMessageBox::question(this, QStringLiteral("Delete scene"), QStringLiteral("Delete the scene \"%1\" and all its layers from the project?").arg(cur)) != QMessageBox::Yes)
		return;
	structureEdit(QJsonObject{{QStringLiteral("op"), QStringLiteral("scene.remove")}, {QStringLiteral("scene"), id}});
}

void MainWindow::structureEdit(const QJsonObject &body)
{
	if (live_)
		return note(QStringLiteral("Live: scenes and layers cannot be added or removed."));
	api_->post(QStringLiteral("ui/api/project/structure"), body, [this](bool ok, const QJsonObject &b, const QString &err) {
		if (!ok) {
			const QString detail = b.value(QStringLiteral("detail")).toString();
			note(QStringLiteral("Not done: ") + plainStructureError(err) + (detail.isEmpty() ? QString() : QStringLiteral(" (") + detail + QStringLiteral(")")));
		} else {
			if (b.value(QStringLiteral("op")).toString() == QStringLiteral("layer.duplicate") || b.value(QStringLiteral("op")).toString() == QStringLiteral("layer.add"))
				selected_ = b.value(QStringLiteral("layer")).toObject().value(QStringLiteral("id")).toString(); // select the new layer
			note(QStringLiteral("Done: ") + b.value(QStringLiteral("op")).toString() +
			     (b.value(QStringLiteral("saved")).toBool() ? QString() : QStringLiteral(". Not saved to the project file: the change is live only.")));
			addText_->clear();
		}
		loadScenes();
		loadStructure();
		loadEdits(); // a structure edit clears the undo history
	});
}

void MainWindow::loadTransitions()
{
	api_->get(QStringLiteral("ui/api/project/transitions"), [this](bool ok, const QJsonObject &b, const QString &err) {
		if (!ok)
			return note(QStringLiteral("Transitions unavailable: ") + err);
		transitions_ = b;
		if (!b.value(QStringLiteral("available")).toBool())
			note(QStringLiteral("Transitions need a loaded project file."));
		const QSignalBlocker block(trFile_);
		trFile_->clear();
		for (const auto &x : b.value(QStringLiteral("videos")).toArray())
			trFile_->addItem(x.toString(), x.toString());
		renderTransition();
	});
}

// Shows the selected canvas's saved transition in the form.
void MainWindow::renderTransition()
{
	QJsonObject t;
	for (const auto &x : transitions_.value(QStringLiteral("canvases")).toArray())
		if (x.toObject().value(QStringLiteral("id")).toString() == trCanvas_->currentData().toString())
			t = x.toObject().value(QStringLiteral("transition")).toObject();
	const QString type = t.value(QStringLiteral("type")).toString(QStringLiteral("cut"));
	trType_->setCurrentIndex(std::max(0, trType_->findData(type)));
	trMs_->setValue(t.value(QStringLiteral("durationMs")).toInt());
	trPoint_->setValue(t.value(QStringLiteral("pointMs")).toInt());
	trAudio_->setChecked(t.value(QStringLiteral("audio")).toBool(true));
	const int fi = trFile_->findData(t.value(QStringLiteral("file")).toObject().value(QStringLiteral("rel")).toString());
	if (fi >= 0)
		trFile_->setCurrentIndex(fi);
	const bool fade = type == QStringLiteral("fade"), sting = type == QStringLiteral("stinger");
	trMs_->setEnabled(fade);
	for (QWidget *x : {(QWidget *)trFile_, (QWidget *)trPoint_, (QWidget *)trAudio_})
		x->setEnabled(sting);
}

void MainWindow::applyTransition()
{
	if (live_)
		return note(QStringLiteral("Live: transitions cannot be changed."));
	const QString type = trType_->currentData().toString();
	QJsonObject b;
	b.insert(QStringLiteral("canvas"), trCanvas_->currentData().toString());
	b.insert(QStringLiteral("type"), type);
	if (type == QStringLiteral("fade"))
		b.insert(QStringLiteral("durationMs"), trMs_->value());
	if (type == QStringLiteral("stinger")) {
		if (trFile_->currentData().toString().isEmpty())
			return note(QStringLiteral("A stinger needs a video from the stream assets folder."));
		b.insert(QStringLiteral("file"), trFile_->currentData().toString());
		b.insert(QStringLiteral("pointMs"), trPoint_->value());
		if (!trAudio_->isChecked())
			b.insert(QStringLiteral("audio"), false);
	}
	api_->post(QStringLiteral("ui/api/project/transition"), b, [this](bool ok, const QJsonObject &, const QString &err) {
		note(ok ? QStringLiteral("Transition saved; the host follows within a few seconds.") : QStringLiteral("Not done: ") + err);
		loadTransitions();
	});
}

void MainWindow::setFlag(const QString &id, bool on)
{
	QJsonObject body;
	body.insert(QStringLiteral("id"), id);
	body.insert(QStringLiteral("on"), on);
	api_->post(QStringLiteral("ui/api/flags/set"), body, [this, id, on](bool ok, const QJsonObject &b, const QString &err) {
		if (!ok)
			note(QStringLiteral("Flag not changed: ") + err);
		else if (b.value(QStringLiteral("verdict")).toString() == QStringLiteral("confirm"))
			return confirm(b.value(QStringLiteral("pending")).toObject()); // the next poll shows the result either way
		else
			note(QStringLiteral("Flag ") + id + (on ? QStringLiteral(" on.") : QStringLiteral(" off.")));
		pollStatus();
	});
}

void MainWindow::loadEdits()
{
	api_->get(QStringLiteral("ui/api/edits"), [this](bool ok, const QJsonObject &e, const QString &) {
		if (!ok)
			return;
		const bool can = !live_ && !undoBusy_; // the UI server refuses undo while live (D238)
		undoBtn_->setEnabled(can && e.value(QStringLiteral("undo")).toInt() > 0);
		redoBtn_->setEnabled(can && e.value(QStringLiteral("redo")).toInt() > 0);
		undoBtn_->setToolTip(e.value(QStringLiteral("nextUndo")).toString());
		redoBtn_->setToolTip(e.value(QStringLiteral("nextRedo")).toString());
	});
}

void MainWindow::undoRedo(bool undo)
{
	if (live_)
		return note(QStringLiteral("Live: undo and redo are off. Use the inspector."));
	if (undoBusy_)
		return;
	undoBusy_ = true;
	api_->post(undo ? QStringLiteral("ui/api/edits/undo") : QStringLiteral("ui/api/edits/redo"), {},
		   [this, undo](bool ok, const QJsonObject &b, const QString &err) {
			   undoBusy_ = false;
			   if (!ok)
				   note((undo ? QStringLiteral("Nothing undone: ") : QStringLiteral("Nothing redone: ")) + err);
			   else
				   note((undo ? QStringLiteral("Undone: ") : QStringLiteral("Redone: ")) +
					b.value(QStringLiteral("method")).toString() + QStringLiteral(" ") + b.value(QStringLiteral("layer")).toString());
			   loadLayers();
			   loadEdits();
		   });
}

// ---- clips and settings (D284) ---------------------------------------------------------------------------------

namespace {
struct ModeText {
	const char *id, *recording, *live;
};
const ModeText kModes[] = {
	{"ask", "Ask me each time I stop recording", "Ask me each time a stream ends"},
	{"after", "Make clips automatically when I stop recording", "Make clips automatically when the stream ends"},
	{"while", "Find the best moments while I record, then edit them into clips", "Find the best moments while I'm live, then edit them into clips"},
	{"off", "Don't make clips", "Don't make clips"},
};
QString modeWords(const QString &id, bool live)
{
	for (const ModeText &m : kModes)
		if (id == QLatin1String(m.id))
			return QString::fromUtf8(live ? m.live : m.recording);
	return id;
}
// Runs a function when its parent is deleted. Made as the dialog's first child, it runs before the dialog's other
// children (Qt deletes children in creation order), so a borrowed widget can be taken back before it is deleted.
class OnDelete : public QObject
{
public:
	OnDelete(QObject *parent, std::function<void()> f) : QObject(parent), f_(std::move(f)) {}
	~OnDelete() override
	{
		if (f_)
			f_();
	}

private:
	std::function<void()> f_;
};
} // namespace

// The Clips label in the top bar, in plain words, and the questions that need an answer.
void MainWindow::updateClips(const QJsonObject &cl)
{
	clips_ = cl;
	const QJsonObject last = cl.value(QStringLiteral("last")).toObject(), set = cl.value(QStringLiteral("settings")).toObject();
	const QJsonObject run = cl.value(QStringLiteral("running")).toObject();
	const bool allOff = set.value(QStringLiteral("recording")).toString() == QStringLiteral("off") &&
			    set.value(QStringLiteral("live")).toString() == QStringLiteral("off");
	QString t;
	if (cl.isEmpty())
		t = QStringLiteral("Clips: -");
	else if (!run.isEmpty())
		t = QStringLiteral("Making clips...");
	else if (!cl.value(QStringLiteral("asks")).toArray().isEmpty())
		t = QStringLiteral("Make clips? (%1)").arg(cl.value(QStringLiteral("asks")).toArray().size());
	else if (const QJsonValue q = cl.value(QStringLiteral("queued")); (q.isArray() ? q.toArray().size() : q.toInt()) > 0)
		// The server sends a count; the clip job's own status file holds a list. Both are read.
		t = QStringLiteral("Clips waiting: %1").arg(q.isArray() ? q.toArray().size() : q.toInt());
	else if (allOff)
		t = QStringLiteral("Clips: off");
	else if (cl.value(QStringLiteral("available")).isBool() && !cl.value(QStringLiteral("available")).toBool())
		// The Alpha zip ships no Python: say so in plain words (the reason and the fix are in the tooltip).
		t = cl.value(QStringLiteral("missing")).toString() == QStringLiteral("python") ? QStringLiteral("Clips: Python not found")
											: QStringLiteral("Clips: not set up");
	else if (last.value(QStringLiteral("result")).toString() == QStringLiteral("done"))
		t = QStringLiteral("%1 new clip(s)").arg(last.value(QStringLiteral("clips")).toInt());
	else if (last.value(QStringLiteral("result")).toString() == QStringLiteral("failed"))
		t = QStringLiteral("Clips: last try failed");
	else
		t = QStringLiteral("Clips: ready");
	pillClips_->setText(t);
	QString tip = QStringLiteral("Recording: ") + modeWords(set.value(QStringLiteral("recording")).toString(), false) +
		      QStringLiteral("\nLive: ") + modeWords(set.value(QStringLiteral("live")).toString(), true) +
		      QStringLiteral("\nClips folder: ") + cl.value(QStringLiteral("folder")).toString();
	if (!cl.value(QStringLiteral("reason")).toString().isEmpty())
		tip += QStringLiteral("\n") + cl.value(QStringLiteral("reason")).toString();
	if (!cl.value(QStringLiteral("fix")).toString().isEmpty())
		tip += QStringLiteral("\n") + cl.value(QStringLiteral("fix")).toString();
	if (!last.value(QStringLiteral("reason")).toString().isEmpty())
		tip += QStringLiteral("\nLast time: ") + last.value(QStringLiteral("reason")).toString();
	pillClips_->setToolTip(tip);
	if (!isVisible())
		return; // the headless probe answers with probe actions; questions only on a shown window
	if (!firstRunAsked_ && cl.contains(QStringLiteral("settingsSaved")) && !cl.value(QStringLiteral("settingsSaved")).toBool()) {
		firstRunAsked_ = true;
		QTimer::singleShot(0, this, [this]() { openSettings(true); });
		return;
	}
	for (const QJsonValue &v : cl.value(QStringLiteral("asks")).toArray()) {
		const QJsonObject a = v.toObject();
		if (asked_.contains(a.value(QStringLiteral("id")).toString()))
			continue;
		asked_ << a.value(QStringLiteral("id")).toString();
		askClips(a);
		break;
	}
}

// "Make clips from it?" after a recording or stream (setting: Ask me each time). Not modal: the studio keeps working.
void MainWindow::askClips(const QJsonObject &ask)
{
	const bool live = ask.value(QStringLiteral("kind")).toString() == QStringLiteral("live");
	const int min = ask.value(QStringLiteral("minutes")).toInt(-1);
	auto *box = new QMessageBox(QMessageBox::Question, QStringLiteral("Make clips?"),
				    (live ? QStringLiteral("Your stream has ended") : QStringLiteral("Your recording has stopped")) +
					    (min >= 0 ? QStringLiteral(" (%1 min).").arg(min) : QStringLiteral(".")) +
					    QStringLiteral("\n\nShould Ujwalam find the best moments and make clips from it?"),
				    QMessageBox::NoButton, this);
	auto *yes = box->addButton(QStringLiteral("Make clips"), QMessageBox::YesRole);
	box->addButton(QStringLiteral("Not now"), QMessageBox::NoRole);
	auto *remember = new QCheckBox(live ? QStringLiteral("Do this every time a stream ends") : QStringLiteral("Do this every time I stop recording"));
	box->setCheckBox(remember);
	box->setAttribute(Qt::WA_DeleteOnClose);
	const QString id = ask.value(QStringLiteral("id")).toString();
	connect(box, &QMessageBox::finished, this, [=]() { answerClips(id, box->clickedButton() == yes, remember->isChecked()); });
	box->open();
}

void MainWindow::answerClips(const QString &id, bool make, bool remember)
{
	QJsonObject b;
	b.insert(QStringLiteral("id"), id);
	b.insert(QStringLiteral("make"), make);
	b.insert(QStringLiteral("remember"), remember);
	api_->post(QStringLiteral("ui/api/clips/answer"), b, [this, make](bool ok, const QJsonObject &, const QString &err) {
		note(!ok ? QStringLiteral("Answer not saved: ") + err
			 : make ? QStringLiteral("Making clips. You can keep working; the Clips label shows when they are ready.")
				: QStringLiteral("No clips made."));
	});
}

// clips.matchGate as stored in settings.json: {"top3": bool, "minKills": int | null}
static QJsonObject matchGateJson(bool top3, int minKills)
{
	return QJsonObject{{QStringLiteral("top3"), top3}, {QStringLiteral("minKills"), minKills > 0 ? QJsonValue(minKills) : QJsonValue(QJsonValue::Null)}};
}

void MainWindow::saveSettings(const QJsonObject &body, bool retried)
{
	api_->post(QStringLiteral("ui/api/settings"), body, [this, body, retried](bool ok, const QJsonObject &r, const QString &err) {
		if (!ok) {
			// An older server does not know the match filter yet and refuses the whole change (400): say so in plain
			// words and save everything else, so one new option never blocks the other settings.
			const QJsonObject c = body.value(QStringLiteral("clips")).toObject();
			if (err.startsWith(QStringLiteral("HTTP 400")) && c.contains(QStringLiteral("matchGate")) && !retried) {
				QJsonObject rest = body;
				QJsonObject cc = c;
				cc.remove(QStringLiteral("matchGate"));
				rest.insert(QStringLiteral("clips"), cc);
				if (cc.isEmpty())
					rest.remove(QStringLiteral("clips"));
				if (!rest.isEmpty())
					saveSettings(rest, true);
				else
					note(QStringLiteral("The match filter was not saved: this version of Ujwalam does not support it yet."));
				return;
			}
			return note(QStringLiteral("Settings not saved: ") + err);
		}
		Q_UNUSED(r);
		note(retried ? QStringLiteral("Settings saved, except the match filter: this version of Ujwalam does not support it yet.") : QStringLiteral("Settings saved."));
		pollStatus();
	});
}

// Settings (D284, D290, D293): sections on the left (Clips, Folders, Layer effects, Appearance, Advanced), the page on the right. The
// feature flags list lives in Advanced: the window borrows the hidden flag list while Settings is open.
void MainWindow::openSettings(bool firstRun)
{
	if (settingsDlg_) { // already open (or its answer is on the way)
		settingsDlg_->raise();
		return;
	}
	api_->get(QStringLiteral("ui/api/settings"), [this, firstRun](bool ok, const QJsonObject &b, const QString &err) {
		if (!ok)
			return note(QStringLiteral("Settings not available: ") + err);
		if (settingsDlg_)
			return;
		const QJsonObject st = b.value(QStringLiteral("settings")).toObject(), cl = b.value(QStringLiteral("clips")).toObject();
		const QJsonObject c = st.value(QStringLiteral("clips")).toObject(), f = st.value(QStringLiteral("folders")).toObject();
		const QString motionNow = st.value(QStringLiteral("ui")).toObject().value(QStringLiteral("motion")).toString(QStringLiteral("system"));
		auto *dlg = new QDialog(this);
		dlg->setAttribute(Qt::WA_DeleteOnClose, true);
		// The flag list is borrowed below. However the dialog goes (closed, deleted directly, or with the window at
		// quit), the list goes back to its holder first, so flagList_ never points at a deleted widget. When the
		// holder is already gone (the window is being deleted), the list is deleted with the dialog.
		new OnDelete(dlg, [this] {
			if (flagHome_ && flagList_ && flagList_->parentWidget() != flagHome_) {
				flagList_->hide();
				flagList_->setParent(flagHome_);
			}
		});
		settingsDlg_ = dlg;
		dlg->setWindowTitle(firstRun ? QStringLiteral("Welcome: clips") : QStringLiteral("Settings"));
		auto *outer = new QVBoxLayout(dlg);
		outer->setContentsMargins(18, 16, 18, 14);
		outer->setSpacing(12);
		if (firstRun) {
			auto *intro = new QLabel(QStringLiteral("Ujwalam can find the best moments in your recordings and streams and edit them into short clips.\nHow should it do that? You can change this later in Settings."), dlg);
			intro->setWordWrap(true);
			outer->addWidget(intro);
		}
		auto *main = new QHBoxLayout();
		main->setSpacing(18);
		auto *nav = new QListWidget(dlg);
		nav->setObjectName(QStringLiteral("settingsNav"));
		nav->setFixedWidth(170);
		auto *pages = new QStackedWidget(dlg);
		main->addWidget(nav);
		main->addWidget(pages, 1);
		outer->addLayout(main, 1);
		// A page: a title and its cards in a column.
		auto page = [&](const QString &title) {
			auto *w = new QWidget(pages);
			auto *v = new QVBoxLayout(w);
			v->setContentsMargins(0, 0, 0, 0);
			v->setSpacing(12);
			auto *t = new QLabel(title, w);
			t->setObjectName(QStringLiteral("sectionTitle"));
			v->addWidget(t);
			pages->addWidget(w);
			nav->addItem(title);
			return v;
		};

		// Clips
		auto *pc = page(QStringLiteral("Clips"));
		auto *clipBox = new QGroupBox(QStringLiteral("WHEN TO MAKE CLIPS"), dlg);
		auto *cf = new QFormLayout(clipBox);
		cf->setVerticalSpacing(10);
		auto mk = [&](bool live, const QString &cur) {
			auto *cb = new QComboBox(clipBox);
			for (const ModeText &m : kModes)
				cb->addItem(QString::fromUtf8(live ? m.live : m.recording), QString::fromLatin1(m.id));
			cb->setCurrentIndex(std::max(0, cb->findData(cur)));
			return cb;
		};
		QComboBox *rec = mk(false, c.value(QStringLiteral("recording")).toString());
		QComboBox *liv = mk(true, c.value(QStringLiteral("live")).toString());
		cf->addRow(QStringLiteral("When I record:"), rec);
		cf->addRow(QStringLiteral("When I stream live:"), liv);
		if (cl.value(QStringLiteral("available")).isBool() && !cl.value(QStringLiteral("available")).toBool()) {
			QString why = QStringLiteral("Clips can't be made on this PC yet: ") + cl.value(QStringLiteral("reason")).toString();
			if (!cl.value(QStringLiteral("fix")).toString().isEmpty())
				why += QStringLiteral(". ") + cl.value(QStringLiteral("fix")).toString();
			auto *warn = new QLabel(why, clipBox);
			warn->setWordWrap(true);
			cf->addRow(warn);
		}
		pc->addWidget(clipBox);
		// Match filter the clipper honours (clips.matchGate): only matches that went well become clips.
		const QJsonObject gate = c.value(QStringLiteral("matchGate")).toObject();
		const bool hadGate = c.contains(QStringLiteral("matchGate"));
		const bool gateTop3 = gate.contains(QStringLiteral("top3")) ? gate.value(QStringLiteral("top3")).toBool() : true;
		const int gateKills = gate.value(QStringLiteral("minKills")).isDouble() ? gate.value(QStringLiteral("minKills")).toInt() : -1;
		auto *gateBox = new QGroupBox(QStringLiteral("WHICH MATCHES GET CLIPS"), dlg);
		auto *gv = new QVBoxLayout(gateBox);
		gv->setSpacing(8);
		auto *top3 = new QCheckBox(QStringLiteral("Only make clips from matches where I finish in the top 3"), gateBox);
		top3->setChecked(gateTop3);
		auto *killRow = new QWidget(gateBox);
		auto *kh = new QHBoxLayout(killRow);
		kh->setContentsMargins(0, 0, 0, 0);
		auto *killsOn = new QCheckBox(QStringLiteral("...or where I get at least"), killRow);
		auto *kills = new QSpinBox(killRow);
		kills->setRange(1, 99);
		kills->setValue(gateKills > 0 ? gateKills : 5);
		kills->setSuffix(QStringLiteral(" kills"));
		killsOn->setChecked(gateKills > 0);
		kills->setEnabled(killsOn->isChecked());
		connect(killsOn, &QCheckBox::toggled, kills, &QWidget::setEnabled);
		kh->addWidget(killsOn);
		kh->addWidget(kills);
		kh->addStretch(1);
		gv->addWidget(top3);
		gv->addWidget(killRow);
		pc->addWidget(gateBox);
		pc->addStretch(1);

		// Folders
		auto *pf = page(QStringLiteral("Folders"));
		auto *dirBox = new QGroupBox(QStringLiteral("WHERE FILES ARE SAVED"), dlg);
		auto *df = new QFormLayout(dirBox);
		df->setVerticalSpacing(10);
		auto folderRow = [&](const QString &cur, const QString &placeholder) {
			auto *row = new QWidget(dirBox);
			auto *h = new QHBoxLayout(row);
			h->setContentsMargins(0, 0, 0, 0);
			auto *edit = new QLineEdit(cur, row);
			edit->setPlaceholderText(placeholder);
			auto *pick = new QPushButton(QStringLiteral("Choose..."), row);
			auto *reset = new QPushButton(QStringLiteral("Default"), row);
			h->addWidget(edit, 1);
			h->addWidget(pick);
			h->addWidget(reset);
			connect(pick, &QPushButton::clicked, dlg, [edit, dlg]() {
				const QString d = QFileDialog::getExistingDirectory(dlg, QStringLiteral("Choose a folder"), edit->text());
				if (!d.isEmpty())
					edit->setText(QDir::toNativeSeparators(d));
			});
			connect(reset, &QPushButton::clicked, edit, &QLineEdit::clear);
			return std::make_pair(row, edit);
		};
		auto recRow = folderRow(f.value(QStringLiteral("recordings")).toString(), QStringLiteral("Default (Ujwalam's data folder)"));
		auto clipRow = folderRow(f.value(QStringLiteral("clips")).toString(), cl.value(QStringLiteral("folder")).toString());
		df->addRow(QStringLiteral("Recordings:"), recRow.first);
		df->addRow(QStringLiteral("Finished clips:"), clipRow.first);
		auto *hint = new QLabel(QStringLiteral("A new recordings folder is used from the next time you start Ujwalam."), dirBox);
		hint->setWordWrap(true);
		hint->setObjectName(QStringLiteral("muted"));
		df->addRow(hint);
		pf->addWidget(dirBox);
		pf->addStretch(1);

		// Layer effects: the scene's own effects (rounded game frame, shadows, the video buttons) are a feature flag
		// underneath; this is its plain on/off. The Look panel in the inspector needs no setting.
		auto *pl = page(QStringLiteral("Layer effects"));
		auto *fxBox = new QGroupBox(QStringLiteral("EFFECTS THAT COME WITH THE SCENES"), dlg);
		auto *fv = new QVBoxLayout(fxBox);
		fv->setSpacing(8);
		auto *fxOn = new QCheckBox(QStringLiteral("Show layer effects from the scene (rounded corners, shadows, video buttons)"), fxBox);
		fxOn->setObjectName(QStringLiteral("settingsLayerEffects"));
		bool fxNow = false, fxKnown = false;
		for (int i = 0; i < flagList_->count(); i++)
			if (flagList_->item(i)->data(Qt::UserRole).toString() == QStringLiteral("layer-effects")) {
				fxKnown = true;
				fxNow = flagList_->item(i)->checkState() == Qt::Checked;
			}
		fxOn->setChecked(fxNow);
		fxOn->setEnabled(fxKnown);
		auto *fxHint = new QLabel(QStringLiteral("Turning this on asks you to type \"yes\". The effects appear the next time the scenes are built (start Ujwalam with the rebuild option). "
							 "To change the look of one layer, select it and use the Look panel in the inspector; that needs no setting."), fxBox);
		fxHint->setWordWrap(true);
		fxHint->setObjectName(QStringLiteral("muted"));
		fv->addWidget(fxOn);
		fv->addWidget(fxHint);
		pl->addWidget(fxBox);
		pl->addStretch(1);

		// Appearance (D293): theme cards, reduce effects, animations
		auto *pap = page(QStringLiteral("Appearance"));
		auto *appear = new appearance::Page(theme::currentId(), theme::effects(), motionNow, dlg);
		pap->addWidget(appear, 1);

		// Help & tips (D294 proposed): tips on/off, reset "Don't show again", replay the welcome tour
		guide_->fillSettingsPage(page(QStringLiteral("Help & tips")), dlg);

		// Advanced: the developer feature flags
		auto *pa = page(QStringLiteral("Advanced"));
		auto *flagBox = new QGroupBox(QStringLiteral("FEATURE FLAGS (FOR TESTING NEW FEATURES)"), dlg);
		auto *flv = new QVBoxLayout(flagBox);
		auto *flagHint = new QLabel(QStringLiteral("New features ship switched off. Turning one on asks you to type the confirmation phrase; turning one off is instant."), flagBox);
		flagHint->setWordWrap(true);
		flagHint->setObjectName(QStringLiteral("muted"));
		flv->addWidget(flagHint);
		flagList_->setParent(flagBox);
		flv->addWidget(flagList_, 1);
		flagList_->setMinimumHeight(220);
		flagList_->show();
		pa->addWidget(flagBox, 1);
		nav->setCurrentRow(firstRun ? 0 : 0);

		connect(nav, &QListWidget::currentRowChanged, pages, &QStackedWidget::setCurrentIndex);
		auto *bb = new QDialogButtonBox(QDialogButtonBox::Save | QDialogButtonBox::Cancel, dlg);
		connect(bb, &QDialogButtonBox::accepted, dlg, &QDialog::accept);
		connect(bb, &QDialogButtonBox::rejected, dlg, &QDialog::reject);
		outer->addWidget(bb);
		dlg->resize(860, std::max(560, dlg->sizeHint().height()));

		connect(dlg, &QDialog::finished, this, [=](int result) {
			// give the flag list back to the window before the dialog goes
			flagList_->setParent(flagHome_);
			flagList_->hide();
			settingsDlg_.clear();
			if (result != QDialog::Accepted) {
				appear->revert(); // a theme tried on the cards goes back (D293)
				if (firstRun) // nothing chosen: keep "ask each time", and stop asking at every start
					saveSettings(QJsonObject{{QStringLiteral("clips"), QJsonObject{{QStringLiteral("recording"), QStringLiteral("ask")}, {QStringLiteral("live"), QStringLiteral("ask")}}}});
				return;
			}
			const auto dir = [](QLineEdit *e) { return e->text().trimmed().isEmpty() ? QJsonValue() : QJsonValue(e->text().trimmed()); };
			QJsonObject body;
			QJsonObject clipsBody{{QStringLiteral("recording"), rec->currentData().toString()}, {QStringLiteral("live"), liv->currentData().toString()}};
			const int newKills = killsOn->isChecked() ? kills->value() : -1;
			if (hadGate || top3->isChecked() != gateTop3 || newKills != gateKills) // sent only when it matters: an older server refuses the key
				clipsBody.insert(QStringLiteral("matchGate"), matchGateJson(top3->isChecked(), newKills));
			body.insert(QStringLiteral("clips"), clipsBody);
			body.insert(QStringLiteral("folders"), QJsonObject{{QStringLiteral("recordings"), dir(recRow.second)}, {QStringLiteral("clips"), dir(clipRow.second)}});
			const QString motionNew = appear->motion();
			if (motionNew != motionNow) { // sent only when it changed: an older server refuses the key
				body.insert(QStringLiteral("ui"), QJsonObject{{QStringLiteral("motion"), motionNew}});
				motion::setMode(motionNew);
			}
			if (appear->changedTheme() || appear->changedEffects()) { // sent only when it changed: an older server refuses the keys
				QJsonObject ui = body.value(QStringLiteral("ui")).toObject();
				if (appear->changedTheme())
					ui.insert(QStringLiteral("theme"), appear->themeId());
				if (appear->changedEffects())
					ui.insert(QStringLiteral("effects"), appear->effects());
				body.insert(QStringLiteral("ui"), ui);
			}
			saveSettings(body);
			if (fxKnown && fxOn->isChecked() != fxNow)
				setFlag(QStringLiteral("layer-effects"), fxOn->isChecked()); // the existing flags route: "yes" is typed in the confirm window
		});
		dlg->open();
	});
}

// The saved animation choice (settings.json ui.motion, D290) is read once at start; Settings changes it live.
void MainWindow::loadUiSettings()
{
	api_->get(QStringLiteral("ui/api/settings"), [](bool ok, const QJsonObject &b, const QString &) {
		if (ok)
			motion::setMode(b.value(QStringLiteral("settings")).toObject().value(QStringLiteral("ui")).toObject().value(QStringLiteral("motion")).toString(QStringLiteral("system")));
	});
}

void MainWindow::hostAction(const QString &method)
{
	api_->host(method, {}, [this](bool ok, const QJsonObject &b, const QString &err) {
		if (!ok)
			return note(QStringLiteral("Not done: ") + err);
		if (b.value(QStringLiteral("verdict")).toString() == QStringLiteral("confirm"))
			confirm(b.value(QStringLiteral("pending")).toObject());
		else
			pollStatus();
	});
}

// Typed confirmation (D151): the phrase comes from the server and is typed by the human; the server checks it.
void MainWindow::confirm(const QJsonObject &pending)
{
	const QString id = pending.value(QStringLiteral("pendingId")).toString();
	const QString phrase = pending.value(QStringLiteral("phrase")).toString();
	bool ok = false;
	const QString typed = QInputDialog::getText(this, QStringLiteral("Confirm"),
						    pending.value(QStringLiteral("summary")).toString() + QStringLiteral("\n\nType: ") + phrase,
						    QLineEdit::Normal, QString(), &ok);
	QJsonObject body;
	body.insert(QStringLiteral("pendingId"), id);
	if (!ok) {
		api_->post(QStringLiteral("ui/api/cancel"), body, [](bool, const QJsonObject &, const QString &) {});
		return note(QStringLiteral("Cancelled."));
	}
	body.insert(QStringLiteral("text"), typed);
	api_->post(QStringLiteral("ui/api/confirm"), body, [this](bool ok2, const QJsonObject &r, const QString &err) {
		if (!ok2)
			return note(QStringLiteral("Confirmation failed: ") + err);
		const QString v = r.value(QStringLiteral("verdict")).toString();
		if (v == QStringLiteral("wrong-phrase") || v == QStringLiteral("confirm")) {
			note(v == QStringLiteral("wrong-phrase") ? QStringLiteral("That is not the phrase. Type it exactly.") : QString());
			return confirm(r.value(QStringLiteral("pending")).toObject());
		}
		note(v == QStringLiteral("allow") ? QStringLiteral("Done.") : QStringLiteral("Result: ") + v);
		if (r.value(QStringLiteral("forced")).toBool())
			note(QStringLiteral("The bot did not close when asked and was force-closed; unsaved bot changes may be lost."));
		pollStatus();
		loadScenes();
		loadMixer(); // a confirmed track change (D273)
		if (botsOn_)
			loadBots();
	});
}

QJsonObject MainWindow::probe() const
{
	QJsonArray flags;
	for (int i = 0; i < flagList_->count(); i++) {
		QJsonObject f;
		f.insert(QStringLiteral("id"), flagList_->item(i)->data(Qt::UserRole).toString());
		f.insert(QStringLiteral("on"), flagList_->item(i)->checkState() == Qt::Checked);
		flags.append(f);
	}
	QJsonObject shown; // isHidden: the window itself is never shown in a probe
	QJsonArray previews; // each preview slot's message: empty once the host embedded its preview (D280)
	for (const PreviewSlot *s : slots_)
		previews.append(s->message());
	shown.insert(QStringLiteral("structure"), !structBox_->isHidden());
	shown.insert(QStringLiteral("transitions"), !transBox_->isHidden());
	shown.insert(QStringLiteral("bots"), !botBox_->isHidden());
	shown.insert(QStringLiteral("report"), reportAct_->isVisible());
	shown.insert(QStringLiteral("posts"), postsAct_->isVisible());
	QJsonObject o;
	o.insert(QStringLiteral("flags"), flags);
	o.insert(QStringLiteral("shown"), shown);
	o.insert(QStringLiteral("previews"), previews);
	o.insert(QStringLiteral("scenes"), sceneList_->count());
	o.insert(QStringLiteral("layers"), layerList_->count());
	o.insert(QStringLiteral("mixer"), (int)meters_.size());
	o.insert(QStringLiteral("trackButtons"), routeButtons_);
	o.insert(QStringLiteral("botButtons"), (int)botBox_->findChildren<QPushButton *>().size());
	o.insert(QStringLiteral("addLayerChoices"), addPick_->count()); // kind "copy": every layer in the project
	o.insert(QStringLiteral("transitionVideos"), trFile_->count());
	o.insert(QStringLiteral("undoEnabled"), undoBtn_->isEnabled());
	o.insert(QStringLiteral("live"), live_);
	o.insert(QStringLiteral("note"), note_->text());
	o.insert(QStringLiteral("alerts"), QJsonObject{{QStringLiteral("shown"), !alertBar_->isHidden()}, {QStringLiteral("text"), alertBar_->text()}, {QStringLiteral("level"), alertLevel_}});
	o.insert(QStringLiteral("clips"), pillClips_->text());
	o.insert(QStringLiteral("clipsTip"), pillClips_->toolTip());
	o.insert(QStringLiteral("clipAsks"), clips_.value(QStringLiteral("asks")).toArray().size());
	o.insert(QStringLiteral("clipSettings"), clips_.value(QStringLiteral("settings")));
	QJsonObject tp = tasks_->probe();
	tp.insert(QStringLiteral("stopsSent"), taskStops_);
	o.insert(QStringLiteral("tasks"), tp);
	QJsonObject tray = tray_->probe();
	tray.insert(QStringLiteral("closeAsked"), closeAsked_);
	tray.insert(QStringLiteral("closeChoice"), closeChoice_);
	tray.insert(QStringLiteral("stay"), trayStay_);
	o.insert(QStringLiteral("tray"), tray);
	o.insert(QStringLiteral("windowShown"), isVisible()); // UJWALAM_STUDIO_PROBE_SHOW: animations ran (2026-11-08 crash test)
	o.insert(QStringLiteral("guide"), guide_->probe());
	o.insert(QStringLiteral("stats"), QJsonObject{{QStringLiteral("samples"), stats_->samples()}, {QStringLiteral("session"), stats_->sessionText()}});
	o.insert(QStringLiteral("motion"), motion::systemAnimations());
	o.insert(QStringLiteral("motionMode"), motion::mode());
	o.insert(QStringLiteral("theme"), theme::probe()); // D293
	QJsonObject look = look_->probe();
	look.insert(QStringLiteral("shown"), !look_->isHidden());
	look.insert(QStringLiteral("advancedShown"), !effBox_->isHidden());
	o.insert(QStringLiteral("look"), look);
	QJsonArray layerKeys, sceneKeys; // shortcuts that are active while the list has focus (D292)
	for (const QShortcut *sc : layerList_->findChildren<QShortcut *>())
		layerKeys.append(sc->key().toString(QKeySequence::PortableText));
	for (const QShortcut *sc : sceneList_->findChildren<QShortcut *>())
		sceneKeys.append(sc->key().toString(QKeySequence::PortableText));
	o.insert(QStringLiteral("menu"), lastMenu_);
	QJsonObject addBtns;
	if (addSceneBtn_ && addLayerBtn_) {
		addBtns.insert(QStringLiteral("scene"), QJsonObject{{QStringLiteral("enabled"), addSceneBtn_->isEnabled()}, {QStringLiteral("tip"), addSceneBtn_->toolTip()}, {QStringLiteral("icon"), !addSceneBtn_->icon().isNull()}});
		addBtns.insert(QStringLiteral("layer"), QJsonObject{{QStringLiteral("enabled"), addLayerBtn_->isEnabled()}, {QStringLiteral("tip"), addLayerBtn_->toolTip()}, {QStringLiteral("icon"), !addLayerBtn_->icon().isNull()}});
	}
	if (delLayerBtn_) // D330
		addBtns.insert(QStringLiteral("delete"), QJsonObject{{QStringLiteral("enabled"), delLayerBtn_->isEnabled()}, {QStringLiteral("tip"), delLayerBtn_->toolTip()}, {QStringLiteral("icon"), !delLayerBtn_->icon().isNull()}});
	QJsonObject volumes; // D330: the shared volume sliders by source id
	for (ValueSlider *s : findChildren<ValueSlider *>())
		if (s->objectName().startsWith(QStringLiteral("vol:")))
			volumes.insert(s->objectName().mid(4), s->value());
	o.insert(QStringLiteral("volumes"), volumes);
	o.insert(QStringLiteral("addButtons"), addBtns);
	if (auto *d = qobject_cast<addui::AddLayerDialog *>(addDlg_.data()))
		o.insert(QStringLiteral("addDialog"), d->probe());
	else if (auto *d2 = qobject_cast<addui::AddSceneDialog *>(addDlg_.data()))
		o.insert(QStringLiteral("addDialog"), d2->probe());
	o.insert(QStringLiteral("listKeys"), QJsonObject{{QStringLiteral("layers"), layerKeys}, {QStringLiteral("scenes"), sceneKeys}});
	QJsonArray layerNames, sceneNames; // what the lists show, top layer first
	for (int i = 0; i < layerList_->count(); i++)
		layerNames.append(layerList_->item(i)->text());
	for (int i = 0; i < sceneList_->count(); i++)
		sceneNames.append(sceneList_->item(i)->text());
	o.insert(QStringLiteral("layerNames"), layerNames);
	o.insert(QStringLiteral("sceneNames"), sceneNames);
	o.insert(QStringLiteral("selectedLayer"), selected_);
	o.insert(QStringLiteral("lookClip"), hasLookClip_ ? QJsonValue(lookClip_) : QJsonValue());
	o.insert(QStringLiteral("controls"), QJsonObject{{QStringLiteral("stream"), streamBtn_->accessibleName()}, {QStringLiteral("record"), recordBtn_->accessibleName()},
							{QStringLiteral("clip"), clipBtn_->accessibleName()}, {QStringLiteral("mark"), markBtn_->accessibleName()},
							{QStringLiteral("streamIcon"), streamBtn_->property("iconState").toString()}});
	o.insert(QStringLiteral("flagsInSettings"), flagList_->parentWidget() != flagHome_); // the list moved out of the main window (D290)
	if (settingsDlg_) {
		QJsonArray sections;
		if (auto *nav = settingsDlg_->findChild<QListWidget *>(QStringLiteral("settingsNav")))
			for (int i = 0; i < nav->count(); i++)
				sections.append(nav->item(i)->text());
		auto *fx = settingsDlg_->findChild<QCheckBox *>(QStringLiteral("settingsLayerEffects"));
		auto *mo = settingsDlg_->findChild<QComboBox *>(QStringLiteral("settingsMotion"));
		QJsonObject s{{QStringLiteral("sections"), sections}, {QStringLiteral("layerEffects"), fx ? QJsonValue(fx->isChecked()) : QJsonValue()},
			      {QStringLiteral("layerEffectsText"), fx ? fx->text() : QString()}, {QStringLiteral("motion"), mo ? mo->currentData().toString() : QString()},
			      {QStringLiteral("motionChoices"), mo ? mo->count() : 0}};
		// Advanced page geometry (2026-11-10 offset bug): where the flag list sits in its box and in the dialog, and
		// whether it carries its own native window handle.
		if (QWidget *box = flagList_->parentWidget(); box && box != flagHome_) {
			const QRect g = flagList_->geometry(), inDlg(flagList_->mapTo(settingsDlg_.data(), QPoint(0, 0)), flagList_->size());
			const QRect bc = box->contentsRect();
			s.insert(QStringLiteral("flagList"), QJsonObject{{QStringLiteral("native"), flagList_->internalWinId() != 0},
									 {QStringLiteral("nativeAttr"), flagList_->testAttribute(Qt::WA_NativeWindow)},
									 {QStringLiteral("x"), g.x()}, {QStringLiteral("y"), g.y()}, {QStringLiteral("w"), g.width()}, {QStringLiteral("h"), g.height()},
									 {QStringLiteral("dlgX"), inDlg.x()}, {QStringLiteral("dlgY"), inDlg.y()},
									 {QStringLiteral("insideBox"), bc.contains(g)}, {QStringLiteral("scrollY"), flagList_->verticalScrollBar()->value()},
									 {QStringLiteral("scrollX"), flagList_->horizontalScrollBar()->value()}});
		}
		o.insert(QStringLiteral("settings"), s);
	}
	return o;
}

QWidget *MainWindow::settingsWindow() const
{
	return settingsDlg_.data();
}

void MainWindow::refreshGuide()
{
	guide_->refresh();
}

bool MainWindow::probeAction(const QString &action)
{
	const QStringList p = action.split(QLatin1Char(':'));
	auto buttons = [this](int strip) { // the mixer strip's buttons (the layout ends with a stretch)
		QList<QPushButton *> out;
		if (strip >= 0 && strip < mixerBox_->count() - 1)
			if (QWidget *w = mixerBox_->itemAt(strip)->widget())
				out = w->findChildren<QPushButton *>();
		return out;
	};
	if (action.startsWith(QStringLiteral("guide-")))
		return guide_->probeAction(action); // tips, tour and help (D294 proposed)
	// Look panel and Settings (D290): the real widgets are clicked, so their own handlers run.
	if (p.size() == 2 && (p[0] == QStringLiteral("theme") || p[0] == QStringLiteral("effects"))) // D293
		return theme::probeAction(action);
	if (p.size() == 2 && p[0] == QStringLiteral("select-layer")) {
		for (int i = 0; i < layerList_->count(); i++)
			if (layerList_->item(i)->data(Qt::UserRole).toString() == p[1]) {
				layerList_->setCurrentRow(i);
				return true;
			}
		return false;
	}
	// D330: press-and-drag in the layer list (rows top first), the trash button, and the shared sliders.
	if (p.size() == 3 && p[0] == QStringLiteral("layer-drag"))
		return static_cast<LayerList *>(layerList_)->probeDrag(p[1].toInt(), p[2].toInt());
	if (p.size() == 1 && p[0] == QStringLiteral("delete-button")) {
		if (!delLayerBtn_->isEnabled())
			return false;
		delLayerBtn_->click();
		return true;
	}
	// look-slider:<type>:<key>:<op>:<arg> and volume-slider:<source id>:<op>:<arg>; op is click (share 0..1),
	// type (percent-encoded text, then Enter), key (right|left|up|down|pageup|pagedown|home|end), wheel (notches, with
	// focus) or wheel-nofocus (notches, focus elsewhere).
	if ((p.size() == 5 && p[0] == QStringLiteral("look-slider")) || (p.size() == 4 && p[0] == QStringLiteral("volume-slider"))) {
		ValueSlider *s = p[0] == QStringLiteral("look-slider") ? look_->probeSlider(p[1], p[2]) : findChild<ValueSlider *>(QStringLiteral("vol:") + p[1]);
		if (!s)
			return false;
		const QString op = p[p.size() - 2], arg = p[p.size() - 1];
		if (op == QStringLiteral("click"))
			return s->probeClick(arg.toDouble());
		if (op == QStringLiteral("type"))
			return s->probeType(QUrl::fromPercentEncoding(arg.toUtf8()));
		if (op == QStringLiteral("wheel") || op == QStringLiteral("wheel-nofocus"))
			return s->probeWheel(arg.toInt(), op == QStringLiteral("wheel"));
		if (op == QStringLiteral("key")) {
			static const QMap<QString, int> keys{{QStringLiteral("right"), Qt::Key_Right}, {QStringLiteral("left"), Qt::Key_Left}, {QStringLiteral("up"), Qt::Key_Up},
							     {QStringLiteral("down"), Qt::Key_Down}, {QStringLiteral("pageup"), Qt::Key_PageUp}, {QStringLiteral("pagedown"), Qt::Key_PageDown},
							     {QStringLiteral("home"), Qt::Key_Home}, {QStringLiteral("end"), Qt::Key_End}};
			return keys.contains(arg) && s->probeKey(keys.value(arg));
		}
		return false;
	}
	if (p.size() == 2 && p[0] == QStringLiteral("select-scene")) {
		for (int i = 0; i < sceneList_->count(); i++)
			if (sceneList_->item(i)->data(Qt::UserRole).toString() == p[1]) {
				sceneList_->setCurrentRow(i);
				return true;
			}
		return false;
	}
	// D292: build the right-click menu for the selected layer or scene (recorded for the probe, never shown) and trigger
	// one item exactly as a click would (a disabled item does nothing: false). "show" only builds. Dialogs open on the
	// next turn of the event loop, so this action returns first.
	if (p.size() == 2 && (p[0] == QStringLiteral("layer-menu") || p[0] == QStringLiteral("scene-menu"))) {
		const bool layer = p[0] == QStringLiteral("layer-menu");
		QMenu *menu = layer ? buildLayerMenu(this) : buildSceneMenu(this, sceneKeyId());
		bool done = p[1] == QStringLiteral("show");
		if (!done)
			if (QAction *a = menu->findChild<QAction *>(p[1]); a && a->isEnabled()) {
				QTimer::singleShot(0, this, [a]() { a->trigger(); });
				done = true;
			}
		QTimer::singleShot(50, menu, &QObject::deleteLater);
		return done;
	}
	// D292: the + buttons and the add windows, driven through their real widgets.
	if (p.size() == 2 && p[0] == QStringLiteral("add-button")) {
		QToolButton *b = p[1] == QStringLiteral("scene") ? addSceneBtn_ : addLayerBtn_;
		if (!b->isEnabled())
			return false;
		b->click();
		return true;
	}
	if (p.size() >= 2 && (p[0] == QStringLiteral("add-layer") || p[0] == QStringLiteral("add-scene"))) {
		const bool layer = p[0] == QStringLiteral("add-layer");
		if (p[1] == QStringLiteral("open")) {
			if (layer)
				openAddLayer();
			else
				openAddScene();
			return !live_;
		}
		const QString arg = p.size() > 2 ? QUrl::fromPercentEncoding(p[2].toUtf8()) : QString();
		if (auto *d = qobject_cast<addui::AddLayerDialog *>(addDlg_.data()); d && layer) {
			if (p[1] == QStringLiteral("kind"))
				return d->probeKind(arg);
			if (p[1] == QStringLiteral("choice"))
				return d->probeChoice(arg.toInt());
			if (p[1] == QStringLiteral("text"))
				return d->probeText(arg);
			if (p[1] == QStringLiteral("send"))
				return d->probeSend();
		}
		if (auto *d = qobject_cast<addui::AddSceneDialog *>(addDlg_.data()); d && !layer) {
			if (p[1] == QStringLiteral("name"))
				return d->probeName(arg);
			if (p[1] == QStringLiteral("send"))
				return d->probeSend();
		}
		return false;
	}
	if (p.size() == 2 && p[0] == QStringLiteral("msg")) { // answer the open question box (delete confirm)
		auto *box = qobject_cast<QMessageBox *>(QApplication::activeModalWidget());
		if (!box)
			return false;
		box->button(p[1] == QStringLiteral("yes") ? QMessageBox::Yes : QMessageBox::No)->click();
		return true;
	}
	if (p.size() == 3 && p[0] == QStringLiteral("look"))
		return look_->probeToggle(p[1], p[2] == QStringLiteral("on"));
	if (p.size() == 4 && p[0] == QStringLiteral("look-set"))
		return look_->probeSet(p[1], p[2], p[3].toDouble());
	if (p.size() == 1 && p[0] == QStringLiteral("posts-open")) { // the Posts window (for the theme pictures, 2026-11-10)
		openPosts();
		return true;
	}
	if (p.size() == 1 && p[0] == QStringLiteral("settings-open")) {
		openSettings(false);
		return true;
	}
	if (p.size() >= 1 && p[0].startsWith(QStringLiteral("settings-")) && p[0] != QStringLiteral("settings-open")) {
		if (!settingsDlg_)
			return false;
		if (p[0] == QStringLiteral("settings-save") || p[0] == QStringLiteral("settings-cancel")) {
			p[0] == QStringLiteral("settings-save") ? settingsDlg_->accept() : settingsDlg_->reject();
			return true;
		}
		if (p[0] == QStringLiteral("settings-destroy")) { // delete the dialog without closing it (no finished signal)
			delete settingsDlg_.data();
			return true;
		}
		if (p.size() == 2 && p[0] == QStringLiteral("settings-page")) { // show a section (for the picture)
			if (auto *nav = settingsDlg_->findChild<QListWidget *>(QStringLiteral("settingsNav")); nav && p[1].toInt() >= 0 && p[1].toInt() < nav->count()) {
				nav->setCurrentRow(p[1].toInt());
				return true;
			}
		}
		if (p.size() == 2 && p[0] == QStringLiteral("settings-layer-effects")) {
			if (auto *fx = settingsDlg_->findChild<QCheckBox *>(QStringLiteral("settingsLayerEffects")); fx && fx->isEnabled()) {
				fx->setChecked(p[1] == QStringLiteral("on"));
				return true;
			}
		}
		if (p.size() == 2 && p[0] == QStringLiteral("settings-theme")) { // a click on the theme card (D293)
			if (auto *ap = settingsDlg_->findChild<appearance::Page *>())
				return ap->pick(p[1]);
		}
		if (p.size() == 2 && p[0] == QStringLiteral("settings-reduce-effects")) {
			if (auto *cb = settingsDlg_->findChild<QCheckBox *>(QStringLiteral("settingsReduceEffects"))) {
				cb->setChecked(p[1] == QStringLiteral("on"));
				return true;
			}
		}
		if (p.size() == 2 && p[0] == QStringLiteral("settings-scroll")) { // Appearance page scrolled (for the picture)
			if (auto *sa = settingsDlg_->findChild<QScrollArea *>(QStringLiteral("appearanceScroll"))) {
				sa->verticalScrollBar()->setValue(p[1] == QStringLiteral("end") ? sa->verticalScrollBar()->maximum() : p[1].toInt());
				return true;
			}
		}
		if (p.size() == 2 && p[0] == QStringLiteral("settings-performance")) { // High performance (2026-11-10)
			if (auto *cb = settingsDlg_->findChild<QCheckBox *>(QStringLiteral("settingsPerformance"))) {
				cb->setChecked(p[1] == QStringLiteral("on"));
				return true;
			}
		}
		if (p.size() == 2 && p[0] == QStringLiteral("settings-motion")) {
			if (auto *mo = settingsDlg_->findChild<QComboBox *>(QStringLiteral("settingsMotion")); mo && mo->findData(p[1]) >= 0) {
				mo->setCurrentIndex(mo->findData(p[1]));
				return true;
			}
		}
		return false;
	}
	if (p.size() == 2 && p[0] == QStringLiteral("flag-off")) {
		for (int i = 0; i < flagList_->count(); i++)
			if (flagList_->item(i)->data(Qt::UserRole).toString() == p[1]) {
				flagList_->item(i)->setCheckState(Qt::Unchecked); // itemChanged -> setFlag, as a click does
				return true;
			}
		return false;
	}
	if (p.size() == 2 && p[0] == QStringLiteral("flag-on")) { // ticks the flag: the server asks for a phrase (D279)
		for (int i = 0; i < flagList_->count(); i++)
			if (flagList_->item(i)->data(Qt::UserRole).toString() == p[1]) {
				flagList_->item(i)->setCheckState(Qt::Checked);
				return true;
			}
		return false;
	}
	if (p[0] == QStringLiteral("type") || (p.size() == 1 && p[0] == QStringLiteral("cancel"))) {
		// The open typed-confirm dialog (D279): type the text (percent-encoded, so "yes%2C on air") and press OK,
		// or press Cancel. false when no confirm dialog is open.
		auto *dlg = qobject_cast<QInputDialog *>(QApplication::activeModalWidget());
		if (!dlg)
			return false;
		if (p[0] == QStringLiteral("cancel")) {
			dlg->reject();
			return true;
		}
		dlg->setTextValue(QUrl::fromPercentEncoding(action.mid(5).toUtf8()));
		dlg->accept();
		return true;
	}
	if (p.size() == 2 && p[0] == QStringLiteral("answer")) { // D284: answer the first open "make clips?" question
		const QJsonArray asks = clips_.value(QStringLiteral("asks")).toArray();
		if (asks.isEmpty())
			return false;
		answerClips(asks.first().toObject().value(QStringLiteral("id")).toString(), p[1] == QStringLiteral("yes"), false);
		return true;
	}
	if (p.size() == 3 && p[0] == QStringLiteral("clip-modes")) { // D284: Settings > Clips, saved as the dialog does
		saveSettings(QJsonObject{{QStringLiteral("clips"), QJsonObject{{QStringLiteral("recording"), p[1]}, {QStringLiteral("live"), p[2]}}}});
		return true;
	}
	// D311 proposed: close the window (as its X does; the question opens on the next turn), answer the close question,
	// and the tray's own choices (click the icon, Open Ujwalam, Stop all without the extra question).
	if (p.size() == 1 && p[0] == QStringLiteral("close")) {
		QTimer::singleShot(0, this, [this]() { close(); });
		return true;
	}
	if (p.size() == 2 && p[0] == QStringLiteral("close-choice")) {
		auto *box = qobject_cast<QMessageBox *>(QApplication::activeModalWidget());
		if (!box || box->objectName() != QStringLiteral("closeTasks"))
			return false;
		const QString name = p[1] == QStringLiteral("tray") ? QStringLiteral("closeTray") : p[1] == QStringLiteral("stop") ? QStringLiteral("closeStop") : QStringLiteral("closeCancel");
		if (auto *b = box->findChild<QPushButton *>(name)) {
			b->click();
			return true;
		}
		return false;
	}
	if (p.size() == 2 && p[0] == QStringLiteral("tray")) {
		if (!tray_->active())
			return false;
		if (p[1] == QStringLiteral("click"))
			tray_->showList();
		else if (p[1] == QStringLiteral("open"))
			leaveTray();
		else if (p[1] == QStringLiteral("stop"))
			stopAllFromTray(false);
		else
			return false;
		return true;
	}
	if (p.size() == 2 && p[0] == QStringLiteral("tasks")) { // D287: open / close the task list, dismiss the first finished task
		if (p[1] == QStringLiteral("open") || p[1] == QStringLiteral("close")) {
			tasks_->setPanelOpen(p[1] == QStringLiteral("open"));
			return true;
		}
		if (p[1] == QStringLiteral("dismiss")) {
			tasks_->dismissFirstFinished();
			return true;
		}
		if (p[1] == QStringLiteral("toast-click")) { // a click on the first notification (opens the panel)
			tasks_->clickFirstToast();
			return true;
		}
		if (p[1] == QStringLiteral("stop")) { // a task's Stop button, without the question
			stopTasks(false);
			return true;
		}
		return false;
	}
	if (p.size() == 3 && p[0] == QStringLiteral("match-gate")) { // D287: save the match filter as the Settings dialog does
		saveSettings(QJsonObject{{QStringLiteral("clips"), QJsonObject{{QStringLiteral("matchGate"), matchGateJson(p[1] == QStringLiteral("true"), p[2].toInt())}}}});
		return true;
	}
	if (p.size() == 1 && (p[0] == QStringLiteral("clip") || p[0] == QStringLiteral("mark"))) { // D281
		(p[0] == QStringLiteral("clip") ? clipBtn_ : markBtn_)->click();
		return true;
	}
	if (p.size() == 1 && p[0] == QStringLiteral("undo")) {
		if (!undoBtn_->isEnabled())
			return false;
		undoBtn_->click();
		return true;
	}
	if (p.size() == 2 && p[0] == QStringLiteral("mute")) {
		for (QPushButton *b : buttons(p[1].toInt()))
			if (b->objectName() == QStringLiteral("mute")) {
				b->click();
				return true;
			}
		return false;
	}
	if (p.size() == 3 && p[0] == QStringLiteral("track")) {
		QList<QPushButton *> t;
		for (QPushButton *b : buttons(p[1].toInt()))
			if (b->objectName().startsWith(QStringLiteral("track:")))
				t << b;
		const int k = p[2].toInt();
		if (k < 0 || k >= t.size())
			return false;
		t[k]->click();
		return true;
	}
	return false;
}
