// SPDX-License-Identifier: GPL-3.0-or-later
// The layer list with press-and-drag reordering (D330, user 2026-11-10: "hold and drag layer to rearrange in a scene").
// Press a row and move the mouse (or hold it still for the system drag delay): the row is picked up, a line shows
// where it will land, release drops it there, Escape or a release outside the list puts it back. The list never moves
// the row itself: it asks (moveRequested) and the window sends the move and reloads the list from the host, so the
// list always shows the real order. No system drag and drop is used (no OLE, nothing leaves the window).
#pragma once

#include <QListWidget>

class QTimer;

class LayerList : public QListWidget {
	Q_OBJECT
public:
	explicit LayerList(QWidget *parent = nullptr);
	void setReorderEnabled(bool on) { enabled_ = on; } // off: presses select only
	bool dragging() const { return dragging_; }
	// Headless probe (tests only): a real press, moves and release from the middle of row `from` to the drop point
	// that puts the row at `to` (rows top first). false when a row is missing.
	bool probeDrag(int from, int to);

signals:
	// The row with layer id `id` should end at row `to` (top first, counted in the list as it is now).
	void moveRequested(const QString &id, int to);

protected:
	void mousePressEvent(QMouseEvent *e) override;
	void mouseMoveEvent(QMouseEvent *e) override;
	void mouseReleaseEvent(QMouseEvent *e) override;
	void keyPressEvent(QKeyEvent *e) override;
	void paintEvent(QPaintEvent *e) override;

private:
	void begin();
	void cancel();
	int gapAt(const QPoint &viewportPos) const; // 0..count(): drop before that row
	int gapY(int gap) const;                     // viewport y of the drop line

	bool enabled_ = true;
	int pressRow_ = -1;
	QPoint pressPos_;
	bool dragging_ = false;
	int gap_ = -1;
	QTimer *hold_;
};
