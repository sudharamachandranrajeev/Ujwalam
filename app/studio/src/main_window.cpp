// SPDX-License-Identifier: GPL-3.0-or-later
#include "main_window.h"

#include <QCheckBox>
#include <QColorDialog>
#include <QComboBox>
#include <QDoubleSpinBox>
#include <QFormLayout>
#include <QFrame>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QApplication>
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
#include <QPushButton>
#include <QScrollArea>
#include <QShortcut>
#include <QSignalBlocker>
#include <QSlider>
#include <QSpinBox>
#include <QSplitter>
#include <QStatusBar>
#include <QTimer>
#include <QCloseEvent>
#include <QUrl>
#include <QUrlQuery>
#include <QToolButton>
#include <QVBoxLayout>
#include <algorithm>
#include <memory>
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
// Layer kinds the structure route adds (D240): label, kind, what it is (the add-layer window shows it).
struct LayerKind {
	const char *label, *kind, *about;
};
const LayerKind kLayerKinds[] = {
	{"Copy of layer", "copy", "The same source again, placed on its own. A camera or capture card shown twice is opened once."},
	{"Colour", "color", "A solid colour fill."},
	{"Text", "text", "A line of text."},
	{"Capture device", "capture", "A camera or capture card from the project's devices."},
	{"Overlay", "overlay", "A page from the project's overlays (alerts, chat, counters)."},
	{"Image", "image", "A picture from the stream assets folder."},
	{"Video", "media", "A video from the stream assets folder."},
};

// What a kind can be made from: (shown text, value) from GET /ui/api/project/structure. Empty for colour and text.
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

// The structure route's layer.add body; err is set (and says what) when something is missing.
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
	e->accept();
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
	// Clipping (D281): save the replay buffer (last 60 s of H and V) now; mark a moment for the post-stream clipper.
	clipBtn_ = new QPushButton(QStringLiteral("Save clip"), w);
	clipBtn_->setToolTip(QStringLiteral("Save the last 60 seconds of H and V as clip files (replay buffer)."));
	markBtn_ = new QPushButton(QStringLiteral("Mark moment"), w);
	markBtn_->setToolTip(QStringLiteral("Mark this moment for the clipper (same as the marker hotkey, Ctrl+Alt+Shift+M by default)."));
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
	pillLive_ = pill(QStringLiteral("Offline"));
	pillRec_ = pill(QStringLiteral("Not recording"));
	pillStats_ = pill(QStringLiteral("-"));
	pillHost_ = pill(QStringLiteral("Host: ?"));
	pillCore_ = pill(QStringLiteral("Event core: ?"));
	pillClips_ = pill(QStringLiteral("Clips: off")); // clips from finished recordings (D283)
	h->addWidget(streamBtn_);
	h->addWidget(recordBtn_);
	h->addWidget(clipBtn_);
	h->addWidget(markBtn_);
	clipsFolderBtn_ = new QPushButton(QStringLiteral("My clips"), w);
	clipsFolderBtn_->setToolTip(QStringLiteral("Open the folder with your finished clips."));
	connect(clipsFolderBtn_, &QPushButton::clicked, this, [this]() {
		api_->post(QStringLiteral("ui/api/clips/open"), {}, [this](bool ok, const QJsonObject &, const QString &err) {
			if (!ok)
				note(QStringLiteral("Could not open the clips folder: ") + err);
		});
	});
	settingsBtn_ = new QPushButton(QStringLiteral("Settings"), w);
	settingsBtn_->setToolTip(QStringLiteral("Clips and save folders."));
	connect(settingsBtn_, &QPushButton::clicked, this, [this]() { openSettings(false); });
	h->addWidget(clipsFolderBtn_);
	h->addWidget(settingsBtn_);
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
	auto *imBtn = new QPushButton(QStringLiteral("Import Meld session"), w);
	imBtn->setToolTip(QStringLiteral("Make a new project file from the Meld session, check it against the host, then load it."));
	connect(imBtn, &QPushButton::clicked, this, &MainWindow::openImport);
	h->addWidget(imBtn);
	auto *fbBtn = new QPushButton(QStringLiteral("Feedback notes"), w);
	fbBtn->setToolTip(QStringLiteral("Add a note to each feedback moment (feedback hotkey while streaming)."));
	connect(fbBtn, &QPushButton::clicked, this, &MainWindow::openFeedback);
	h->addWidget(fbBtn);
	postsBtn_ = new QPushButton(QStringLiteral("Posts"), w);
	postsBtn_->setToolTip(QStringLiteral("Review clip packages. Nothing is uploaded without a typed confirmation."));
	postsBtn_->setVisible(false);
	connect(postsBtn_, &QPushButton::clicked, this, &MainWindow::openPosts);
	h->addWidget(postsBtn_);
	reportBtn_ = new QPushButton(QStringLiteral("Report a problem"), w);
	reportBtn_->setToolTip(QStringLiteral("Opens a prefilled GitHub issue in your browser; you review it before submitting."));
	reportBtn_->setVisible(false);
	connect(reportBtn_, &QPushButton::clicked, this, &MainWindow::report);
	h->addWidget(reportBtn_);
	h->addSpacing(12);
	for (QLabel *p : {pillLive_, pillRec_, pillStats_, pillHost_, pillCore_, pillClips_})
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
	for (const auto &k : kLayerKinds)
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
	connect(browse, &QPushButton::clicked, this, &MainWindow::openAddLayer);
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
		const QJsonObject b = layerAddBody(activeScene_, addKind_->currentData().toString(), addPick_->currentData().toString(), addText_->text(), err);
		if (!err.isEmpty())
			return note(err);
		structureEdit(b);
	});
	renderAddPick();

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
		auto *slot = new PreviewSlot(api_, QString::fromLatin1(cv), box); // h|v, as the UI server's canvas enum (D280)
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

	// Transitions (D242, flag transitions): per canvas cut, fade or stinger, saved into the project; the UI server
	// applies it to the host on the next status poll.
	transBox_ = new QGroupBox(QStringLiteral("Transitions"), w);
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

	botBox_ = new QGroupBox(QStringLiteral("Bots"), w);
	botRows_ = new QVBoxLayout(botBox_);
	botBox_->setVisible(false);
	v->addWidget(botBox_);

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
		auto *strip = new QWidget();
		auto *g = new QVBoxLayout(strip);
		g->setContentsMargins(0, 2, 0, 2);
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

