// SPDX-License-Identifier: GPL-3.0-or-later
#include "main_window.h"

#include <QCheckBox>
#include <QComboBox>
#include <QDoubleSpinBox>
#include <QFormLayout>
#include <QFrame>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QInputDialog>
#include <QJsonArray>
#include <QLabel>
#include <QLineEdit>
#include <QListWidget>
#include <QProgressBar>
#include <QRegularExpressionValidator>
#include <QPushButton>
#include <QScrollArea>
#include <QShortcut>
#include <QSignalBlocker>
#include <QSlider>
#include <QSpinBox>
#include <QSplitter>
#include <QStatusBar>
#include <QTimer>
#include <QToolButton>
#include <QVBoxLayout>
#include <algorithm>
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
struct FxType {
	const char *type, *label;
	std::vector<FxParam> params;
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
		{"blur", "Blur", {fxNum("strength", "Strength (source px)", 1, 100, 10, 1, 1)}},
		{"rounded", "Rounded corners", {fxNum("radius", "Radius (source px)", 0, 500, 20, 1, 1)}},
		{"chromaKey", "Chroma key", {fxCol("color", "Key colour", "#00ff00"), fxNum("similarity", "Similarity", 1, 1000, 400, 10, 0),
					     fxNum("smoothness", "Smoothness", 1, 1000, 80, 10, 0)}},
		{"shadow", "Shadow", {fxCol("color", "Colour", "#000000"), fxNum("opacity", "Opacity", 0, 1, 0.5, 0.05, 2),
				      fxNum("size", "Softness (px)", 0, 200, 10, 1, 1), fxNum("distance", "Distance (px)", 0, 200, 10, 1, 1),
				      fxNum("angle", "Light from (degrees)", -360, 360, 135, 5, 1)}},
		{"glow", "Glow", {fxCol("color", "Colour", "#ffffff"), fxNum("opacity", "Opacity", 0, 1, 1, 0.05, 2),
				  fxNum("size", "Size (px)", 0, 200, 15, 1, 1), fxNum("spread", "Spread", 0, 1, 0, 0.05, 2)}},
		{"color", "Colour correction", {fxNum("brightness", "Brightness", -1, 1, 0, 0.05, 2), fxNum("contrast", "Contrast", -1, 1, 0, 0.05, 2),
						fxNum("saturation", "Saturation", -1, 1, 0, 0.05, 2), fxNum("hue", "Hue (degrees)", -180, 180, 0, 5, 1)}},
		{"toner", "Toner", {fxCol("shadows", "Shadows", "#000000"), fxCol("darktones", "Dark tones", "#404040"),
				    fxCol("midtones", "Mid tones", "#808080"), fxCol("brights", "Brights", "#c0c0c0"),
				    fxCol("highlights", "Highlights", "#ffffff"), fxNum("amount", "Amount", 0, 1, 1, 0.05, 2)}},
		{"blinds", "Blinds", {fxNum("completion", "Hidden share", 0, 1, 0.5, 0.05, 2), fxNum("angle", "Angle (degrees)", -360, 360, 90, 5, 1),
					  fxNum("width", "Slat width (% of layer)", 1, 100, 10, 1, 1), fxNum("feather", "Feather (px)", 0, 100, 2, 1, 1)}},
		{"cornerPin", "Corner pin", {fxNum("topLeftX", "Top left x", 0, 1, 0, 0.01, 3), fxNum("topLeftY", "Top left y", 0, 1, 0, 0.01, 3),
					     fxNum("topRightX", "Top right x", 0, 1, 1, 0.01, 3), fxNum("topRightY", "Top right y", 0, 1, 0, 0.01, 3),
					     fxNum("bottomRightX", "Bottom right x", 0, 1, 1, 0.01, 3),
					     fxNum("bottomRightY", "Bottom right y", 0, 1, 1, 0.01, 3),
					     fxNum("bottomLeftX", "Bottom left x", 0, 1, 0, 0.01, 3),
					     fxNum("bottomLeftY", "Bottom left y", 0, 1, 1, 0.01, 3)}},
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
} // namespace

