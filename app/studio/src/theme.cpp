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
QToolButton::menu-indicator { image: none; width: 0; }
QMenu { background: %3; color: %5; border: 1px solid %4; border-radius: 8px; padding: 4px; }
QMenu::item { padding: 6px 18px; border-radius: 6px; }
QMenu::item:selected { background: %7; color: white; }
QMainWindow, QDialog { background: %1; }
QToolTip { background: %3; color: %5; border: 1px solid %4; padding: 4px; }
QGroupBox { background: %2; border: 1px solid %4; border-radius: 16px; margin-top: 22px; padding: 16px 12px 12px 12px; }
QGroupBox::title { subcontrol-origin: margin; subcontrol-position: top left; left: 4px; padding: 0 4px; color: %6;
  font-size: 8pt; font-weight: 600; }
QFrame#strip { background: %3; border: 1px solid %4; border-radius: 14px; }
QFrame#strip QLabel { background: transparent; }
QLabel#heading { color: %6; font-size: 8pt; font-weight: 600; }
QLabel#pill { background: %3; border: 1px solid %4; border-radius: 10px; padding: 3px 10px; color: %5; }
QPushButton { background: %3; color: %5; border: 1px solid %4; border-radius: 8px; padding: 5px 12px; min-height: 18px; }
QPushButton:pressed { background: %4; }
QPushButton:disabled { color: #5d5972; border-color: %3; }
QPushButton:checked { background: %7; border-color: %7; color: white; }
QPushButton[role="primary"] { background: %7; border-color: %7; color: white; font-weight: 600; }
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
QLabel#muted { color: %6; background: transparent; }
QToolButton#taskClose { border: none; background: transparent; color: %6; padding: 0 6px; border-radius: 6px; }
QToolButton#taskClose:hover { background: %4; color: %5; }
QWidget#taskChip { background: %3; border: 1px solid %4; border-radius: 10px; }
QWidget#taskChip QLabel { background: transparent; color: %5; }
QFrame#taskPanel { background: %2; border: 1px solid %4; border-radius: 14px; }
QFrame#taskRow { background: %3; border: 1px solid %4; border-radius: 10px; }
QFrame#taskRow QLabel { background: transparent; }
QFrame#toast { background: %3; border: 1px solid %7; border-radius: 12px; }
QFrame#toast[failed="true"] { border-color: %9; }
QFrame#toast QLabel { background: transparent; }
QFrame#statCard { background: %2; border: 1px solid %4; border-radius: 12px; }
QFrame#statCard QLabel { background: transparent; }
QLabel#statName { color: %6; font-size: 8pt; font-weight: 600; }
QLabel#statValue { color: %5; font-size: 10pt; font-weight: 600; }
QLabel#statBig { color: %5; font-size: 20pt; font-weight: 600; }
QFrame#card { background: %2; border: 1px solid %4; border-radius: 16px; }
QFrame#card QLabel { background: transparent; }
QLabel#ctlCaption { color: %6; font-size: 8pt; background: transparent; }
QLabel#brand { font-size: 14pt; font-weight: 700; color: %5; padding-right: 6px; background: transparent; }
QPushButton#tb, QToolButton#tb { background: transparent; border: none; border-radius: 10px; padding: 6px 12px; color: %5; font-size: 9pt; min-height: 20px; }
QPushButton#tb:disabled { color: #5d5972; background: transparent; }
QPushButton#round { background: %3; border: 1px solid %4; border-radius: 26px; padding: 0; min-width: 52px; max-width: 52px; min-height: 52px; max-height: 52px; }
QPushButton#round:pressed { background: %4; }
QPushButton#round:disabled { background: %3; border: 1px solid %4; }
QPushButton#round[role="primary"] { background: %7; border: 1px solid %7; }
QPushButton#round[role="primary"][active="true"] { background: %9; border: 1px solid %9; }
QPushButton#round[role="primary"]:disabled { background: %3; border: 1px solid %4; }
QPushButton#round[role="danger"] { background: transparent; border: 2px solid %9; }
QPushButton#round[role="danger"][active="true"] { background: %9; }
QPushButton#round[role="danger"]:disabled { background: transparent; border: 2px solid %4; }
QFrame#lookCard { background: %3; border: 1px solid %4; border-radius: 12px; }
QFrame#lookCard QLabel { background: transparent; }
QLabel#lookName { font-weight: 600; font-size: 10pt; }
QListWidget#sceneCards { background: transparent; border: none; padding: 0; }
QListWidget#sceneCards::item { padding: 0; background: transparent; }
QListWidget#sceneCards::item:selected, QListWidget#sceneCards::item:hover { background: transparent; }
QListWidget#settingsNav { background: transparent; border: none; padding: 0; outline: none; }
QListWidget#settingsNav::item { padding: 10px 14px; border-radius: 10px; margin-bottom: 4px; color: %6; }
QListWidget#settingsNav::item:selected { background: %3; color: %5; font-weight: 600; }
QListWidget#settingsNav::item:hover:!selected { background: %2; }
QLabel#sectionTitle { font-size: 15pt; font-weight: 700; background: transparent; }
)")
				   .arg(QLatin1String(kBg), QLatin1String(kPanel), QLatin1String(kField), QLatin1String(kBorder), QLatin1String(kText),
					QLatin1String(kMuted), QLatin1String(kAccent), QLatin1String(kAccentHi), QLatin1String(kDanger), QLatin1String(kOk)));
}

} // namespace theme
