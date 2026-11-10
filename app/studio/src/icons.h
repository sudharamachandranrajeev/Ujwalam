// SPDX-License-Identifier: GPL-3.0-or-later
// Toolbar and control icons (D290), drawn with QPainter on a 24 x 24 grid: no icon pack, no image files, no fonts.
#pragma once

#include <QColor>
#include <QIcon>
#include <QString>

namespace icons {

// name: play | stop | record | clip | flag | undo | redo | folder | gear | plus | more | sliders | trash. Unknown names give an empty icon.
// The icon has a normal and a dimmed (disabled) pixmap, 2x for sharp edges on high-DPI screens.
QIcon make(const QString &name, const QColor &colour, int px = 20, const QColor &disabled = QColor());

} // namespace icons