PreviewSlot::PreviewSlot(ApiClient *api, QString canvas, QWidget *parent)
	: QWidget(parent), api_(api), canvas_(std::move(canvas)), debounce_(new QTimer(this)), msg_(new QLabel(this))
{
	setAttribute(Qt::WA_NativeWindow, true); // a real window handle for the host's child window
	setAutoFillBackground(true);
	QPalette pal = palette();
	pal.setColor(QPalette::Window, QColor(16, 16, 16));
	pal.setColor(QPalette::WindowText, QColor(200, 200, 200));
	setPalette(pal);
	auto *l = new QVBoxLayout(this);
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
			setMessage(QStringLiteral("No preview here: ") + (detail.isEmpty() ? err : detail) +
				   QStringLiteral("\nMove this window to the second display, or use Open preview."));
		}
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
	auto *split = new QSplitter(Qt::Horizontal, central);
	split->addWidget(buildLeft());
	split->addWidget(buildCentre());
	split->addWidget(buildRight());
	split->setStretchFactor(0, 0);
	split->setStretchFactor(1, 1);
	split->setStretchFactor(2, 0);
	split->setSizes({260, 800, 340});
	outer->addWidget(split, 1);
	setCentralWidget(central);
	note_ = new QLabel(this);
	statusBar()->addWidget(note_, 1);
	resize(1400, 860);
}

QWidget *MainWindow::buildTop()
{
	auto *w = new QWidget(this);
	auto *h = new QHBoxLayout(w);
	h->setContentsMargins(0, 0, 0, 0);
	streamBtn_ = new QPushButton(QStringLiteral("Start stream"), w);
	recordBtn_ = new QPushButton(QStringLiteral("Record"), w);
	streamBtn_->setEnabled(false);
	recordBtn_->setEnabled(false);
	connect(streamBtn_, &QPushButton::clicked, this, [this]() { hostAction(live_ ? QStringLiteral("stream.stop") : QStringLiteral("stream.start")); });
	connect(recordBtn_, &QPushButton::clicked, this, [this]() { hostAction(recording_ ? QStringLiteral("record.stop") : QStringLiteral("record.start")); });
	pillLive_ = pill(QStringLiteral("Offline"));
	pillRec_ = pill(QStringLiteral("Not recording"));
	pillStats_ = pill(QStringLiteral("-"));
	pillHost_ = pill(QStringLiteral("Host: ?"));
	pillCore_ = pill(QStringLiteral("Event core: ?"));
	h->addWidget(streamBtn_);
	h->addWidget(recordBtn_);
	h->addSpacing(12);
	// Undo / redo of layer edits (D238; inspector, layer list, preview mouse, effects): Ctrl+Z / Ctrl+Y too.
	undoBtn_ = new QPushButton(QStringLiteral("Undo"), w);
	redoBtn_ = new QPushButton(QStringLiteral("Redo"), w);
	undoBtn_->setEnabled(false);
	redoBtn_->setEnabled(false);
	connect(undoBtn_, &QPushButton::clicked, this, [this]() { undoRedo(true); });
	connect(redoBtn_, &QPushButton::clicked, this, [this]() { undoRedo(false); });
	h->addWidget(undoBtn_);
	h->addWidget(redoBtn_);
	h->addSpacing(12);
	for (QLabel *p : {pillLive_, pillRec_, pillStats_, pillHost_, pillCore_})
		h->addWidget(p);
	h->addStretch(1);
	return w;
}

