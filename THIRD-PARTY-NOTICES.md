# Third-party notices

Screencup is released under the MIT License (see `LICENSE`). It includes the components below,
which keep their own licences.

## FFmpeg (bundled program)

The installer ships `ffmpeg`, a separate program that Screencup starts to record and encode
screen video. It is not linked into Screencup.

- Licence: the bundled build is configured with `--enable-gpl` and is covered by the
  GNU General Public License v3. The full text is in `licenses/ffmpeg/LICENSE.txt`.
- Build and version: `licenses/ffmpeg/BUILD.txt` and `licenses/ffmpeg/README.txt`. The README
  gives the exact source commit.
- Source code: https://github.com/FFmpeg/FFmpeg. Windows builds come from https://www.gyan.dev/ffmpeg/builds/.
- You may replace `ffmpeg` in the installation folder with any other build, including an
  LGPL one. Screencup then uses that build's H.264 encoder.

## Libraries compiled into Screencup

Screencup is built with open-source libraries. All of them are under permissive licences:
MIT, Apache-2.0, BSD, ISC, Zlib or Unicode-3.0. The main ones are:

- Tauri: MIT or Apache-2.0
- xcap, winit, softbuffer, cpal, hound, arboard, trash: MIT or Apache-2.0
- React: MIT
- Konva and react-konva: MIT
- Lucide icons: ISC

The full list, with every library's version, licence and licence text, is in
`licenses/THIRD-PARTY-LICENSES.txt` in the installation folder. The build generates it with
`scripts/collect-licenses.mjs`.

Some of the Rust crates (cssparser, selectors, dtoa-short, option-ext) are under the Mozilla
Public License 2.0. Screencup uses them unmodified, and their source is available on crates.io.
