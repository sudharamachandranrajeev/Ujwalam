// SPDX-License-Identifier: GPL-3.0-or-later
// Theme specimen (D336, T1 of the theme framework; flag theme-components): Settings > Appearance > "Preview all
// components" opens one window with every component the theme framework styles, in every state the packs describe:
// buttons (plain, primary, danger, checked, disabled, toolbar), round transport controls (idle, live, recording,
// disabled), inputs (normal, error with helper text, disabled, list, number), tabs, check boxes, switches (on, off,
// disabled), sliders (with the value bubble), chips, cards and stat cards, a list, toasts (normal, failed), progress,
// a stepper and the heading styles. It shows the current theme and follows a theme switch at once (the same widgets
// restyle), so a pack can be judged component by component. Nothing on it does anything.
#pragma once

#include <QDialog>
#include <QJsonObject>

class QWidget;

namespace appearance {

class Specimen : public QDialog {
	Q_OBJECT
public:
	explicit Specimen(QWidget *parent);
	QWidget *body() const { return body_; } // the whole sheet (the probe pictures it uncut)

private:
	QWidget *body_ = nullptr;
};

// Probe (tests): the open specimen's sections and what its painted parts show; {"open": false} when none is open.
QJsonObject specimenProbe();
// After a layout pass (the probe's picture): value bubbles are placed again over their handles.
void specimenRefresh();

} // namespace appearance
