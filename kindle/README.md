# Kindle Native Dashboard Setup

The preferred Kindle surface is now a native C++ app launched by KUAL or upstart. It fetches read-only JSON from:

```text
https://your-project.insforge.app/functions/kindle-dashboard-data
```

The deployed dashboard endpoints require `DASHBOARD_READ_TOKEN`; the native
launcher sends it as `X-Dashboard-Read-Token` from local `config.sh`.

## Preview Without A Kindle

Render the bundled sample payload to an image:

```sh
make -C kindle/native local
kindle/native/build/kindle-dashboard-local --render kindle/native/fixtures/dashboard-data.json --save-pgm /tmp/dashboard.pgm
magick /tmp/dashboard.pgm /tmp/dashboard.png
```

Add `--dark`, `--view chores` (or `grocery`), or `--title "Any text"` to try the other looks.

## Build

Run a local parser/render check on your computer:

```sh
npm run native:check
```

Build a Kindle binary after installing an ARM Kindle-compatible toolchain:

```sh
make -C kindle/native kindle
```

The Makefile expects `arm-linux-gnueabi-g++`. If your compiler has another name, pass it explicitly:

```sh
make -C kindle/native kindle KINDLE_CXX=/path/to/arm-linux-gnueabi-g++
```

If you don't have that GNU cross compiler, a Zig soft-float ARM build is the easier path (`ZIG=` is only needed when `zig` is not on your `PATH`):

```sh
make -C kindle/native extension-zig ZIG=/path/to/zig
```

Use `extension-zig` for a broadly compatible ARM EABI build. Override `ZIG_TARGET=arm-linux-gnueabihf ZIG_MCPU=generic+v7a` only if your device specifically needs a hard-float build.

## KUAL Install

Build the KUAL extension package:

```sh
make -C kindle/native extension
```

Or, with the Zig soft-float path:

```sh
make -C kindle/native extension-zig ZIG=/path/to/zig
```

Copy `kindle/native/build/kindle-dashboard-kual.tar.gz` to the Kindle and extract it into the KUAL extensions directory:

```sh
tar -C /mnt/us/extensions -xzf kindle-dashboard-kual.tar.gz
```

If the Kindle is mounted over USB, install directly with (the mount path defaults to `/Volumes/Kindle`, so pass it explicitly on Linux):

```sh
DASHBOARD_DATA_URL=https://your-project.insforge.app/functions/kindle-dashboard-data DASHBOARD_READ_TOKEN=<read-token> npm run native:install -- /path/to/Kindle
```

See [docs/INSTALL_FOR_USERS.md](../docs/INSTALL_FOR_USERS.md) for the full list of variables it writes into `config.sh`.

KUAL menu actions:

- `Start Dashboard (Light)`: starts the always-on e-ink dashboard.
- `Start Dashboard (Dark)`: the same, rendered white-on-black.
- `Refresh Once (Light)`: temporarily wakes the display, enables Wi-Fi, fetches, and renders one update.
- `Refresh Once (Dark)`: the same, rendered white-on-black.
- `Stop Dashboard`: kills the native process and restores normal sleep behavior.

### Dark mode

The Dark entries pass `--dark`, which inverts the finished canvas: black
background, white text and frames. It is the renderer's own theme, unrelated to
the Kindle's OS-level dark mode, and it does not depend on the device setting.

To make it the default for every launch, set `DARK_MODE="1"` in `config.sh`.
The Light/Dark menu entries override that setting for the launch they start.
`INVERT_IMAGES` is the previous name for the same switch and still works, so a
`config.sh` written before this release keeps whatever it was set to.

The photo tile is pre-inverted before the canvas flip, so it stays a photo
instead of coming out as a negative. Two things are worth knowing before
leaving dark mode on permanently:

- The Kindle's own status bar (the top 66 px) is drawn by the OS and is
  deliberately not written to, so it stays light. Dark mode leaves a light
  strip there.
- A mostly-black screen ghosts more on e-ink than a mostly-white one. Full
  refreshes stay readable, but faint remnants of the previous frame are more
  visible between them.

The native app caches the latest successful payload at:

```text
/mnt/us/documents/kindle-dashboard-data.json
```

If Wi-Fi is unavailable, it renders cached data with a `cached/offline` status line.

Always-on defaults can be overridden before launching:

```sh
INTERVAL=300
DASHBOARD_SLEEP_WINDOW=off
DASHBOARD_KEEP_AWAKE=1
DARK_MODE=0
DASHBOARD_TITLE="Kindle Dashboard"
```

Set `DASHBOARD_SLEEP_WINDOW=HH:MM-HH:MM` to add overnight quiet mode, or `DASHBOARD_KEEP_AWAKE=0` to allow normal Kindle sleep while the dashboard is running.

## Manual Launcher

Copy the repo launcher onto the Kindle:

```sh
cp kindle/launch-dashboard.sh /mnt/us/documents/kindle-dashboard-launch.sh
chmod +x /mnt/us/documents/kindle-dashboard-launch.sh
```

Run it manually over SSH to test:

```sh
/mnt/us/documents/kindle-dashboard-launch.sh
```

If the native binary is missing, the launcher exits and writes the failure to the native dashboard log.

## Optional: Start On Boot

If SSH/root access is enabled and your Kindle uses upstart jobs, copy:

```text
kindle/upstart/kindle-dashboard.conf
```

to:

```text
/etc/init/kindle-dashboard.conf
```

Then adapt the command to run:

```sh
/mnt/us/documents/kindle-dashboard-launch.sh
```

On the next boot, the job should wait for the Kindle UI, enable Wi-Fi, wait briefly for networking, then launch the native dashboard.

If the Kindle hangs or behaves oddly, remove the upstart file:

```sh
stop kindle-dashboard
mntroot rw
rm /etc/init/kindle-dashboard.conf
mntroot ro
```

## Notes

- KUAL support varies by Kindle model and firmware.
- The native app needs Wi-Fi for fresh data but can render its cached payload offline.
- The default native profile keeps the Kindle awake, refreshes every 300 seconds (plus live SSE pushes), and does not use an overnight quiet window.
- Keeping Wi-Fi and a refresh process running will still use more battery than a static screensaver-style dashboard.
- If boot autostart is too aggressive, launch the native dashboard manually from KUAL.
