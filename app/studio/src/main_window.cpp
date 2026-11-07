// SPDX-License-Identifier: GPL-3.0-or-later
#include "main_window.h"

#include <QCheckBox>
#include <QDoubleSpinBox>
#include <QFormLayout>
#include <QFrame>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QInputDialog>
#include <QJsonArray>
#include <QLabel>
#include <QListWidget>
#include <QProgressBar>
#include <QPushButton>
#include <QScrollArea>
#include <QSlider>
#include <QSpinBox>
#include <QSplitter>
#include <QStatusBar>
#include <QTimer>
#include <QToolButton>
#include <QVBoxLayout>
#include <cmath>

namespace {
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
			api_->host(QStringLiteral("layers.move"), layerArgs(x), [this](bool ok, const QJsonObject &, const QString &err) {
				if (!ok)
					note(QStringLiteral("Move failed: ") + err);
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
	api_->host(QStringLiteral("layers.setPlacement"), layerArgs(x), [this](bool ok, const QJsonObject &, const QString &err) {
		note(ok ? QStringLiteral("Applied.") : QStringLiteral("Not applied: ") + err);
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
		const QJsonObject ready = h.value(QStringLiteral("outputsReady")).toObject();
		streamBtn_->setEnabled(ready.value(QStringLiteral("stream")).toBool());
		recordBtn_->setEnabled(ready.value(QStringLiteral("record")).toBool());
		streamBtn_->setText(live_ ? QStringLiteral("Stop stream") : QStringLiteral("Start stream"));
		recordBtn_->setText(recording_ ? QStringLiteral("Stop recording") : QStringLiteral("Record"));
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
