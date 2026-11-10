# Neki-Voice

inspired by Drover, built for macbook to alter UDP packets via a vencord userplugin. (MacOS requires NetworkExtensions Entitlements which are locked behind a paywall)

a Vencord userplugin that restores Discord voice on networks that block it, from inside Discord requiring no OS-level tools or special permissions.

Discord voice runs over UDP, blockers drop it with Deep Packet Inspection (connects, but no audio). Neki-Voice reroutes the voice connection to a local relay, which leads the real traffic with decoy packets so the DPI waves it through. It can't hear your voice, the relay only forwards encrypted UDP it has no keys for.

While the plugin itself isn't MacOS only and can be used on Windows/Linux on them OS-level tools work without a fight. I am listing better alternatives below.
just use [Drover](https://github.com/hdrover/discord-drover) or a plain UDP pipe.

The point of doing this *inside* Discord is macOS, where that OS-level approach hits the App Management/entitlement wall (99$ per year lol).

## does it fix Screen share?

Originally the relay only handled the first UDP stream, which meant screen share (a second stream or anything else) was blocked. Neki-Voice now runs a separate relay session for each stream, so screen share works alongside voice. Enjoy watching your friend's stream.

## Disclaimer

Using a modified Discord client violates Discord's Terms of Service. Use it at your own risk. You're responsible for any legal or account-related consequences.

## Update Note

Vencord apparently dropped support for `forms` on 25th October which made the plugin break Discord entirely upon update, it has been fixed as of 9/11/2026.

## Requirements

[Node.js](https://nodejs.org) (LTS)<br>
[Git](https://git-scm.com)<br>
[pnpm](https://pnpm.io) (install with `npm i -g pnpm`)

Vencord built from [source](https://docs.vencord.dev/installing/).

## Install (macOS)

userplugins build from source.

First turn ON *System Settings > Privacy & Security > App Management > Terminal
(else `pnpm inject` fails with `operation not permitted`). Needs [Node.js](https://nodejs.org) (LTS) + Git.

```bash
git clone https://github.com/Vendicated/Vencord
cd Vencord
mkdir -p src/userplugins
git clone https://github.com/UditTatu/neki-voice src/userplugins/neki-voice
pnpm install
pnpm build
pnpm inject #discord must be fully closed
```

If the git clone fails, download `index.tsx` and `native.ts`, put them in `Vencord/src/userplugins/neki-voice/`, then run `pnpm build` and `pnpm inject`.

Then: Discord > Settings > Vencord > Plugins > enable **Neki-Voice**.

**Update:** `git pull` in both repos, `pnpm build`, then fully quit and reopen Discord (inject is only needed on initial). `Cmd+R` alone isn't enough when `native.ts` changes, since it runs in Discord's main process.

## Install (Windows)

why? [Drover](https://github.com/hdrover/discord-drover) already exists and is the better pick on Windows but if you want it anyway...

same deal, userplugins build from source. Needs [Node.js](https://nodejs.org) (LTS) + [Git](https://git-scm.com), no App Management nonsense here.

Get pnpm once with `npm i -g pnpm`, then open **Git Bash** (comes with Git, right click a folder > *Open Git Bash here*):

```bash
git clone https://github.com/Vendicated/Vencord
cd Vencord
mkdir -p src/userplugins
git clone https://github.com/UditTatu/neki-voice src/userplugins/neki-voice
pnpm install
pnpm build
pnpm inject #discord must be fully closed
```

`pnpm inject` asks which Discord to patch, pick the one you actually use (Stable/PTB/Canary).

Then: Discord > Settings > Vencord > Plugins > enable **Neki-Voice**.

Your files live in `%USERPROFILE%\.nekivoice\` instead of `~/.nekivoice/`, so that's where `packet.bin` goes and where `relay.log` shows up.

**Update:** same as macOS.

## Install (Linux)

¯\_(ツ)_/¯

## Settings

Discord > Settings > Vencord > Plugins > Neki-Voice has four options

**Decoy mode** (default: QUIC packet + 1-byte packets). Picks what the relay sends before the voice handshake: both, the QUIC packet only, the 1-byte packets only, or nothing. Use it to find out which one your network needs.

**Decoy host** (default `www.google.com`). The website the generated QUIC packet pretends to connect to.

**Decoy delay** (default 50 ms). How long the relay waits after the decoys before sending the real handshake.

**Debug log** (off by default) writes relay logs to `~/.nekivoice/relay.log`, capped at 1MB. Leave it off unless something's broken, nothing gets written to disk otherwise.

If packets go out for 5 seconds and nothing comes back, Neki-Voice shows a red toast, which means the decoys aren't getting through.

## Debug

look in Console for `Neki` lines. Relay logs: `cat ~/.nekivoice/relay.log` (`up` climbing, `down` stuck at 0 = server not replying, check decoys via console).

The main decoy is a QUIC Initial packet (the first packet of an HTTP/3 connection) that Neki-Voice generates fresh for every voice connection. If `~/.nekivoice/packet.bin` exists, its contents are sent instead, so you can still drop in Drover's `drover-packet.bin` or your own capture.

plugin disappeared? Discord probably updated, close it and run `pnpm inject` again.

Inspired by [Drover](https://github.com/hdrover/discord-drover) and Built for Vencord.

Neki-Voice is an unofficial plugin. It is not affiliated with or endorsed by Vencord.

By UditTatu and RishitGupta
