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

## Requirements

[Node.js](https://nodejs.org) (LTS) + Git.

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

**Update:** `git pull` in both repos, `pnpm build`, then `Cmd+R` in Discord (inject is only needed on initial).

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

**Update:** same as macOS, `Ctrl+R` instead of `Cmd+R`.

## Install (Linux)

I am not sure, I don't have a Linux machine available to test.

## Settings

Discord > Settings > Vencord > Plugins > Neki-Voice has two options
**decoys** (on by default). Turn it off to send traffic through the relay without decoy packets, which is useful for A/B testing.
if `up` climbs but `down` stays at 0, the decoys may not be getting through.

 **Debug log** (off by default) writes relay logs to `~/.nekivoice/relay.log`, capped at 1MB. leave it off unless something's broken, nothing gets written to disk otherwise.

## Debug

look in Console for `Neki` lines. Relay logs: `cat ~/.nekivoice/relay.log` (`up` climbing, `down` stuck at 0 = server not replying, check decoys via console).

the Decoys depend on a file called "packet.bin" located at `~/.nekivoice/packet.bin`

plugin disappeared? Discord probably updated, close it and run `pnpm inject` again.

Inspired by [Drover](https://github.com/hdrover/discord-drover) and Built for Vencord.

Neki-Voice is an unofficial plugin. It is not affiliated with or endorsed by Vencord.

By UditTatu and RishitGupta
