# Third-party notices

ARA2 Bridge 4 Live is licensed under the GNU General Public License, version 3 (see `LICENSE`). It builds on, and is
linked against, the components below. They are **not stored in this repository**: `tools/setup_sdk.sh` downloads them
at the pinned versions. Their license texts are in `docs/licenses/`.

| Component | Version | License | Where it comes from |
|---|---|---|---|
| ARA SDK, ARA Library, ARA Examples (Celemony Software GmbH) | ARA_SDK `a2b1aac1d1d5c4eed387db85a9c0cdb7d460254c`, ARA_Examples `abd7c8aa5854591995e1fbf16f854c65b0998e8d` | Apache License 2.0 (`docs/licenses/ARA-SDK-Apache-2.0.txt`) | https://github.com/Celemony/ARA_SDK |
| `host/patches/ara-examples-bridgehost.patch` | modifies files of the ARA Examples | Apache License 2.0 (as the files it changes) | this repository |
| cpp-base64 (René Nyffenegger) | bundled in the ARA Examples | zlib (`docs/licenses/cpp-base64-zlib.txt`) | ARA Examples |
| ICST_AudioFile (Celemony Software GmbH) | bundled in the ARA Examples | BSD 2-Clause (`docs/licenses/ICST_AudioFile-BSD-2-Clause.txt`) | ARA Examples |
| pugixml (Arseny Kapoulkine) | bundled in the ARA Examples | MIT (`docs/licenses/pugixml-MIT.md`) | ARA Examples |
| Steinberg VST3 SDK | 3.7.11 | Dual license: Steinberg proprietary VST3 license **or GPLv3** (`docs/licenses/Steinberg-VST3-SDK-LICENSE.txt`). This project uses it under **GPLv3**. | https://github.com/steinbergmedia/vst3sdk (fetched by the ARA Examples' CMake) |

Because BridgeHost links the VST3 SDK under the GPLv3 option, BridgeHost and everything in this repository is distributed
under GPLv3. Binaries must be offered together with the corresponding source (this repository at the matching commit).

## Not included and not affected

Melodyne (Celemony Software GmbH) and VocAlign (Synchro Arts Ltd) are **not** part of this project. No code, data or
assets from them are included, and nothing here circumvents their licensing. You need your own licensed copies. The plug-ins
are loaded through the public ARA2 API.

## Trademarks

Ableton, Live, Max and Max for Live are trademarks of Ableton AG and Cycling '74. Melodyne and ARA are trademarks of
Celemony Software GmbH. VocAlign is a trademark of Synchro Arts Ltd. Other names belong to their owners. This project is
independent and is not affiliated with, endorsed or supported by any of these companies. The names are used only to
describe what the software works with.
