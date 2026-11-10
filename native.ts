import type { IpcMainInvokeEvent } from "electron";
import crypto from "crypto";
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

function reportError(context: string, err: unknown) {
    console.error(`[Neki-Voice] ${context}:`, err);
    log(`ERROR ${context}: ${err instanceof Error ? err.message : String(err)}`);
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
type DecoyMode = "both" | "packet" | "bytes" | "off";
let decoyMode: DecoyMode = "both";
let decoyHost = "www.google.com";
let preludeDelayMs = PRELUDE_DELAY_MS;
let loggingEnabled = false;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let idleTimer: ReturnType<typeof setInterval> | null = null;

const pendingBySsrc = new Map<number, Session>();
const sessionsBySsrc = new Map<number, Session>();
const sessionsBySrc = new Map<string, Session>();
const unmatched = new Map<string, Held>();

function srcKey(address: string, port: number) { return `${address}|${port}`; }

export async function setDecoyOptions(_: IpcMainInvokeEvent, mode: DecoyMode, host: string, delayMs: number): Promise<void> {
    decoyMode = ["both", "packet", "bytes", "off"].includes(mode) ? mode : "both";
    decoyHost = host?.trim() || "www.google.com";
    preludeDelayMs = Number.isFinite(delayMs) ? Math.min(Math.max(delayMs, 0), 1000) : PRELUDE_DELAY_MS;
}

export async function getStats(_: IpcMainInvokeEvent, ssrc: number): Promise<{ up: number; down: number; } | null> {
    const s = sessionsBySsrc.get(ssrc) || pendingBySsrc.get(ssrc);
    return s ? { up: s.up, down: s.down } : null;
}

export async function setLogging(_: IpcMainInvokeEvent, enabled: boolean): Promise<void> {
    loggingEnabled = enabled;
}

const QUIC_V1_SALT = Buffer.from("38762cf7f55934b34d179ae6a4c80cadccbb7f0a", "hex");
const QUIC_DATAGRAM_LEN = 1200;

const u8 = (n: number) => Buffer.from([n]);
const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
const vec8 = (b: Buffer) => Buffer.concat([u8(b.length), b]);
const vec16 = (b: Buffer) => Buffer.concat([u16(b.length), b]);

function varint(n: number) {
    if (n < 0x40) return u8(n);
    if (n < 0x4000) return u16(0x4000 | n);
    const b = Buffer.alloc(4);
    b.writeUInt32BE((0x80000000 | n) >>> 0);
    return b;
}

function hkdfExpandLabel(secret: Buffer, label: string, length: number) {
    const info = Buffer.concat([u16(length), vec8(Buffer.from(`tls13 ${label}`)), u8(0)]);
    return crypto.createHmac("sha256", secret).update(info).update(u8(1)).digest().subarray(0, length);
}

function buildClientHello(host: string) {
    const ext = (type: number, body: Buffer) => Buffer.concat([u16(type), vec16(body)]);
    const param = (id: number, value: Buffer) => Buffer.concat([varint(id), varint(value.length), value]);

    const transportParams = Buffer.concat([
        param(0x01, varint(30_000)),
        param(0x03, varint(1472)),
        param(0x04, varint(15_728_640)),
        param(0x05, varint(6_291_456)),
        param(0x06, varint(6_291_456)),
        param(0x07, varint(6_291_456)),
        param(0x08, varint(100)),
        param(0x09, varint(100)),
        param(0x0f, Buffer.alloc(0))
    ]);

    const extensions = Buffer.concat([
        ext(0x0000, vec16(Buffer.concat([u8(0), vec16(Buffer.from(host, "ascii"))]))),
        ext(0x000a, vec16(Buffer.concat([u16(0x001d), u16(0x0017), u16(0x0018)]))),
        ext(0x000d, vec16(Buffer.concat([0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501].map(u16)))),
        ext(0x0010, vec16(vec8(Buffer.from("h3")))),
        ext(0x002b, vec8(u16(0x0304))),
        ext(0x002d, vec8(u8(1))),
        ext(0x0033, vec16(Buffer.concat([u16(0x001d), vec16(crypto.randomBytes(32))]))),
        ext(0x0039, transportParams)
    ]);

    const body = Buffer.concat([
        u16(0x0303),
        crypto.randomBytes(32),
        u8(0),
        vec16(Buffer.concat([u16(0x1301), u16(0x1302), u16(0x1303)])),
        vec8(u8(0)),
        vec16(extensions)
    ]);

    return Buffer.concat([u8(1), u8(0), u16(body.length), body]);
}
function buildQuicInitial(host: string) {
    const dcid = crypto.randomBytes(8);
    const pnLen = 4;

    const initialSecret = crypto.createHmac("sha256", QUIC_V1_SALT).update(dcid).digest();
    const clientSecret = hkdfExpandLabel(initialSecret, "client in", 32);
    const key = hkdfExpandLabel(clientSecret, "quic key", 16);
    const iv = hkdfExpandLabel(clientSecret, "quic iv", 12);
    const hp = hkdfExpandLabel(clientSecret, "quic hp", 16);

    const hello = buildClientHello(host);
    const cryptoFrame = Buffer.concat([u8(0x06), varint(0), varint(hello.length), hello]);

    const headerLen = 1 + 4 + 1 + dcid.length + 1 + 1 + 2;
    const payloadLen = QUIC_DATAGRAM_LEN - headerLen - pnLen - 16;
    if (cryptoFrame.length > payloadLen) throw new Error("decoy host name is too long");
    const payload = Buffer.alloc(payloadLen);
    cryptoFrame.copy(payload);

    const header = Buffer.concat([
        u8(0xc0 | (pnLen - 1)),
        Buffer.from([0, 0, 0, 1]),
        vec8(dcid),
        u8(0),
        u8(0),
        varint(pnLen + payloadLen + 16),
        Buffer.alloc(pnLen)
    ]);

    const cipher = crypto.createCipheriv("aes-128-gcm", key, iv);
    cipher.setAAD(header);
    const sealed = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);

    const mask = crypto.createCipheriv("aes-128-ecb", hp, null).update(sealed.subarray(0, 16));
    header[0] ^= mask[0] & 0x0f;
    for (let i = 0; i < pnLen; i++) header[header.length - pnLen + i] ^= mask[1 + i];

    return Buffer.concat([header, sealed]);
}

