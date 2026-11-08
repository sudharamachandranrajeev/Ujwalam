// SPDX-License-Identifier: GPL-3.0-or-later
#include "theme.h"

#include <QApplication>
#include <QColor>
#include <QPalette>
#include <QStyleFactory>

namespace theme {

void apply(QApplication &app)
{
	app.setStyle(QStyleFactory::create(QStringLiteral("Fusion")));
	QPalette p;
	const QColor bg(kBg), panel(kPanel), field(kField), text(kText), muted(kMuted), accent(kAccent);
	p.setColor(QPalette::Window, bg);
	p.setColor(QPalette::WindowText, text);
	p.setColor(QPalette::Base, panel);
	p.setColor(QPalette::AlternateBase, field);
	p.setColor(QPalette::Text, text);
	p.setColor(QPalette::Button, field);
	p.setColor(QPalette::ButtonText, text);
	p.setColor(QPalette::ToolTipBase, field);
	p.setColor(QPalette::ToolTipText, text);
	p.setColor(QPalette::PlaceholderText, muted);
	p.setColor(QPalette::Highlight, accent);
	p.setColor(QPalette::HighlightedText, QColor(Qt::white));
	p.setColor(QPalette::Link, QColor(kAccentHi));
	for (auto role : {QPalette::WindowText, QPalette::Text, QPalette::ButtonText})
		p.setColor(QPalette::Disabled, role, QColor(0x5d, 0x59, 0x72));
	app.setPalette(p);

	// Sizes in px scale with the display (Qt high-DPI), so text keeps its room at 125 % and 150 %.
	app.setStyleSheet(QStringLiteral(R"(
QWidget { font-family: "Segoe UI"; font-size: 10pt; }
QToolButton { background: %3; color: %5; border: 1px solid %4; border-radius: 8px; padding: 5px 12px; }
QToolButton:hover { border-color: %7; }
QToolButton::menu-indicator { image: none; width: 0; }
QMenu { background: %3; color: %5; border: 1px solid %4; border-radius: 8px; padding: 4px; }
QMenu::item { padding: 6px 18px; border-radius: 6px; }
QMenu::item:selected { background: %7; color: white; }
QMainWindow, QDialog { background: %1; }
QToolTip { background: %3; color: %5; border: 1px solid %4; padding: 4px; }
QGroupBox { background: %2; border: 1px solid %4; border-radius: 12px; margin-top: 18px; padding: 10px 8px 8px 8px; }
QGroupBox::title { subcontrol-origin: margin; subcontrol-position: top left; left: 10px; padding: 0 4px; color: %6;
  font-size: 8pt; font-weight: 600; }
QLabel#heading { color: %6; font-size: 8pt; font-weight: 600; }
QLabel#pill { background: %3; border: 1px solid %4; border-radius: 10px; padding: 3px 10px; color: %5; }
QPushButton { background: %3; color: %5; border: 1px solid %4; border-radius: 8px; padding: 5px 12px; min-height: 18px; }
QPushButton:hover { border-color: %7; }
QPushButton:pressed { background: %4; }
QPushButton:disabled { color: #5d5972; border-color: %3; }
QPushButton:checked { background: %7; border-color: %7; color: white; }
QPushButton[role="primary"] { background: %7; border-color: %7; color: white; font-weight: 600; }
QPushButton[role="primary"]:hover { background: %8; border-color: %8; }
QPushButton[role="danger"] { background: transparent; border-color: %9; color: %9; font-weight: 600; }
QPushButton[role="danger"]:checked { background: %9; color: white; }
QPushButton[role="primary"]:disabled, QPushButton[role="danger"]:disabled { background: %3; border-color: %4; color: #5d5972; }
QListWidget, QTreeWidget, QTableWidget, QPlainTextEdit, QTextEdit { background: %2; border: 1px solid %4; border-radius: 10px; padding: 4px; }
QListWidget::item { padding: 4px 6px; border-radius: 6px; }
QListWidget::item:selected { background: %7; color: white; }
QListWidget::item:hover:!selected { background: %3; }
QLineEdit, QSpinBox, QDoubleSpinBox, QComboBox { background: %3; border: 1px solid %4; border-radius: 8px; padding: 4px 8px; color: %5;
  selection-background-color: %7; }
QLineEdit:focus, QSpinBox:focus, QDoubleSpinBox:focus, QComboBox:focus { border-color: %7; }
QComboBox QAbstractItemView { background: %3; border: 1px solid %4; selection-background-color: %7; }
QCheckBox::indicator, QListWidget::indicator { width: 16px; height: 16px; border-radius: 4px; border: 1px solid #4a4566; background: %3; }
QCheckBox::indicator:checked, QListWidget::indicator:checked { background: %7; border-color: %7; }
QSlider::groove:horizontal { height: 4px; background: %4; border-radius: 2px; }
QSlider::sub-page:horizontal { background: %7; border-radius: 2px; }
QSlider::handle:horizontal { background: white; width: 14px; margin: -6px 0; border-radius: 7px; }
QProgressBar { background: %3; border: 1px solid %4; border-radius: 6px; text-align: center; }
QProgressBar::chunk { background: %7; border-radius: 6px; }
QScrollArea { border: none; background: transparent; }
QScrollArea > QWidget > QWidget { background: transparent; }
QScrollBar:vertical { background: transparent; width: 10px; margin: 2px; }
QScrollBar::handle:vertical { background: %4; border-radius: 4px; min-height: 24px; }
QScrollBar:horizontal { background: transparent; height: 10px; margin: 2px; }
QScrollBar::handle:horizontal { background: %4; border-radius: 4px; min-width: 24px; }
QScrollBar::add-line, QScrollBar::sub-line { width: 0; height: 0; }
QSplitter::handle { background: transparent; }
QStatusBar { background: %1; color: %6; }
QTabBar::tab { background: %3; color: %6; border: 1px solid %4; border-radius: 8px; padding: 4px 12px; margin-right: 4px; }
QTabBar::tab:selected { background: %7; color: white; border-color: %7; }
)")
				   .arg(QLatin1String(kBg), QLatin1String(kPanel), QLatin1String(kField), QLatin1String(kBorder), QLatin1String(kText),
					QLatin1String(kMuted), QLatin1String(kAccent), QLatin1String(kAccentHi), QLatin1String(kDanger)));
}

} // namespace theme
