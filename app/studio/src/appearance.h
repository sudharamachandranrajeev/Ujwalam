// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Appearance (D293): the theme picker (a card per theme with a small drawn preview of its colours, corners,
// glow and bevel, and a row of its colour swatches), the "High performance" switch (2026-11-10: flat, no animation),
// the "Reduce effects" switch and the motion choice (moved here from Advanced). The page scrolls. Choosing a theme or
// switching the effects changes the whole window at once so it can be judged; Save keeps it, Cancel (revert()) puts the
// old look back.
#pragma once

#include <QString>
#include <QWidget>

class QCheckBox;
class QComboBox;

namespace appearance {

class Page : public QWidget {
	Q_OBJECT
public:
	// themeNow / effectsNow / motionNow: what the window uses when the page opens (settings.json values or defaults).
	Page(const QString &themeNow, const QString &effectsNow, const QString &motionNow, QWidget *parent);
	QString themeId() const;
	QString effects() const;
	QString motion() const;
	bool changedTheme() const { return themeId() != themeNow_; }
	bool changedEffects() const { return effects() != effectsNow_; }
	void revert(); // back to what the window had when the page opened
	// Probe (tests): click a theme card by id.
	bool pick(const QString &id);

private:
	QString themeNow_, effectsNow_;
	QString chosen_;
	QCheckBox *reduce_ = nullptr;
	QCheckBox *perf_ = nullptr;
	bool reduceBefore_ = false; // Reduce effects as the user left it, before High performance went on (opened in performance: off)
	QComboBox *motion_ = nullptr;
};

} // namespace appearance