void MainWindow::pollStatus()
{
	api_->get(QStringLiteral("ui/api/status"), [this](bool ok, const QJsonObject &s, const QString &err) {
		if (!ok) {
			pillHost_->setText(QStringLiteral("UI server: down"));
			return note(QStringLiteral("Status: ") + err);
		}
		const QJsonObject h = s.value(QStringLiteral("host")).toObject(), c = s.value(QStringLiteral("core")).toObject();
		live_ = h.value(QStringLiteral("live")).toBool();
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
		updateClips(s.value(QStringLiteral("clips")).toObject());
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
		streamBtn_->setToolTip(streamBtn_->isEnabled() ? QString()
							       : QStringLiteral("Streaming needs the LIVE start: the \"Ujwalam (alpha, LIVE)\" shortcut, or Ujwalam.cmd --live."));
		recordBtn_->setToolTip(recordBtn_->isEnabled() ? QString() : QStringLiteral("No recording output is set up in this start."));
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
		reportBtn_->setVisible(rep);
		bool po = false;
		for (const auto &x : fl)
			if (x.toObject().value(QStringLiteral("id")).toString() == QStringLiteral("posting"))
				po = x.toObject().value(QStringLiteral("on")).toBool();
		postsBtn_->setVisible(po);
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
	ff->addRow(yt);
	form->setVisible(false);
	v->addWidget(info);
	v->addWidget(autoInfo);
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
							 QStringLiteral("   ") + p.value(QStringLiteral("status")).toString() + (flagged ? QStringLiteral(" / check") : QString()),
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
	connect(upB, &QPushButton::clicked, dlg, [=]() { ytAction(true); });
	connect(chkB, &QPushButton::clicked, dlg, [=]() { ytAction(false); });
	// Auto-post mode (F7): read-only line.
	api_->get(QStringLiteral("ui/api/posts/auto"), [=](bool ok, const QJsonObject &r, const QString &) {
		if (!guard || !ok)
			return;
		const QJsonObject m = r.value(QStringLiteral("mode")).toObject();
		autoInfo->setText(QStringLiteral("Auto-post: %1, %2 rule(s), %3. %4 planned action(s).")
					  .arg(m.value(QStringLiteral("enabled")).toBool() ? QStringLiteral("ON") : QStringLiteral("off (review-first)"))
					  .arg(m.value(QStringLiteral("ruleCount")).toInt())
					  .arg(m.value(QStringLiteral("autoUpload")).toBool() ? QStringLiteral("approve and upload (private)") : QStringLiteral("approve only"))
					  .arg(r.value(QStringLiteral("plan")).toArray().size()));
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
	for (const auto &c : addChoices(structure_, kind))
		addPick_->addItem(c.first, c.second);
}

// Meld-style add-layer window (D274): the kinds on the left with what each one is, on the right a searchable list of
// what it can be made from (or a text / colour field), Add (or a double-click) sends the same layer.add as the row.
// User-opened only; closes after a successful send.
void MainWindow::openAddLayer()
{
	if (live_)
		return note(QStringLiteral("Live: scenes and layers cannot be added or removed."));
	auto *dlg = new QDialog(this);
	dlg->setAttribute(Qt::WA_DeleteOnClose);
	dlg->setWindowTitle(QStringLiteral("Add layer to \"%1\"").arg(activeScene_));
	auto *h = new QHBoxLayout(dlg);
	auto *kinds = new QListWidget(dlg);
	for (const auto &k : kLayerKinds) {
		auto *it = new QListWidgetItem(QString::fromLatin1(k.label), kinds);
		it->setData(Qt::UserRole, QString::fromLatin1(k.kind));
		it->setToolTip(QString::fromLatin1(k.about));
	}
	kinds->setMaximumWidth(170);
	h->addWidget(kinds);
	auto *right = new QVBoxLayout();
	auto *about = new QLabel(dlg);
	about->setWordWrap(true);
	auto *search = new QLineEdit(dlg);
	search->setPlaceholderText(QStringLiteral("Search"));
	search->setClearButtonEnabled(true);
	auto *choices = new QListWidget(dlg);
	auto *text = new QLineEdit(dlg);
	text->setMaxLength(2000);
	auto *colour = new QPushButton(QStringLiteral("Pick colour..."), dlg);
	auto *row = new QHBoxLayout();
	auto *add = new QPushButton(QStringLiteral("Add"), dlg);
	auto *cancel = new QPushButton(QStringLiteral("Close"), dlg);
	add->setDefault(true);
	row->addStretch(1);
	row->addWidget(add);
	row->addWidget(cancel);
	right->addWidget(about);
	right->addWidget(search);
	right->addWidget(choices, 1);
	right->addWidget(text);
	right->addWidget(colour);
	right->addStretch(0);
	right->addLayout(row);
	h->addLayout(right, 1);
	auto fill = [this, kinds, about, search, choices, text, colour]() {
		const QListWidgetItem *k = kinds->currentItem();
		const QString kind = k ? k->data(Qt::UserRole).toString() : QString();
		const bool typed = kind == QStringLiteral("color") || kind == QStringLiteral("text");
		about->setText(k ? k->toolTip() : QString());
		search->setVisible(!typed);
		choices->setVisible(!typed);
		text->setVisible(typed);
		colour->setVisible(kind == QStringLiteral("color"));
		text->setPlaceholderText(kind == QStringLiteral("color") ? QStringLiteral("#RRGGBB") : QStringLiteral("Text"));
		choices->clear();
		search->clear();
		for (const auto &c : addChoices(structure_, kind)) {
			auto *it = new QListWidgetItem(c.first, choices);
			it->setData(Qt::UserRole, c.second);
		}
		if (!typed && choices->count() == 0)
			new QListWidgetItem(QStringLiteral("(nothing to pick: the project has none)"), choices);
		choices->setCurrentRow(0);
	};
	connect(kinds, &QListWidget::currentRowChanged, dlg, fill);
	connect(search, &QLineEdit::textChanged, dlg, [choices](const QString &q) {
		for (int i = 0; i < choices->count(); i++)
			choices->item(i)->setHidden(!q.isEmpty() && !choices->item(i)->text().contains(q, Qt::CaseInsensitive));
	});
	connect(colour, &QPushButton::clicked, dlg, [dlg, text]() {
		const QColor c = QColorDialog::getColor(QColor(text->text().trimmed()), dlg, QStringLiteral("Layer colour"));
		if (c.isValid())
			text->setText(c.name(QColor::HexRgb));
	});
	const QPointer<QDialog> guard(dlg);
	auto send = [this, guard, kinds, choices, text]() {
		if (!guard)
			return;
		const QListWidgetItem *k = kinds->currentItem();
		const QListWidgetItem *c = choices->currentItem();
		QString err;
		const QJsonObject b = layerAddBody(activeScene_, k ? k->data(Qt::UserRole).toString() : QString(),
						   c && !c->isHidden() ? c->data(Qt::UserRole).toString() : QString(), text->text(), err);
		if (!k || !err.isEmpty())
			return note(k ? err : QStringLiteral("Pick a kind first."));
		structureEdit(b);
		guard->close();
	};
	connect(add, &QPushButton::clicked, dlg, send);
	connect(choices, &QListWidget::itemDoubleClicked, dlg, [send](QListWidgetItem *) { send(); });
	connect(cancel, &QPushButton::clicked, dlg, &QDialog::close);
	kinds->setCurrentRow(0);
	dlg->resize(620, 380);
	dlg->show();
}

void MainWindow::structureEdit(const QJsonObject &body)
{
	if (live_)
		return note(QStringLiteral("Live: scenes and layers cannot be added or removed."));
	api_->post(QStringLiteral("ui/api/project/structure"), body, [this](bool ok, const QJsonObject &b, const QString &err) {
		if (!ok) {
			const QString detail = b.value(QStringLiteral("detail")).toString();
			note(QStringLiteral("Not done: ") + err + (detail.isEmpty() ? QString() : QStringLiteral(" (") + detail + QStringLiteral(")")));
		} else {
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
	else if (cl.value(QStringLiteral("queued")).toInt() > 0)
		t = QStringLiteral("Clips waiting: %1").arg(cl.value(QStringLiteral("queued")).toInt());
	else if (allOff)
		t = QStringLiteral("Clips: off");
	else if (cl.value(QStringLiteral("available")).isBool() && !cl.value(QStringLiteral("available")).toBool())
		t = QStringLiteral("Clips: not set up");
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

void MainWindow::saveSettings(const QJsonObject &body)
{
	api_->post(QStringLiteral("ui/api/settings"), body, [this](bool ok, const QJsonObject &r, const QString &err) {
		if (!ok)
			return note(QStringLiteral("Settings not saved: ") + err);
		Q_UNUSED(r);
		note(QStringLiteral("Settings saved."));
		pollStatus();
	});
}

void MainWindow::openSettings(bool firstRun)
{
	api_->get(QStringLiteral("ui/api/settings"), [this, firstRun](bool ok, const QJsonObject &b, const QString &err) {
		if (!ok)
			return note(QStringLiteral("Settings not available: ") + err);
		const QJsonObject st = b.value(QStringLiteral("settings")).toObject(), cl = b.value(QStringLiteral("clips")).toObject();
		const QJsonObject c = st.value(QStringLiteral("clips")).toObject(), f = st.value(QStringLiteral("folders")).toObject();
		QDialog dlg(this);
		dlg.setWindowTitle(firstRun ? QStringLiteral("Welcome: clips") : QStringLiteral("Settings"));
		auto *v = new QVBoxLayout(&dlg);
		if (firstRun) {
			auto *intro = new QLabel(QStringLiteral("Ujwalam can find the best moments in your recordings and streams and edit them into short clips.\nHow should it do that? You can change this later in Settings."), &dlg);
			intro->setWordWrap(true);
			v->addWidget(intro);
		}
		auto *clipBox = new QGroupBox(QStringLiteral("Clips"), &dlg);
		auto *cf = new QFormLayout(clipBox);
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
			auto *warn = new QLabel(QStringLiteral("Clips can't be made on this PC yet: ") + cl.value(QStringLiteral("reason")).toString(), clipBox);
			warn->setWordWrap(true);
			cf->addRow(warn);
		}
		v->addWidget(clipBox);
		auto *dirBox = new QGroupBox(QStringLiteral("Where files are saved"), &dlg);
		auto *df = new QFormLayout(dirBox);
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
			connect(pick, &QPushButton::clicked, &dlg, [edit, &dlg]() {
				const QString d = QFileDialog::getExistingDirectory(&dlg, QStringLiteral("Choose a folder"), edit->text());
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
		df->addRow(hint);
		v->addWidget(dirBox);
		auto *bb = new QDialogButtonBox(QDialogButtonBox::Save | QDialogButtonBox::Cancel, &dlg);
		connect(bb, &QDialogButtonBox::accepted, &dlg, &QDialog::accept);
		connect(bb, &QDialogButtonBox::rejected, &dlg, &QDialog::reject);
		v->addWidget(bb);
		dlg.resize(620, dlg.sizeHint().height());
		if (dlg.exec() != QDialog::Accepted) {
			if (firstRun) // nothing chosen: keep "ask each time", and stop asking at every start
				saveSettings(QJsonObject{{QStringLiteral("clips"), QJsonObject{{QStringLiteral("recording"), QStringLiteral("ask")}, {QStringLiteral("live"), QStringLiteral("ask")}}}});
			return;
		}
		const auto dir = [](QLineEdit *e) { return e->text().trimmed().isEmpty() ? QJsonValue() : QJsonValue(e->text().trimmed()); };
		QJsonObject body;
		body.insert(QStringLiteral("clips"), QJsonObject{{QStringLiteral("recording"), rec->currentData().toString()}, {QStringLiteral("live"), liv->currentData().toString()}});
		body.insert(QStringLiteral("folders"), QJsonObject{{QStringLiteral("recordings"), dir(recRow.second)}, {QStringLiteral("clips"), dir(clipRow.second)}});
		saveSettings(body);
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
	shown.insert(QStringLiteral("report"), !reportBtn_->isHidden());
	shown.insert(QStringLiteral("posts"), !postsBtn_->isHidden());
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
	o.insert(QStringLiteral("clips"), pillClips_->text());
	o.insert(QStringLiteral("clipAsks"), clips_.value(QStringLiteral("asks")).toArray().size());
	o.insert(QStringLiteral("clipSettings"), clips_.value(QStringLiteral("settings")));
	return o;
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