QWidget *MainWindow::buildLeft()
{
	auto *w = new QWidget(this);
	auto *v = new QVBoxLayout(w);
	v->setContentsMargins(0, 0, 0, 0);
	v->addWidget(new QLabel(QStringLiteral("<b>Scenes</b>")));
	sceneList_ = new QListWidget(w);
	sceneList_->setMaximumHeight(160);
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
	v->addWidget(sceneList_);

	auto *hdr = new QHBoxLayout();
	hdr->addWidget(new QLabel(QStringLiteral("<b>Layers</b>")));
	hdr->addStretch(1);
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
	layerList_ = new QListWidget(w);
	connect(layerList_, &QListWidget::currentItemChanged, this, [this](QListWidgetItem *it) {
		selected_ = it ? it->data(Qt::UserRole).toString() : QString();
		renderInspector();
	});
	v->addWidget(layerList_, 1);
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
			QJsonObject x;
			x.insert(QStringLiteral("layer"), selected_);
			x.insert(QStringLiteral("index"), to);
			api_->host(QStringLiteral("layers.move"), layerArgs(x), [this](bool ok, const QJsonObject &b, const QString &err) {
				if (!ok)
					note(QStringLiteral("Move failed: ") + err);
				else if (b.value(QStringLiteral("verdict")).toString() == QStringLiteral("confirm"))
					return confirm(b.value(QStringLiteral("pending")).toObject()); // live: "yes, on air" (D233)
				loadLayers();
			});
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

	// Feature flags (D149): new features ship off; switch them here. Turning one on asks for the typed phrase
	// ("yes, on air" while live), turning one off is instant. The list follows the server on every status poll.
	v->addWidget(new QLabel(QStringLiteral("<b>Feature flags</b>")));
	flagList_ = new QListWidget(w);
	flagList_->setMaximumHeight(170);
	connect(flagList_, &QListWidget::itemChanged, this, [this](QListWidgetItem *it) {
		setFlag(it->data(Qt::UserRole).toString(), it->checkState() == Qt::Checked);
	});
	v->addWidget(flagList_);
	return w;
}