function loadDecoyPacket(): Buffer | null {
    try {
        const data = fs.readFileSync(PACKET_FILE);
        if (data.length > 0) return data;
    } catch (e: any) {
        if (e?.code !== "ENOENT") reportError(`couldn't read ${PACKET_FILE}`, e);
    }
    try {
        return buildQuicInitial(decoyHost);
    } catch (e) {
        reportError("couldn't build the decoy packet", e);
        return null;
    }
}

function sendPrelude(sock: dgram.Socket, ip: string, port: number) {
    if (decoyMode === "both" || decoyMode === "packet") {
        const packet = loadDecoyPacket();
        if (packet) sock.send(packet, port, ip);
    }
    if (decoyMode === "both" || decoyMode === "bytes") {
        sock.send(Buffer.from([0x00]), port, ip);
        sock.send(Buffer.from([0x01]), port, ip);
    }
}

function maybeStartPrelude(s: Session) {
    if (s.preludeStarted) return;
    const hasDiscovery = s.queue.some(b => b.length === DISCOVERY_LEN);
    if (!hasDiscovery && s.queue.length <= 16) return;

    s.preludeStarted = true;
    sendPrelude(s.egress, s.target.ip, s.target.port);
    log(`prelude (${decoyMode}, ${preludeDelayMs}ms) → ${s.target.ip}:${s.target.port} (ssrc ${s.ssrc})`);

    setTimeout(() => {
        if (sessionsBySsrc.get(s.ssrc) !== s) return;
        const disc = s.queue.filter(b => b.length === DISCOVERY_LEN);
        const rest = s.queue.filter(b => b.length !== DISCOVERY_LEN);
        for (const b of disc) { s.egress.send(b, s.target.port, s.target.ip); s.up++; }
        for (const b of rest) { s.egress.send(b, s.target.port, s.target.ip); s.up++; }
        s.queue = [];
        s.forwarding = true;
    }, preludeDelayMs);
}

function feed(s: Session, data: Buffer) {
    s.lastSeen = Date.now();

    if (decoyMode === "off") {
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
            sock.on("error", e => reportError("relay socket error", e));
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
    egress.on("error", e => reportError(`socket error (ssrc ${ssrc})`, e));

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
    const bound = new Promise<void>((resolve, reject) => {
        egress.once("error", reject);
        egress.bind(0, () => {
            egress.off("error", reject);
            resolve();
        });
    });

    pendingBySsrc.set(ssrc, s);
    log(`target ssrc ${ssrc} → ${ip}:${port}  decoys=${decoyMode}`);

    for (const [key, held] of unmatched) {
        if (held.ssrc === ssrc) {
            bindSession(s, held.address, held.port);
            for (const p of held.packets) feed(s, p);
            unmatched.delete(key);
            break;
        }
    }

    try {
        await bound;
    } catch (e) {
        reportError(`couldn't open a socket for ssrc ${ssrc}`, e);
        closeSession(s);
        throw e;
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