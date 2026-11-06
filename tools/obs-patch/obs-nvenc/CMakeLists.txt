# SPDX-License-Identifier: GPL-3.0-or-later
#
# Builds only obs-nvenc.dll from an obs-studio 32.1.2 checkout with one upstream fix applied (ADR
# docs/adr/2026-11-05-obs-nvenc-destroy-order.md). Driven by tools/obs-patch/build-obs-nvenc.mjs; do not run by hand.
#
# It links against the OFFICIAL shipped runtime (obs.dll, w32-pthreads.dll): import libs are generated from the
# DLLs' export tables, the same method as app/host/CMakeLists.txt, so the plugin binds to the exact 32.1.2 ABI.
# Compiler options mirror OBS's cmake/windows/compilerconfig.cmake + cmake/common/compiler_common.cmake for the
# Release config (C17, /W3 /utf-8 /Brepro /permissive- /Zc:preprocessor /Gy /Oi, /MD, /Zi, IPO = /GL + /LTCG,
# /OPT:REF /OPT:ICF /EMITTOOLVERSIONINFO:NO /DEBUG /Brepro) and the plugin's own CMakeLists (ENABLE_HEVC,
# REGISTER_FFMPEG_IDS). Release + LTCG matches the shipped DLL: its nvenc_destroy has d3d11_free_textures (another
# translation unit) inlined, which needs link-time code generation.
#   OBS_SOURCE_DIR   obs-studio checkout at tag 32.1.2, patched (untrusted download, read as sources only)
#   OBS_RUNTIME_DIR  the shipped OBS 32.1.2 runtime (bin/64bit/obs.dll, bin/64bit/w32-pthreads.dll)
#   NVCODEC_DIR      nv-codec-headers checkout (include/ffnvcodec/nvEncodeAPI.h)
#   PATCH_NOTE       text for the version resource "Comments" field (GPL: modified files carry a notice)

cmake_minimum_required(VERSION 3.25)
project(obs_nvenc_patched LANGUAGES C RC)

set(OBS_SOURCE_DIR "" CACHE PATH "patched obs-studio checkout (tag 32.1.2)")
set(OBS_RUNTIME_DIR "" CACHE PATH "official OBS 32.1.2 runtime")
set(NVCODEC_DIR "" CACHE PATH "nv-codec-headers checkout")
set(PATCH_NOTE "" CACHE STRING "modification notice for the version resource")

if(NOT MSVC)
  message(FATAL_ERROR "MSVC only")
endif()
foreach(var OBS_SOURCE_DIR OBS_RUNTIME_DIR NVCODEC_DIR)
  if(NOT ${var} OR NOT EXISTS "${${var}}")
    message(FATAL_ERROR "Set -D${var}=<path> (got '${${var}}')")
  endif()
endforeach()

set(CMAKE_C_STANDARD 17)
set(CMAKE_C_STANDARD_REQUIRED TRUE)
set(CMAKE_MSVC_RUNTIME_LIBRARY MultiThreadedDLL)
set(CMAKE_MSVC_DEBUG_INFORMATION_FORMAT ProgramDatabase)
set(CMAKE_INTERPROCEDURAL_OPTIMIZATION ON)

# --- import libraries from the shipped DLLs ---
find_program(DUMPBIN_EXE dumpbin REQUIRED)
find_program(LIB_EXE lib REQUIRED)
function(import_lib name dll)
  if(NOT EXISTS "${dll}")
    message(FATAL_ERROR "${dll} not found")
  endif()
  execute_process(COMMAND "${DUMPBIN_EXE}" /nologo /exports "${dll}" OUTPUT_VARIABLE _exports RESULT_VARIABLE _rc)
  if(NOT _rc EQUAL 0)
    message(FATAL_ERROR "dumpbin /exports failed on ${dll}")
  endif()
  string(REGEX MATCHALL "\n +[0-9]+ +[0-9A-F]+ [0-9A-F]+ [A-Za-z_][A-Za-z0-9_@?$]*" _lines "${_exports}")
  get_filename_component(_base "${dll}" NAME)
  set(_def "LIBRARY ${_base}\nEXPORTS\n")
  set(_count 0)
  foreach(_l IN LISTS _lines)
    string(REGEX REPLACE "^\n +[0-9]+ +[0-9A-F]+ [0-9A-F]+ " "" _name "${_l}")
    string(APPEND _def "  ${_name}\n")
    math(EXPR _count "${_count} + 1")
  endforeach()
  file(WRITE "${CMAKE_BINARY_DIR}/${name}.def" "${_def}")
  execute_process(COMMAND "${LIB_EXE}" /nologo /def:${CMAKE_BINARY_DIR}/${name}.def /machine:x64
                          /out:${CMAKE_BINARY_DIR}/${name}.lib RESULT_VARIABLE _rc)
  if(NOT _rc EQUAL 0)
    message(FATAL_ERROR "lib /def failed for ${dll}")
  endif()
  message(STATUS "${name}.lib generated from ${_count} exports of ${dll}")
