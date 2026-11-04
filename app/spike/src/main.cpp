// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-spike: P1 headless libobs host. All paths come from the command line.
//
//   ujwalam-spike <command> --runtime <OBS runtime dir> --out <output dir> [options]
//
// Commands: probe | chat-charge | two-canvas | shared-encoder | gpu-scale | plugin
// Common options:
//   --plugin-root DIR   extra module root laid out as DIR/<module>/bin/64bit + DIR/<module>/data (repeatable)
//   --disable NAME      do not load this module (repeatable)
//   --enable NAME       remove NAME from the default disabled list (obs-websocket, frontend UI plugins)
//   --allow-devices     load win-dshow/win-wasapi (off by default: stage A never opens devices)
//   --encoder ID        video encoder id (default obs_nvenc_h264_tex); --bitrate KBPS; --keyint SEC
//   --config DIR        module config dir (default <out>/module-config)
//   --adapter N         DXGI adapter index (default 0)
// two-canvas device options (need --allow-devices):
//   --h-device ID [--h-device-audio ID] [--h-res WxH --h-fps N] --mic WASAPI_ID
//   --v-device ID [--v-res WxH --v-fps N] [--v-filter ID --v-filter-settings JSON]
//   --only h|v          record one canvas only
#include "host.h"
#include "scenes.h"

#include <windows.h>

#include <cstdio>
#include <string>

// Ask hybrid-GPU drivers for the discrete GPU (NVIDIA Optimus / AMD PowerXpress).
extern "C" {
__declspec(dllexport) DWORD NvOptimusEnablement = 1;
__declspec(dllexport) int AmdPowerXpressRequestHighPerformance = 1;
}

static Args parse(int argc, char **argv)
{
	Args a;
	if (argc > 1)
		a.cmd = argv[1];
	for (int i = 2; i < argc; i++) {
		std::string k = argv[i];
		if (k.rfind("--", 0) != 0)
			continue;
		k = k.substr(2);
		if (i + 1 < argc && std::string(argv[i + 1]).rfind("--", 0) != 0)
			a.kv[k].push_back(argv[++i]);
		else
			a.kv[k].push_back("1");
	}
	return a;
}

int main(int argc, char **argv)
{
	Args a = parse(argc, argv);
	if (a.cmd.empty() || !a.has("runtime") || !a.has("out")) {
		fprintf(stderr, "usage: ujwalam-spike <probe|chat-charge|two-canvas|shared-encoder|gpu-scale|plugin> "
				"--runtime DIR --out DIR [options]\n");
		return 1;
	}
	Size base = {1920, 1080};
	if (a.cmd == "gpu-scale")
		base = parse_size(a.get("base"), {3840, 2160});
	if (!host::start(a, base, base, 60)) {
		host::shutdown();
		return 2;
	}
	int rc = 1;
	if (a.cmd == "probe")
		rc = cmd_probe(a);
	else if (a.cmd == "chat-charge")
		rc = cmd_chat_charge(a);
	else if (a.cmd == "two-canvas")
		rc = cmd_two_canvas(a);
	else if (a.cmd == "shared-encoder")
		rc = cmd_shared_encoder(a);
	else if (a.cmd == "gpu-scale")
		rc = cmd_gpu_scale(a);
	else if (a.cmd == "plugin")
		rc = cmd_plugin(a);
	else
		host::logf("unknown command %s", a.cmd.c_str());
	host::logf("exit code %d", rc);
	host::shutdown();
	return rc;
}
