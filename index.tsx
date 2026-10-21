import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import type { PluginNative } from "@utils/types";
import { Forms } from "@webpack/common";

const Native = VencordNative.pluginHelpers["Neki-Voice"] as PluginNative<typeof import("./native")>;

const settings = definePluginSettings({
    decoys: {
        type: OptionType.BOOLEAN,
        description: "Send the Drover decoy packets before the voice handshake (off = relay only, for A/B testing)",
        default: true,
        onChange: (value: boolean) => { Native.setDecoys(value).catch(() => { }); }
    }
});

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

    Native.setDecoys(settings.store.decoys).catch(() => { });
    Native.setTarget(ssrc, ip, port).catch(() => { });
    console.log(`Neki : rerouting voice ssrc ${ssrc} ${ip}:${port} → 127.0.0.1:${relayPort} (decoys ${settings.store.decoys ? "on" : "off"})`);

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
    } catch {
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
    description: "Reroutes Discord voice through a local relay that leads with decoy packets to beat UDP voice blocking. Made by Nekimo.",
    authors: [{ name: "Nekimo", id: 693803001571442709n }],
    settings,

    settingsAboutComponent: () => (
        <>
            <Forms.FormText>Neki-Voice, A hello beyond bullshit restrictions.</Forms.FormText>
            <Forms.FormText style={{ marginTop: 8, fontStyle: "italic" }}>
                Made by Nekimo.
            </Forms.FormText>
        </>
    ),

    async start() {
        console.log("Neki : Main system activating Dumbass Mode");
        try {
            relayPort = await Native.startRelay();
            console.log(`Neki : relay up on 127.0.0.1:${relayPort}`);
        } catch (e) {
            console.error("Neki : relay failed to start", e);
        }

        const Original = window.WebSocket;
        OriginalWebSocket = Original;

        const Wrapped = function (this: any, url: string | URL, protocols?: string | string[]) {
            return wrap(new Original(url, protocols));
        } as unknown as typeof WebSocket;

        Wrapped.prototype = Original.prototype;
        (Wrapped as any).CONNECTING = Original.CONNECTING;
        (Wrapped as any).OPEN = Original.OPEN;
        (Wrapped as any).CLOSING = Original.CLOSING;
        (Wrapped as any).CLOSED = Original.CLOSED;

        window.WebSocket = Wrapped;
    },

    stop() {
        if (OriginalWebSocket) {
            window.WebSocket = OriginalWebSocket;
            OriginalWebSocket = null;
        }
        Native.stopRelay().catch(() => { });
        lastData = null;
        lastRewrite = null;
        console.log("Neki : system down");
    }
});