endfunction()
import_lib(obs "${OBS_RUNTIME_DIR}/bin/64bit/obs.dll")
import_lib(w32-pthreads "${OBS_RUNTIME_DIR}/bin/64bit/w32-pthreads.dll")

# --- generated obsconfig.h (release build, as for the host) ---
set(OBS_RELEASE_CANDIDATE 0)
set(OBS_BETA 0)
configure_file("${OBS_SOURCE_DIR}/libobs/obsconfig.h.in" "${CMAKE_BINARY_DIR}/generated/obsconfig.h")

# --- version resource (upstream template, values from cmake/common/bootstrap.cmake + the modification note) ---
set(OBS_VERSION_MAJOR 32)
set(OBS_VERSION_MINOR 1)
set(OBS_VERSION_PATCH 2)
set(OBS_VERSION_CANONICAL "32.1.2")
set(OBS_COMPANY_NAME "OBS Project")
set(OBS_PRODUCT_NAME "OBS Studio")
set(OBS_COMMENTS "${PATCH_NOTE}")
set(OBS_LEGAL_COPYRIGHT "(C) Lain Bailey")
configure_file("${OBS_SOURCE_DIR}/plugins/obs-nvenc/cmake/windows/obs-module.rc.in" "${CMAKE_BINARY_DIR}/obs-nvenc.rc")

set(N "${OBS_SOURCE_DIR}/plugins/obs-nvenc")
add_library(obs-nvenc MODULE
  "${N}/nvenc-d3d11.c"
  "${N}/cuda-helpers.c"
  "${N}/nvenc-compat.c"
  "${N}/nvenc-cuda.c"
  "${N}/nvenc-helpers.c"
  "${N}/nvenc-opts-parser.c"
  "${N}/nvenc-properties.c"
  "${N}/nvenc.c"
  "${N}/obs-nvenc.c"
  "${OBS_SOURCE_DIR}/shared/opts-parser/opts-parser.c"
  "${CMAKE_BINARY_DIR}/obs-nvenc.rc")
set_target_properties(obs-nvenc PROPERTIES PREFIX "" OUTPUT_NAME obs-nvenc)
target_include_directories(obs-nvenc PRIVATE
  "${CMAKE_BINARY_DIR}/generated"
  "${OBS_SOURCE_DIR}/libobs"
  "${OBS_SOURCE_DIR}/deps/w32-pthreads"
  "${OBS_SOURCE_DIR}/shared/opts-parser"
  "${N}"
  "${NVCODEC_DIR}/include")
target_compile_definitions(obs-nvenc PRIVATE
  ENABLE_HEVC REGISTER_FFMPEG_IDS NOMINMAX UNICODE _UNICODE _CRT_SECURE_NO_WARNINGS _CRT_NONSTDC_NO_WARNINGS)
target_compile_options(obs-nvenc PRIVATE
  $<$<COMPILE_LANGUAGE:C>:/W3 /utf-8 /Brepro /permissive- /Zc:__cplusplus /Zc:preprocessor /Gy /Oi>)
target_link_options(obs-nvenc PRIVATE /OPT:REF /OPT:ICF /EMITTOOLVERSIONINFO:NO /DEBUG /Brepro /INCREMENTAL:NO
  /PDBALTPATH:obs-nvenc.pdb) # file name only in the debug directory, as in the shipped DLL (no build path)
target_link_libraries(obs-nvenc PRIVATE "${CMAKE_BINARY_DIR}/obs.lib" "${CMAKE_BINARY_DIR}/w32-pthreads.lib")
