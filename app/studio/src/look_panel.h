// SPDX-License-Identifier: GPL-3.0-or-later
// The Look panel (D290): friendly controls for a layer's effects, built from a table of effect types so a new type
// shows up without code here. Each type is a card with an on/off switch and its sliders or colour pickers, grouped
// (Shape, Filters, Camera, Blend, Shadow & glow). The panel edits the layer's whole effects list: types it does not
// know, and further copies of a type, stay as they are. It never talks to the server; the window sends the list.
#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QList>
#include <QMap>
#include <QString>
#include <QWidget>

class QDoubleSpinBox;
class QFrame;
class QLabel;
class QLineEdit;
class QPushButton;
class QSlider;
class QTimer;
class QVBoxLayout;
class Switch;

struct LookParam {
	QString key, label;
	bool colour = false;
	double lo = 0, hi = 1, def = 0, step = 0.1;
	int dec = 1;
	QString cdef; // default colour (#rrggbb)
};
struct LookType {
	QString type, label, group;
	QList<LookParam> params;
};

class LookPanel : public QWidget {
	Q_OBJECT
public:
	explicit LookPanel(QWidget *parent = nullptr);
	void setTypes(const QList<LookType> &types); // builds the cards once
	void setEffects(const QJsonArray &effects);  // shows this list; no signal
	QJsonArray effects() const { return effects_; }
	void clearPending();    // drops an unsent change (another layer was selected)
	void setLive(bool live); // live: changes wait for the Apply button (each send needs "yes, on air")
	void setMax(int n) { max_ = n; }
	// Headless probe: what the panel shows; probe actions toggle and set through the real widgets.
	QJsonObject probe() const;
	bool probeToggle(const QString &type, bool on);
	bool probeSet(const QString &type, const QString &key, double value);

signals:
	void edited(const QJsonArray &effects); // at once, on every change
	void commit();                          // after a short pause (offline), or when Apply is pressed (live)
	void limit(const QString &why);

private:
	struct Card {
		LookType t;
		QFrame *frame = nullptr;
		Switch *sw = nullptr;
		QWidget *body = nullptr;
		QMap<QString, QSlider *> sliders;
		QMap<QString, QDoubleSpinBox *> spins;
		QMap<QString, QLineEdit *> hex;
		QMap<QString, QPushButton *> swatches;
	};
	int indexOf(const QString &type) const;
	void toggle(Card &c, bool on);
	void setParam(const QString &type, const QString &key, const QJsonValue &v);
	void changed();
	QJsonObject defaultOf(const LookType &t) const;

	QList<Card> cards_;
	QJsonArray effects_;
	QTimer *debounce_;
	QVBoxLayout *root_;
	QWidget *liveBar_;
	QPushButton *apply_;
	QLabel *empty_;
	bool live_ = false, dirty_ = false;
	int max_ = 6;
};
