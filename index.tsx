import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import type { PluginNative } from "@utils/types";
import { Paragraph } from "@components/Paragraph";
import { showToast } from "@webpack/common";

const Native = VencordNative.pluginHelpers["Neki-Voice"] as PluginNative<typeof import("./native")>;

function reportError(what: string, err: unknown, toast = false) {
    console.error(`Neki : ${what}`, err);
    if (toast) showToast({ text: `Neki-Voice: ${what}`, variant: "critical", duration: 8000 });
}

const settings = definePluginSettings({
    decoyMode: {
        type: OptionType.SELECT,
        description: "What to send before the voice handshake. Changes apply to the next voice connection.",
        options: [
            { label: "QUIC packet + 1-byte packets (default)", value: "both", default: true },
            { label: "QUIC packet only", value: "packet" },
            { label: "1-byte packets only (Drover's built-in trick)", value: "bytes" },
            { label: "Off (relay only, for A/B testing)", value: "off" }
        ] as const,
        onChange: () => { applyDecoyOptions(); }
    },
    decoyHost: {
        type: OptionType.STRING,
        description: "Website the generated QUIC decoy pretends to connect to (ignored if ~/.nekivoice/packet.bin exists)",
        default: "www.google.com",
        onChange: () => { applyDecoyOptions(); }
    },
    decoyDelay: {
        type: OptionType.SLIDER,
        description: "Milliseconds to wait between the decoys and the real handshake",
        markers: [0, 10, 25, 50, 100, 200],
        default: 50,
        stickToMarkers: true,
        onChange: () => { applyDecoyOptions(); }
    },
    debugLog: {
        type: OptionType.BOOLEAN,
        description: "Write relay logs to ~/.nekivoice/relay.log (off = nothing written to disk)",
        default: false,
        onChange: (value: boolean) => { Native.setLogging(value).catch(e => reportError("couldn't change the log setting", e)); }
    }
});

function applyDecoyOptions() {
    const { decoyMode, decoyHost, decoyDelay } = settings.store;
    return Native.setDecoyOptions(decoyMode ?? "both", decoyHost, decoyDelay)
        .catch(e => reportError("couldn't apply the decoy settings", e));
}

const STUCK_CHECK_MS = 5000;
let lastStuckToast = 0;

function checkStuck(ssrc: number) {
    setTimeout(async () => {
        const stats = await Native.getStats(ssrc).catch(e => { reportError("couldn't read relay stats", e); return null; });
        if (!stats || stats.up === 0 || stats.down > 0) return;

        console.warn(`Neki : ssrc ${ssrc} sent ${stats.up} packets and got nothing back (decoys: ${settings.store.decoyMode})`);
        if (Date.now() - lastStuckToast < 30_000) return;
        lastStuckToast = Date.now();
        showToast({
            text: "Neki-Voice: voice packets are going out but nothing is coming back. The decoys aren't getting through, try another decoy mode.",
            variant: "critical",
            duration: 8000
        });
    }, STUCK_CHECK_MS);
}

let OriginalWebSocket: typeof WebSocket | null = null;
let relayPort = 0;

let lastData: string | null = null;
let lastRewrite: string | null = null;

function rewriteIfVoiceReady(dataStr: string): string | null {
    if (dataStr === lastData) return lastRewrite;

    let msg: any;
    try { msg = JSON.parse(dataStr); } catch { return null; }
    if (!msg || msg.op !== 2 || !msg.d) return null;

    const ip = msg.d.ip;
    const port = msg.d.port;
    const ssrc = msg.d.ssrc;
    if (typeof ip !== "string" || typeof port !== "number" || typeof ssrc !== "number") return null;
    if (ip === "127.0.0.1") return null;

    applyDecoyOptions();
    Native.setTarget(ssrc, ip, port)
        .then(() => checkStuck(ssrc))
        .catch(e => reportError("relay setup failed, so this call won't connect. Rejoin, or turn the plugin off.", e, true));
    console.log(`Neki : rerouting voice ssrc ${ssrc} ${ip}:${port} → 127.0.0.1:${relayPort} (decoys: ${settings.store.decoyMode})`);

    msg.d.ip = "127.0.0.1";
    msg.d.port = relayPort;
    const modified = JSON.stringify(msg);

    lastData = dataStr;
    lastRewrite = modified;
    return modified;
}

