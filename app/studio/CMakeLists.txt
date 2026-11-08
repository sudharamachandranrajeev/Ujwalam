# SPDX-License-Identifier: GPL-3.0-or-later
# Ujwalam studio shell (P5a): Qt 6 Widgets UI, a native client of the studio UI server
# (docs/plan/2026-11-06-p5a-qt-shell-plan.md). libobs stays in ujwalam-host; this links Qt only.
cmake_minimum_required(VERSION 3.24)
project(ujwalam-studio LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 6.8 REQUIRED COMPONENTS Widgets Network)

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
	src/icons.cpp
	src/icons.h
	src/look_panel.cpp
	src/look_panel.h
	src/main_window.cpp
	src/main_window.h
	src/motion.cpp
	src/motion.h
	src/stats_cards.cpp
	src/stats_cards.h
	src/taskbar.cpp
	src/taskbar.h
	src/theme.cpp
	src/theme.h)
# Built-in theme packs (D293): data/themes/*.json embedded as :/themes/<id>.json. A file with the same id next to the
# exe, in the app-data folder or the repo replaces the embedded one; a new id there is a custom theme.
file(GLOB UJW_THEME_FILES CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/../../data/themes/*.json")
list(FILTER UJW_THEME_FILES EXCLUDE REGEX "\.schema\.json$")
qt_add_resources(ujwalam-studio themes PREFIX "/themes" BASE "${CMAKE_CURRENT_SOURCE_DIR}/../../data/themes" FILES ${UJW_THEME_FILES})
target_link_libraries(ujwalam-studio PRIVATE Qt6::Widgets Qt6::Network)
if(WIN32)
	target_link_libraries(ujwalam-studio PRIVATE user32)
endif()
if(MSVC)
	target_compile_options(ujwalam-studio PRIVATE /W4 /permissive- /utf-8)
endif()
