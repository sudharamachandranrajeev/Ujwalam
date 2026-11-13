# SPDX-License-Identifier: GPL-3.0-or-later
# Ujwalam studio shell (P5a): Qt 6 Widgets UI, a native client of the studio UI server
# (docs/plan/2026-11-06-p5a-qt-shell-plan.md). libobs stays in ujwalam-host; this links Qt only.
cmake_minimum_required(VERSION 3.24)
project(ujwalam-studio LANGUAGES CXX)
if(WIN32)
	enable_language(RC)
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 6.8 REQUIRED COMPONENTS Widgets Network Qml Quick QuickControls2)
# QML modules in the exe's resources under :/qt/qml (QTP0001), the path loadFromModule looks in.
qt_policy(SET QTP0001 NEW)

add_executable(ujwalam-studio WIN32
	src/main.cpp
	src/add_dialogs.cpp
	src/add_dialogs.h
	src/appearance.cpp
	src/appearance.h
	src/depth.cpp
	src/depth.h
	src/interaction.cpp
	src/interaction.h
	src/api_client.cpp
	src/api_client.h
	src/autopost_card.cpp
	src/autopost_card.h
	src/coach.cpp
	src/coach.h
	src/connections_page.cpp
	src/connections_page.h
	src/guide.cpp
	src/guide.h
	src/help_panel.cpp
	src/help_panel.h
	src/hints.cpp
	src/hints.h
	src/icons.cpp
	src/icons.h
	src/layer_list.cpp
	src/layer_list.h
	src/look_panel.cpp
	src/look_panel.h
	src/main_window.cpp
	src/main_window.h
	src/qml_bridge.cpp
	src/qml_bridge.h
	src/qml_studio.cpp
	src/qml_studio.h
	src/motion.cpp
	src/motion.h
	src/soft.cpp
	src/soft.h
	src/stats_cards.cpp
	src/stats_cards.h
	src/stream_pages.cpp
	src/stream_pages.h
	src/switch_widget.cpp
	src/switch_widget.h
	src/studio_log.cpp
	src/studio_log.h
	# the host's crash reporter, shared (text report only; 2026-11-08 studio crash)
	../host/src/crash.cpp
	../host/src/crash.h
	src/taskbar.cpp
	src/taskbar.h
	src/tray.cpp
	src/tray.h
	src/theme.cpp
	src/theme.h
	src/specimen.cpp
	src/specimen.h
	src/value_slider.cpp
	src/value_slider.h)
# Built-in theme packs (D293): data/themes/*.json embedded as :/themes/<id>.json. A file with the same id next to the
# exe, in the app-data folder or the repo replaces the embedded one; a new id there is a custom theme.
file(GLOB UJW_THEME_FILES CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/../../data/themes/*.json")
list(FILTER UJW_THEME_FILES EXCLUDE REGEX "\.schema\.json$")
qt_add_resources(ujwalam-studio themes PREFIX "/themes" BASE "${CMAKE_CURRENT_SOURCE_DIR}/../../data/themes" FILES ${UJW_THEME_FILES})
# App icon: PNG sizes embedded for the window icon (QIcon needs no imageformats plugin); the .rc embeds the .ico in the exes.
file(GLOB UJW_ICON_PNGS CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/res/png/ujwalam-*.png")
qt_add_resources(ujwalam-studio appicon PREFIX "/icon" BASE "${CMAKE_CURRENT_SOURCE_DIR}/res/png" FILES ${UJW_ICON_PNGS})
target_link_libraries(ujwalam-studio PRIVATE Qt6::Widgets Qt6::Network Qt6::Qml Qt6::Quick Qt6::QuickControls2)
# The Qt Quick studio (D355, flag studio-qml): its screens, compiled into the exe. Api, Theme and PreviewView come from
# C++ (qml_studio.cpp registers them as module Ujwalam.Core).
qt_add_qml_module(ujwalam-studio
	URI Ujwalam.Studio
	VERSION 1.0
	QML_FILES
		qml/Main.qml
		qml/Store.qml
		qml/OnAirBar.qml
		qml/ScenesPanel.qml
		qml/LayersPanel.qml
		qml/MixerPanel.qml
		qml/PreviewArea.qml
		qml/ConfirmDialog.qml
		qml/CloseDialog.qml
		qml/AddLayerDialog.qml
		qml/AddSceneDialog.qml
		qml/UButton.qml
		qml/UField.qml
		qml/UIconButton.qml
		qml/UPanel.qml
		qml/UChip.qml
		qml/UToggle.qml
		qml/USlider.qml
		qml/USwitch.qml
		qml/USpin.qml
		qml/UCombo.qml
		qml/UCard.qml
		qml/FeaturesCard.qml
		qml/SettingsPage.qml
		qml/SettingsClips.qml
		qml/SettingsAppearance.qml
		qml/SettingsStream.qml
		qml/OutputDialog.qml
		qml/SettingsDialog.qml)
if(WIN32)
	target_sources(ujwalam-studio PRIVATE res/ujwalam.rc)
endif()
if(WIN32)
	target_link_libraries(ujwalam-studio PRIVATE user32 dbghelp)
endif()
if(MSVC)
	target_compile_options(ujwalam-studio PRIVATE /W4 /permissive- /utf-8)
endif()

# ujwalam-start.exe (2026-11-08): the shortcuts' target. Starts the launcher with no console window, its output in a log
# file (src/start_stub.cpp). Win32 only, no Qt.
if(WIN32)
	add_executable(ujwalam-start WIN32 src/start_stub.cpp res/ujwalam.rc)
	target_link_libraries(ujwalam-start PRIVATE shell32 user32)
	if(MSVC)
		target_compile_options(ujwalam-start PRIVATE /W4 /permissive- /utf-8)
	endif()
endif()
