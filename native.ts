import type { IpcMainInvokeEvent } from "electron";
import dgram from "dgram";
import fs from "fs";
import os from "os";
import path from "path";

const PACKET_FILE = path.join(os.homedir(), ".nekivoice", "packet.bin");
const LOG_FILE = path.join(os.homedir(), ".nekivoice", "relay.log");
const PRELUDE_DELAY_MS = 50;
const DISCOVERY_LEN = 74;
const MAX_BUFFER = 64;
const STATS_MS = 3000;
const IDLE_MS = 30000;

function log(line: string) {
    if (!loggingEnabled) return;
    try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        try { if (fs.statSync(LOG_FILE).size > 1_000_000) fs.unlinkSync(LOG_FILE); } catch { }
        fs.appendFileSync(LOG_FILE, `${new Date().toISOString()}  ${line}\n`);
    } catch { }
}

interface Session {
    ssrc: number;
    target: { ip: string; port: number };
    egress: dgram.Socket;
    discordSrc: { address: string; port: number } | null;
    queue: Buffer[];
    preludeStarted: boolean;
    forwarding: boolean;
    up: number;
    down: number;
    gotReply: boolean;
    lastSeen: number;
    loggedUp: number;
    loggedDown: number;
}

interface Held {
    ssrc: number;
    address: string;
    port: number;
    packets: Buffer[];
    since: number;
}

let loopback: dgram.Socket | null = null;
let loopbackPort = 0;
let decoysEnabled = true;
let loggingEnabled = false;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let idleTimer: ReturnType<typeof setInterval> | null = null;

const pendingBySsrc = new Map<number, Session>();
const sessionsBySsrc = new Map<number, Session>();
const sessionsBySrc = new Map<string, Session>();
const unmatched = new Map<string, Held>();

function srcKey(address: string, port: number) { return `${address}|${port}`; }

export async function setDecoys(_: IpcMainInvokeEvent, enabled: boolean): Promise<void> {
    decoysEnabled = enabled;
}

export async function setLogging(_: IpcMainInvokeEvent, enabled: boolean): Promise<void> {
    loggingEnabled = enabled;
}

function sendPrelude(sock: dgram.Socket, ip: string, port: number) {
    try {
        const data = fs.readFileSync(PACKET_FILE);
        if (data.length > 0) sock.send(data, port, ip);
    } catch { 
        log(`no packet.bin at ${PACKET_FILE}, sending minimal decoys only`);
    }
    sock.send(Buffer.from([0x00]), port, ip);
    sock.send(Buffer.from([0x01]), port, ip);
}

function maybeStartPrelude(s: Session) {
    if (s.preludeStarted) return;
    const hasDiscovery = s.queue.some(b => b.length === DISCOVERY_LEN);
    if (!hasDiscovery && s.queue.length <= 16) return;

    s.preludeStarted = true;
    sendPrelude(s.egress, s.target.ip, s.target.port);
    log(`prelude → ${s.target.ip}:${s.target.port} (ssrc ${s.ssrc})`);

    setTimeout(() => {
        if (sessionsBySsrc.get(s.ssrc) !== s) return;
        const disc = s.queue.filter(b => b.length === DISCOVERY_LEN);
        const rest = s.queue.filter(b => b.length !== DISCOVERY_LEN);
        for (const b of disc) { s.egress.send(b, s.target.port, s.target.ip); s.up++; }
        for (const b of rest) { s.egress.send(b, s.target.port, s.target.ip); s.up++; }
        s.queue = [];
        s.forwarding = true;
    }, PRELUDE_DELAY_MS);
}

function feed(s: Session, data: Buffer) {
    s.lastSeen = Date.now();

    if (!decoysEnabled) {
        s.forwarding = true;
        s.egress.send(data, s.target.port, s.target.ip);
        s.up++;
        return;
    }
    if (s.forwarding) {
        s.egress.send(data, s.target.port, s.target.ip);
        s.up++;
        return;
    }
    if (s.queue.length < MAX_BUFFER) s.queue.push(data);
    maybeStartPrelude(s);
}

function bindSession(s: Session, address: string, port: number) {
    s.discordSrc = { address, port };
    sessionsBySrc.set(srcKey(address, port), s);
    sessionsBySsrc.set(s.ssrc, s);
    pendingBySsrc.delete(s.ssrc);
    log(`bound ssrc ${s.ssrc} ↔ ${address}:${port} → ${s.target.ip}:${s.target.port}`);
}

function closeSession(s: Session) {
    try { s.egress.close(); } catch { }
    if (sessionsBySsrc.get(s.ssrc) === s) sessionsBySsrc.delete(s.ssrc);
    if (s.discordSrc) {
        const key = srcKey(s.discordSrc.address, s.discordSrc.port);
        if (sessionsBySrc.get(key) === s) sessionsBySrc.delete(key);
    }
    if (pendingBySsrc.get(s.ssrc) === s) pendingBySsrc.delete(s.ssrc);
    log(`session closed ssrc ${s.ssrc}`);
}

