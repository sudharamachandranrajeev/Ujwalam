// SPDX-License-Identifier: GPL-3.0-or-later
// Layer list with press-and-drag reordering (D330). See layer_list.h.
#include "layer_list.h"
#include "theme.h"

#include <QApplication>
#include <QKeyEvent>
#include <QMouseEvent>
#include <QPainter>
#include <QScrollBar>
#include <QTimer>

#include <algorithm>

LayerList::LayerList(QWidget *parent) : QListWidget(parent), hold_(new QTimer(this))
{
	setDragDropMode(QAbstractItemView::NoDragDrop); // our own drag (no system drag and drop)
	setToolTip(QStringLiteral("Drag a layer up or down to change what is in front. Right-click for more."));
	hold_->setSingleShot(true);
	hold_->setInterval(QApplication::startDragTime());
	connect(hold_, &QTimer::timeout, this, [this]() {
		if (pressRow_ >= 0 && !dragging_ && (QApplication::mouseButtons() & Qt::LeftButton))
			begin(); // held still: picked up
	});
}

void LayerList::begin()
{
	dragging_ = true;
	gap_ = pressRow_;
	viewport()->setCursor(Qt::ClosedHandCursor);
	viewport()->update();
}

void LayerList::cancel()
{
	hold_->stop();
	const bool was = dragging_;
	dragging_ = false;
	pressRow_ = -1;
	gap_ = -1;
	viewport()->unsetCursor();
	if (was)
		viewport()->update();
}

int LayerList::gapAt(const QPoint &p) const
{
	const int n = count();
	for (int r = 0; r < n; r++) {
		const QRect rc = visualItemRect(item(r));
		if (p.y() < rc.center().y())
			return r;
	}
	return n;
}

int LayerList::gapY(int gap) const
{
	const int n = count();
	if (n == 0)
		return 0;
	if (gap < n)
		return visualItemRect(item(gap)).top();
	return visualItemRect(item(n - 1)).bottom() + 1;
}

void LayerList::mousePressEvent(QMouseEvent *e)
{
	QListWidget::mousePressEvent(e); // selects the row as before
	cancel();
	if (!enabled_ || e->button() != Qt::LeftButton)
		return;
	if (QListWidgetItem *it = itemAt(e->position().toPoint())) {
		pressRow_ = row(it);
		pressPos_ = e->position().toPoint();
		hold_->start();
	}
}

void LayerList::mouseMoveEvent(QMouseEvent *e)
{
	if (pressRow_ < 0 || !(e->buttons() & Qt::LeftButton)) {
		QListWidget::mouseMoveEvent(e);
		return;
	}
	const QPoint p = e->position().toPoint();
	if (!dragging_) {
		if ((p - pressPos_).manhattanLength() < QApplication::startDragDistance())
			return; // not picked up yet; no rubber-band selection either
		hold_->stop();
		begin();
	}
	// Near the top or bottom edge: scroll a row's height so a long list can be crossed.
	const int edge = 12;
	if (p.y() < edge)
		verticalScrollBar()->setValue(verticalScrollBar()->value() - verticalScrollBar()->singleStep());
	else if (p.y() > viewport()->height() - edge)
		verticalScrollBar()->setValue(verticalScrollBar()->value() + verticalScrollBar()->singleStep());
	const int g = gapAt(p);
	if (g != gap_) {
		gap_ = g;
		viewport()->update();
	}
}

void LayerList::mouseReleaseEvent(QMouseEvent *e)
{
	const bool was = dragging_ && e->button() == Qt::LeftButton;
	const int from = pressRow_;
	const int gap = was ? gapAt(e->position().toPoint()) : -1;
	const bool inside = viewport()->rect().adjusted(-4, -4, 4, 4).contains(e->position().toPoint());
	cancel();
	QListWidget::mouseReleaseEvent(e);
	if (!was || !inside || from < 0 || from >= count())
		return;
	const int to = gap > from ? gap - 1 : gap; // the row it ends at once taken out of its old place
	if (to == from)
		return;
	if (QListWidgetItem *it = item(from))
		emit moveRequested(it->data(Qt::UserRole).toString(), to);
}

void LayerList::keyPressEvent(QKeyEvent *e)
{
	if (dragging_ && e->key() == Qt::Key_Escape) {
		cancel();
		e->accept();
		return;
	}
	QListWidget::keyPressEvent(e);
}

void LayerList::paintEvent(QPaintEvent *e)
{
	QListWidget::paintEvent(e);
	if (!dragging_ || gap_ < 0)
		return;
	QPainter p(viewport());
	p.setRenderHint(QPainter::Antialiasing);
	const QColor c = theme::color(QStringLiteral("accent"));
	const int y = std::max(1, std::min(viewport()->height() - 2, gapY(gap_)));
	p.setPen(QPen(c, 2));
	p.drawLine(6, y, viewport()->width() - 6, y);
	p.setBrush(c);
	p.setPen(Qt::NoPen);
	p.drawEllipse(QPointF(5, y), 3.5, 3.5);
	if (QListWidgetItem *it = item(pressRow_)) { // the row being moved: a soft outline
		QColor f = c;
		f.setAlpha(60);
		p.setBrush(f);
		p.drawRoundedRect(visualItemRect(it).adjusted(2, 1, -2, -1), 4, 4);
	}
}

bool LayerList::probeDrag(int from, int to)
{
	const int n = count();
	if (from < 0 || from >= n || to < 0 || to >= n)
		return false;
	// the drop point: above row `to` when moving up, below it when moving down
	const QRect src = visualItemRect(item(from)), dst = visualItemRect(item(to));
	const QPoint a = src.center();
	const QPoint b = to < from ? QPoint(dst.center().x(), dst.top() + 2) : to > from ? QPoint(dst.center().x(), dst.bottom() - 2) : a;
	auto send = [this](QEvent::Type t, const QPoint &at, Qt::MouseButton btn, Qt::MouseButtons btns) {
		QMouseEvent ev(t, QPointF(at), viewport()->mapToGlobal(QPointF(at)), btn, btns, Qt::NoModifier);
		QApplication::sendEvent(viewport(), &ev);
	};
	send(QEvent::MouseButtonPress, a, Qt::LeftButton, Qt::LeftButton);
	const QPoint mid((a.x() + b.x()) / 2, (a.y() + b.y()) / 2);
	send(QEvent::MouseMove, a + QPoint(0, (b.y() > a.y() ? 1 : -1) * (QApplication::startDragDistance() + 1)), Qt::NoButton, Qt::LeftButton);
	send(QEvent::MouseMove, mid, Qt::NoButton, Qt::LeftButton);
	send(QEvent::MouseMove, b, Qt::NoButton, Qt::LeftButton);
	send(QEvent::MouseButtonRelease, b, Qt::LeftButton, Qt::NoButton);
	return true;
}
