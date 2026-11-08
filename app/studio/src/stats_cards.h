// SPDX-License-Identifier: GPL-3.0-or-later
// Stats cards (D287), after the reference: session time plus GPU, CPU and frame-rate cards with a small history
// line each. Fed by the existing status poll (every 2 s): no timer of its own except a 1 s clock while live, no
// animation, and a card repaints only when a new sample arrives.
#pragma once

#include <QList>
#include <QWidget>

class QLabel;

class Sparkline : public QWidget {
public:
	Sparkline(double lo, double hi, QWidget *parent);
	void push(double v);
	void setRange(double lo, double hi) { lo_ = lo, hi_ = hi; }
	int count() const { return int(v_.size()); }

protected:
	void paintEvent(QPaintEvent *) override;

private:
	QList<double> v_;
	double lo_, hi_;
};

class StatsCards : public QWidget {
public:
	explicit StatsCards(QWidget *parent);
	// One status sample. live/recording: session clock runs while either is on.
	void sample(double cpuPct, double gpuPct, double fps, int dropped, bool live, bool recording);
	QString sessionText() const;
	int samples() const;

private:
	void tickClock();
	QLabel *session_, *sessionNote_, *cpuV_, *gpuV_, *fpsV_;
	Sparkline *cpu_, *gpu_, *fps_;
	qint64 since_ = 0;
	bool active_ = false;
	class QTimer *clock_;
};