function maybeRewrite(ev: MessageEvent): MessageEvent {
    if (!relayPort || typeof ev.data !== "string") return ev;
    const modified = rewriteIfVoiceReady(ev.data);
    if (modified == null || modified === ev.data) return ev;
    try {
        return new MessageEvent("message", {
            data: modified,
            origin: (ev as any).origin,
            lastEventId: (ev as any).lastEventId,
            source: (ev as any).source as any,
            ports: (ev as any).ports ? [...(ev as any).ports] : []
        });
    } catch (e) {
        reportError("couldn't rewrite voice handshake, direct connection instead.", e, true);
        return ev;
    }
}

function wrap(ws: WebSocket): WebSocket {
    const realAdd = ws.addEventListener.bind(ws);
    const realRemove = ws.removeEventListener.bind(ws);
    const wrappedFor = new WeakMap<object, EventListener>();

    (ws as any).addEventListener = function (type: string, listener: any, opts?: any) {
        if (type === "message" && typeof listener === "function") {
            let w = wrappedFor.get(listener);
            if (!w) {
                w = function (this: any, ev: Event) { listener.call(this, maybeRewrite(ev as MessageEvent)); };
                wrappedFor.set(listener, w);
            }
            realAdd("message", w, opts);
        } else {
            realAdd(type as any, listener, opts);
        }
    };

    (ws as any).removeEventListener = function (type: string, listener: any, opts?: any) {
        if (type === "message" && typeof listener === "function" && wrappedFor.has(listener)) {
            realRemove("message", wrappedFor.get(listener)!, opts);
        } else {
            realRemove(type as any, listener, opts);
        }
    };

    try {
        let currentFn: ((ev: MessageEvent) => any) | null = null;
        let currentWrapped: EventListener | null = null;
        Object.defineProperty(ws, "onmessage", {
            configurable: true,
            get() { return currentFn; },
            set(fn) {
                if (currentWrapped) { realRemove("message", currentWrapped); currentWrapped = null; }
                currentFn = fn;
                if (typeof fn === "function") {
                    currentWrapped = function (this: any, ev: Event) { fn.call(this, maybeRewrite(ev as MessageEvent)); };
                    realAdd("message", currentWrapped);
                }
            }
        });
    } catch { }

    return ws;
}

export default definePlugin({
    name: "Neki-Voice",
    description: "Reroutes Discord voice through a local relay that leads UDP with decoy packets.",
    authors: [{ name: "Nekimo", id: 693803001571442709n }],
    settings,

    settingsAboutComponent: () => (
        <>
            <Paragraph>Neki-Voice, A hello beyond bullshit restrictions.</Paragraph>
            <Paragraph style={{ marginTop: 8, fontStyle: "italic" }}>
                Made by Nekimo.
            </Paragraph>
        </>
    ),

    async start() {
        console.log("Neki : Main system activating Dumbass Mode");
        try {
            await Native.setLogging(settings.store.debugLog);
            await applyDecoyOptions();
            relayPort = await Native.startRelay();
            console.log(`Neki : relay up on 127.0.0.1:${relayPort}`);
        } catch (e) {
            relayPort = 0;
            reportError("the relay failed to start, so voice will connect directly", e, true);
            return;
        }

        const Original = window.WebSocket;
        OriginalWebSocket = Original;

        const Wrapped = class extends Original {
            constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols);
                wrap(this);
            }
        };

        window.WebSocket = Wrapped;
    },

    stop() {
        if (OriginalWebSocket) {
            window.WebSocket = OriginalWebSocket;
            OriginalWebSocket = null;
        }
        Native.stopRelay().catch(e => reportError("couldn't stop relay cleanly", e));
        relayPort = 0;
        lastData = null;
        lastRewrite = null;
        console.log("Neki : system down");
    }
});
