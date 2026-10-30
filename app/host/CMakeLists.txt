# SPDX-License-Identifier: GPL-2.0-or-later
#
# ujwalam-host: the production libobs host (studio, previews, output graph, local JSON-RPC API).
#
# Consumer build against a pinned OBS release without building OBS (same method as app/spike, P1a):
#   OBS_SOURCE_DIR   checkout of obs-studio at the pinned tag (headers only are used)
#   OBS_RUNTIME_DIR  copy of the matching OBS runtime (bin/64bit/obs.dll is read to make an import lib)
# Nothing here hardcodes a user path; both are cache variables passed with -D.

cmake_minimum_required(VERSION 3.24)
project(ujwalam_host LANGUAGES C CXX)

set(OBS_SOURCE_DIR "" CACHE PATH "obs-studio source checkout at the pinned tag")
set(OBS_RUNTIME_DIR "" CACHE PATH "OBS runtime copy (contains bin/64bit/obs.dll)")

if(NOT MSVC)
  message(FATAL_ERROR "ujwalam-host is Windows/MSVC only for now")
endif()
foreach(var OBS_SOURCE_DIR OBS_RUNTIME_DIR)
  if(NOT ${var} OR NOT EXISTS "${${var}}")
    message(FATAL_ERROR "Set -D${var}=<path> (got '${${var}}')")
  endif()
endforeach()

set(OBS_DLL "${OBS_RUNTIME_DIR}/bin/64bit/obs.dll")
if(NOT EXISTS "${OBS_DLL}")
  message(FATAL_ERROR "obs.dll not found at ${OBS_DLL}")
endif()

# --- generated obsconfig.h (consumer build: release build, no baked-in paths) ---
set(OBS_RELEASE_CANDIDATE 0)
set(OBS_BETA 0)
configure_file("${OBS_SOURCE_DIR}/libobs/obsconfig.h.in" "${CMAKE_BINARY_DIR}/generated/obsconfig.h")

# --- import library for obs.dll ---
find_program(DUMPBIN_EXE dumpbin REQUIRED)
find_program(LIB_EXE lib REQUIRED)
execute_process(COMMAND "${DUMPBIN_EXE}" /nologo /exports "${OBS_DLL}"
                OUTPUT_VARIABLE _exports RESULT_VARIABLE _rc)
if(NOT _rc EQUAL 0)
  message(FATAL_ERROR "dumpbin /exports failed on ${OBS_DLL}")
endif()
string(REGEX MATCHALL "\n +[0-9]+ +[0-9A-F]+ [0-9A-F]+ [A-Za-z_][A-Za-z0-9_@?$]*" _lines "${_exports}")
set(_def "LIBRARY obs.dll\nEXPORTS\n")
set(_count 0)
foreach(_l IN LISTS _lines)
  string(REGEX REPLACE "^\n +[0-9]+ +[0-9A-F]+ [0-9A-F]+ " "" _name "${_l}")
  string(APPEND _def "  ${_name}\n")
  math(EXPR _count "${_count} + 1")
endforeach()
file(WRITE "${CMAKE_BINARY_DIR}/obs.def" "${_def}")
execute_process(COMMAND "${LIB_EXE}" /nologo /def:${CMAKE_BINARY_DIR}/obs.def /machine:x64
                        /out:${CMAKE_BINARY_DIR}/obs.lib RESULT_VARIABLE _rc)
if(NOT _rc EQUAL 0)
  message(FATAL_ERROR "lib /def failed")
endif()
message(STATUS "obs.lib generated from ${_count} exports of ${OBS_DLL}")

add_library(obs_import INTERFACE)
target_include_directories(obs_import INTERFACE "${CMAKE_BINARY_DIR}/generated" "${OBS_SOURCE_DIR}/libobs")
target_link_libraries(obs_import INTERFACE "${CMAKE_BINARY_DIR}/obs.lib")

add_executable(ujwalam-host
  src/main.cpp
  src/methods.cpp
  src/json.cpp
  src/rpc_server.cpp
  src/log.cpp
  src/discovery.cpp
  src/obs_runtime.cpp
  src/studio.cpp
  src/model.cpp
  src/devices.cpp
  src/preview.cpp
  src/outputs.cpp
  src/stats.cpp
  src/overlay.cpp)
set_target_properties(ujwalam-host PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON)
target_compile_definitions(ujwalam-host PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN _CRT_SECURE_NO_WARNINGS)
target_compile_options(ujwalam-host PRIVATE /W3 /utf-8 /wd4244 /wd4267 /EHsc)
# obs.dll lives in the runtime dir, not next to the exe: delay-load it so the host can put the runtime on PATH
# (from --runtime) before the first libobs call.
target_link_libraries(ujwalam-host PRIVATE obs_import delayimp ws2_32 bcrypt advapi32 user32 psapi shell32 ole32 oleaut32 strmiids uuid)
target_link_options(ujwalam-host PRIVATE /DELAYLOAD:obs.dll)

# libobs plugins launch helper processes from the HOST executable's directory: obs-ffmpeg-mux.exe (ffmpeg_muxer
# file output), obs-nvenc-test.exe (without it obs-nvenc does not initialise), obs-qsv-test.exe, obs-amf-test.exe.
foreach(helper obs-ffmpeg-mux obs-nvenc-test obs-qsv-test obs-amf-test)
  add_custom_command(TARGET ujwalam-host POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${OBS_RUNTIME_DIR}/bin/64bit/${helper}.exe" "$<TARGET_FILE_DIR:ujwalam-host>/${helper}.exe")
endforeach()
