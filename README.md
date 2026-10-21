# Neki-Voice
inspired by Drover, built for macbook to alter UDP packets via a vencord Userplugin. (MacOS requires NetworkExtensions Entitlements which are locked behind a paywall)

a Vencord Userplugin that restores Discord voice on networks that block it, from inside Discord requiring no OS-level tools or special permissions.

Discord voice runs over UDP, blockers drop it with Deep Packet Inspection (connects, but no audio). Neki-Voice reroutes the voice connection to a local relay, which leads the real traffic with decoy packets so the DPI waves it through. It can't hear your voice, the relay only forwards encrypted UDP it has no keys for.

While the plugin itself isn't MacOS only and can be used on Windows/Linux on them OS-level tools work without a fight. I am listing better alternatives below.
just use [Drover](https://github.com/front9bit/Drover) or a plain UDP pipe.

The point of doing this *inside* Discord is macOS, where that OS-level approach hits the App Management/entitlement wall (99$ per year lol).
## Note

This didn't used to fix screen share but after a simple <n> scale it does, enjoy watching your friends stream.

## Disclaimer

For educational purposes only. The author does not condone illegal use. account-action risk is real. Use at your own risk, you are responsible for using this.

## Requirements

[Node.js](https://nodejs.org) (LTS) + Git.

## Install (macOS)

Userplugins build from source.

First turn ON *System Settings > Privacy & Security > App Management > Terminal* 
-# (else `pnpm inject` fails with `operation not permitted`). Needs [Node.js](https://nodejs.org) (LTS) + Git.

```bash
git clone https://github.com/Vendicated/Vencord
cd Vencord
mkdir -p src/userplugins
git clone https://github.com/<you>/neki-voice src/userplugins/neki-voice
pnpm install
pnpm build
pnpm inject #discord must be fully closed
```

Then: Discord > Settings > Vencord > Plugins > enable **Neki-Voice**.

**Update:** `git pull` in both repos, `pnpm build`, then `Cmd+R` in Discord (inject is only needed on initial).

## Settings

no settings for now, it works and that is all I could figure out.

## Debug

look in Console for `Neki` lines. Relay logs: `cat ~/.nekivoice/relay.log` (`up` climbing, `down` stuck at 0 = server not replying, tune decoys).

Inspired by [Drover](https://github.com/front9bit/Drover) and Built on for Vencord.