QWidget *MainWindow::buildCentre()
{
	auto *w = new QWidget(this);
	auto *h = new QHBoxLayout(w);
	for (const char *cv : {"h", "v"}) {
		auto *box = new QGroupBox(QString::fromLatin1(cv).toUpper() == QStringLiteral("H") ? QStringLiteral("Horizontal (H)") : QStringLiteral("Vertical (V)"), w);
		auto *bv = new QVBoxLayout(box);
		auto *slot = new PreviewSlot(api_, QString::fromLatin1(cv).toUpper(), box);
		slot->setMinimumSize(cv[0] == 'h' ? QSize(480, 270) : QSize(180, 320));
		bv->addWidget(slot, 1);
		slots_ << slot;
		auto *row = new QHBoxLayout();
		auto *open = new QPushButton(QStringLiteral("Open preview"), box);
		auto *front = new QPushButton(QStringLiteral("Bring to front"), box);
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
	auto *v = new QVBoxLayout(w);
	v->setContentsMargins(0, 0, 0, 0);

	auto *insp = new QGroupBox(QStringLiteral("Inspector"), w);
	auto *iv = new QVBoxLayout(insp);
	inspEmpty_ = new QLabel(QStringLiteral("Select a layer to edit its position, size and crop."), insp);
	inspEmpty_->setWordWrap(true);
	iv->addWidget(inspEmpty_);
	inspForm_ = new QWidget(insp);
	auto *f = new QFormLayout(inspForm_);
	inspTitle_ = new QLabel(inspForm_);
	f->addRow(inspTitle_);
	auto dbl = [this](double lo, double hi, int dec) {
		auto *s = new QDoubleSpinBox(inspForm_);
		s->setRange(lo, hi);
		s->setDecimals(dec);
		return s;
	};
	inX_ = dbl(-16384, 16384, 0);
	inY_ = dbl(-16384, 16384, 0);
	inW_ = dbl(1, 16384, 0);
	inH_ = dbl(1, 16384, 0);
	inRot_ = dbl(-360, 360, 1);
	f->addRow(QStringLiteral("X"), inX_);
	f->addRow(QStringLiteral("Y"), inY_);
	f->addRow(QStringLiteral("Width"), inW_);
	f->addRow(QStringLiteral("Height"), inH_);
	f->addRow(QStringLiteral("Rotation"), inRot_);
	auto crop = [this]() {
		auto *s = new QSpinBox(inspForm_);
		s->setRange(0, 16384);
		return s;
	};
	crL_ = crop();
	crT_ = crop();
	crR_ = crop();
	crB_ = crop();
	f->addRow(QStringLiteral("Crop left"), crL_);
	f->addRow(QStringLiteral("Crop top"), crT_);
	f->addRow(QStringLiteral("Crop right"), crR_);
	f->addRow(QStringLiteral("Crop bottom"), crB_);
	auto *btns = new QHBoxLayout();
	auto *apply = new QPushButton(QStringLiteral("Apply"), inspForm_);
	auto *undo = new QPushButton(QStringLiteral("Undo changes"), inspForm_);
	btns->addWidget(apply);
	btns->addWidget(undo);
	f->addRow(btns);
	connect(apply, &QPushButton::clicked, this, &MainWindow::applyInspector);
	connect(undo, &QPushButton::clicked, this, &MainWindow::renderInspector);
	iv->addWidget(inspForm_);
	inspForm_->setVisible(false);
	v->addWidget(insp);

	effBox_ = new QGroupBox(QStringLiteral("Effects"), w);
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
	erow->addWidget(up);
	erow->addWidget(down);
	erow->addWidget(rm);
	ev->addLayout(erow);
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

	auto *mix = new QGroupBox(QStringLiteral("Audio mixer"), w);
	auto *scroll = new QScrollArea(mix);
	scroll->setWidgetResizable(true);
	auto *inner = new QWidget(scroll);
	mixerBox_ = new QVBoxLayout(inner);
	mixerBox_->addStretch(1);
	scroll->setWidget(inner);
	auto *mv = new QVBoxLayout(mix);
	mv->addWidget(scroll);
	v->addWidget(mix, 1);
	return w;
}

void MainWindow::moveEvent(QMoveEvent *e)
{
	QMainWindow::moveEvent(e);
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
		it->setData(Qt::UserRole, s.value(QStringLiteral("id")).toString());
		if (s.value(QStringLiteral("id")).toString() == activeScene_) {
			QFont fnt = it->font();
			fnt.setBold(true);
			it->setFont(fnt);
		}
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
	if (const QString key = activeScene_ + QLatin1Char('/') + selected_; key != effLayer_ || !effDirty_) {
		// a reload keeps unsent effect changes of the same layer
		effLayer_ = key;
		effEdit_ = l.value(QStringLiteral("effects")).toArray();
		effDirty_ = false;
		renderEffects();
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
	QStringList offMix;
	int row = 0;
	for (const auto &x : mixer_) {
		const QJsonObject m = x.toObject();
		if (m.contains(QStringLiteral("mixers")) && m.value(QStringLiteral("mixers")).toInt() == 0) {
			offMix << m.value(QStringLiteral("name")).toString();
			continue;
		}
		const QString id = m.value(QStringLiteral("id")).toString();
		auto *strip = new QWidget();
		auto *g = new QVBoxLayout(strip);
		g->setContentsMargins(0, 2, 0, 2);
		auto *top = new QHBoxLayout();
		top->addWidget(new QLabel(QStringLiteral("<b>%1</b>").arg(m.value(QStringLiteral("name")).toString().toHtmlEscaped())), 1);
		const bool muted = m.value(QStringLiteral("muted")).toBool();
		auto *mute = new QPushButton(muted ? QStringLiteral("Unmute") : QStringLiteral("Mute"));
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
		auto *meter = new QProgressBar();
		meter->setRange(0, 100);
		meter->setTextVisible(false);
		meter->setMaximumHeight(8);
		meter->setValue(meterValue(m.value(QStringLiteral("peakDb"))));
		meters_[id] = meter;
		g->addWidget(meter);
		auto *bottom = new QHBoxLayout();
		auto *slider = new QSlider(Qt::Horizontal);
		slider->setRange(-60, 0);
		const double db = m.value(QStringLiteral("volumeDb")).toDouble(0);
		slider->setValue((int)std::lround(std::max(-60.0, std::min(0.0, db))));
		auto *dbl = new QLabel(QStringLiteral("%1 dB").arg(slider->value()));
		dbl->setMinimumWidth(48);
		connect(slider, &QSlider::valueChanged, dbl, [dbl](int v) { dbl->setText(QStringLiteral("%1 dB").arg(v)); });
		connect(slider, &QSlider::sliderReleased, this, [this, id, slider]() {
			QJsonObject p;
			p.insert(QStringLiteral("id"), id);
			p.insert(QStringLiteral("db"), slider->value());
			api_->host(QStringLiteral("mixer.setVolume"), p, [this](bool ok, const QJsonObject &, const QString &err) { if (!ok) note(QStringLiteral("Volume failed: ") + err); });
		});
		bottom->addWidget(slider, 1);
		bottom->addWidget(dbl);
		g->addLayout(bottom);
		mixerBox_->insertWidget(row++, strip);
	}
	if (!offMix.isEmpty()) {
		auto *n = new QLabel(QStringLiteral("Not in the stream mix (layer sound off): ") + offMix.join(QStringLiteral(", ")) + QStringLiteral("."));
		n->setWordWrap(true);
		mixerBox_->insertWidget(row++, n);
	}
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

void MainWindow::pollStatus()
{
	api_->get(QStringLiteral("ui/api/status"), [this](bool ok, const QJsonObject &s, const QString &err) {
		if (!ok) {
			pillHost_->setText(QStringLiteral("UI server: down"));
			return note(QStringLiteral("Status: ") + err);
		}
		const QJsonObject h = s.value(QStringLiteral("host")).toObject(), c = s.value(QStringLiteral("core")).toObject();
		live_ = h.value(QStringLiteral("live")).toBool();
		previewEditing_ = h.value(QStringLiteral("previewEditing")).toBool();
		if (const bool ee = h.value(QStringLiteral("effectEditing")).toBool(); ee != effectEditing_) {
			effectEditing_ = ee;
			renderInspector();
		}
		recording_ = h.value(QStringLiteral("recording")).toBool();
		pillLive_->setText(live_ ? QStringLiteral("LIVE") : QStringLiteral("Offline"));
		pillLive_->setStyleSheet(live_ ? QStringLiteral("background:#c62828;color:white;") : QString());
		pillRec_->setText(recording_ ? QStringLiteral("Recording") : QStringLiteral("Not recording"));
		pillRec_->setStyleSheet(recording_ ? QStringLiteral("background:#c62828;color:white;") : QString());
		pillStats_->setText(QStringLiteral("Dropped %1 · %2 fps · CPU %3% · GPU %4%")
					    .arg(h.value(QStringLiteral("droppedFrames")).toInt())
					    .arg(h.value(QStringLiteral("fps")).toDouble(), 0, 'f', 1)
					    .arg(h.value(QStringLiteral("cpuPct")).toDouble(), 0, 'f', 1)
					    .arg(h.value(QStringLiteral("gpuPct")).toDouble(), 0, 'f', 0));
		pillHost_->setText(h.value(QStringLiteral("blockedOnHost")).toBool() ? QStringLiteral("BLOCKED-ON-HOST (fake)")
				   : h.value(QStringLiteral("available")).toBool()   ? QStringLiteral("Host: up")
										     : QStringLiteral("Host: down"));
		pillCore_->setText(c.value(QStringLiteral("available")).toBool() ? QStringLiteral("Event core: up") : QStringLiteral("Event core: down"));
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
		streamBtn_->setText(live_ ? QStringLiteral("Stop stream") : QStringLiteral("Start stream"));
		recordBtn_->setText(recording_ ? QStringLiteral("Stop recording") : QStringLiteral("Record"));
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
		pollStatus();
		loadScenes();
	});
}
