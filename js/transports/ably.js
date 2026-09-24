import {loadScript, randomToken, withTimeout} from "./util.js";

// Pinned so a library update cannot change behaviour on the day. jsDelivr is
// already used for Pyodide and is reachable on the campus network.
export const ABLY_SDK_URL = "https://cdn.jsdelivr.net/npm/ably@2.29.0/build/ably.min.js";
const OPEN_TIMEOUT_MS = 15000;

export const ablyTransport = {
    id: "ably",
    label: "Ably",
    configured: config => Boolean(config?.ably?.key),
    create: options => new AblyTransport(options),
};

class AblyTransport {
    constructor({session, role, config, onMessage, onState}) {
        this.session = session;
        this.role = role;
        this.key = config.ably.key;
        this.onMessage = onMessage;
        this.onState = onState;
        this.client = null;
        this.channel = null;
        this.attached = false;
        this.closed = false;
    }

    async open() {
        await withTimeout(loadScript(ABLY_SDK_URL), OPEN_TIMEOUT_MS, "Ably library did not load");
        if (typeof window.Ably?.Realtime !== "function") throw new Error("Ably library did not load");
        if (this.closed) return;

        this.client = new window.Ably.Realtime({
            key: this.key,
            clientId: `${this.role}-${randomToken(6)}`,
            // Our own messages are never useful to us, and echoes count towards the quota.
            echoMessages: false,
        });
        this.client.connection.on(change => this.handleConnection(change));

        this.channel = this.client.channels.get(`motionlab:${this.session}`);
        const incoming = this.role === "desktop" ? "phone" : "desktop";
        await withTimeout(
            this.channel.subscribe(incoming, message => this.onMessage(message.data)),
            OPEN_TIMEOUT_MS,
            "Ably did not respond in time",
        );
        this.attached = true;
        if (this.client.connection.state === "connected") this.onState("ready", this.describeTransport());
    }

    handleConnection(change) {
        if (this.closed) return;
        const reason = change?.reason?.message ?? "";
        switch (change?.current) {
            case "connected":
                if (this.attached) this.onState("ready", this.describeTransport());
                break;
            case "connecting":
            case "disconnected":
            case "suspended":
                this.onState("connecting", reason);
                break;
            case "failed":
                // Typically an invalid or revoked key; retrying would not help.
                this.onState("failed", reason || "Ably connection failed");
                break;
            default:
                break;
        }
    }

    describeTransport() {
        const name = this.client?.connection?.connectionManager?.activeProtocol?.transport?.shortName;
        if (name === "web_socket") return "WebSocket";
        if (name) return "HTTP fallback";
        return "";
    }

    send(message) {
        if (!this.channel || this.client?.connection?.state !== "connected") return false;
        const outgoing = this.role === "desktop" ? "desktop" : "phone";
        this.channel.publish(outgoing, message).catch(error => {
            if (!this.closed) this.onState("connecting", error?.message ?? "Publish failed");
        });
        return true;
    }

    close() {
        this.closed = true;
        try {
            this.client?.close();
        } catch {
            // Closing an already-failed client can throw; there is nothing left to release.
        }
        this.client = null;
        this.channel = null;
        this.onState("closed", "");
    }
}