function handleClientPacket(data: Buffer, rinfo: dgram.RemoteInfo) {
    const key = srcKey(rinfo.address, rinfo.port);

    const known = sessionsBySrc.get(key);
    if (known) { feed(known, data); return; }

    if (data.length === DISCOVERY_LEN) {
        const ssrc = data.readUInt32BE(4);
        const pending = pendingBySsrc.get(ssrc);
        if (pending) {
            bindSession(pending, rinfo.address, rinfo.port);
            feed(pending, data);
            return;
        }
        let held = unmatched.get(key);
        if (!held) { held = { ssrc, address: rinfo.address, port: rinfo.port, packets: [], since: Date.now() }; unmatched.set(key, held); }
        if (held.packets.length < MAX_BUFFER) held.packets.push(data);
        return;
    }

    const held = unmatched.get(key);
    if (held && held.packets.length < MAX_BUFFER) held.packets.push(data);
}

export async function startRelay(_: IpcMainInvokeEvent): Promise<number> {
    if (loopback) return loopbackPort;

    const sock = dgram.createSocket("udp4");
    sock.on("message", handleClientPacket);

    await new Promise<void>((resolve, reject) => {
        const onErr = (e: Error) => reject(e);
        sock.once("error", onErr);
        sock.bind(0, "127.0.0.1", () => {
            sock.off("error", onErr);
            sock.on("error", () => { });
            resolve();
        });
    });

    loopback = sock;
    loopbackPort = sock.address().port;
    log(`relay up on 127.0.0.1:${loopbackPort}`);

    statsTimer = setInterval(() => {
        for (const s of sessionsBySsrc.values()) {
            if (s.up === s.loggedUp && s.down === s.loggedDown) continue;
            s.loggedUp = s.up;
            s.loggedDown = s.down;
            log(`relaying ssrc ${s.ssrc}: up=${s.up} down=${s.down}`);
        }
    }, STATS_MS);

    idleTimer = setInterval(() => {
        const now = Date.now();
        for (const s of [...sessionsBySsrc.values()]) {
            if (now - s.lastSeen > IDLE_MS) closeSession(s);
        }
        for (const s of [...pendingBySsrc.values()]) {
            if (now - s.lastSeen > IDLE_MS) closeSession(s);
        }
        for (const [key, h] of [...unmatched]) {
            if (now - h.since > IDLE_MS) unmatched.delete(key);
        }
    }, IDLE_MS);

    return loopbackPort;
}

export async function setTarget(_: IpcMainInvokeEvent, ssrc: number, ip: string, port: number): Promise<void> {
    const prev = sessionsBySsrc.get(ssrc) || pendingBySsrc.get(ssrc);
    if (prev) closeSession(prev);

    const family: dgram.SocketType = ip.includes(":") ? "udp6" : "udp4";
    const egress = dgram.createSocket(family);
    egress.on("error", () => { });

    const s: Session = {
        ssrc, target: { ip, port }, egress,
        discordSrc: null, queue: [],
        preludeStarted: false, forwarding: false,
        up: 0, down: 0, gotReply: false, lastSeen: Date.now(),
        loggedUp: 0, loggedDown: 0
    };

    egress.on("message", (data, rinfo) => {
        if (rinfo.address !== s.target.ip) return;
        if (!s.discordSrc || !loopback) return;
        loopback.send(data, s.discordSrc.port, s.discordSrc.address);
        s.down++;
        s.lastSeen = Date.now();
        if (!s.gotReply) {
            s.gotReply = true;
            log(`first reply ssrc ${s.ssrc} from ${rinfo.address}:${rinfo.port}`);
        }
    });
    try { egress.bind(); } catch { }

    pendingBySsrc.set(ssrc, s);
    log(`target ssrc ${ssrc} → ${ip}:${port}  decoys=${decoysEnabled ? "ON" : "OFF"}`);

    for (const [key, held] of unmatched) {
        if (held.ssrc === ssrc) {
            bindSession(s, held.address, held.port);
            for (const p of held.packets) feed(s, p);
            unmatched.delete(key);
            break;
        }
    }
}

export async function stopRelay(_: IpcMainInvokeEvent): Promise<void> {
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    for (const s of [...sessionsBySsrc.values()]) closeSession(s);
    for (const s of [...pendingBySsrc.values()]) { try { s.egress.close(); } catch { } }
    pendingBySsrc.clear();
    sessionsBySsrc.clear();
    sessionsBySrc.clear();
    unmatched.clear();
    if (loopback) { try { loopback.close(); } catch { } loopback = null; }
    loopbackPort = 0;
    log("relay stopped");
}