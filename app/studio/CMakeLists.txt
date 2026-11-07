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
	src/api_client.cpp
	src/api_client.h
	src/main_window.cpp
	src/main_window.h)
target_link_libraries(ujwalam-studio PRIVATE Qt6::Widgets Qt6::Network)
if(MSVC)
	target_compile_options(ujwalam-studio PRIVATE /W4 /permissive- /utf-8)
endif()
