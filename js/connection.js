export class PeerBridge {
    constructor({role, targetId = "", onStatus = () => {}, onData = () => {}, onReady = () => {}}) {
        this.role = role;
        this.targetId = targetId;
        this.onStatus = onStatus;
        this.onData = onData;
        this.onReady = onReady;
        this.peer = null;
        this.connection = null;
    }

    start() {
        if (typeof window.Peer !== "function") {
            this.onStatus("error", "Connection library unavailable");
            throw new Error("PeerJS did not load. Check the internet connection or use the simulator.");
        }

        this.destroy();
        this.onStatus("waiting", this.role === "desktop" ? "Preparing a session" : "Connecting to computer");
        this.peer = new window.Peer(undefined, {debug: 1});

        this.peer.on("open", id => {
            if (this.role === "desktop") {
                this.onReady(id);
                this.onStatus("waiting", "Waiting for phone");
            } else {
                this.connectToDesktop();
            }
        });

        this.peer.on("connection", connection => {
            if (this.role !== "desktop") {
                connection.close();
                return;
            }
            if (connection.metadata?.application !== "motion-lab-phone") {
                connection.close();
                return;
            }
            if (this.connection?.open) this.connection.close();
            this.attachConnection(connection);
        });

        this.peer.on("disconnected", () => {
            if (!this.connection?.open) this.onStatus("waiting", "Rendezvous interrupted");
        });

        this.peer.on("error", error => {
            const message = this.friendlyError(error);
            this.onStatus("error", message);
        });
    }

    connectToDesktop() {
        if (!this.targetId) {
            this.onStatus("error", "Pairing link is incomplete");
            return;
        }
        const connection = this.peer.connect(this.targetId, {
            reliable: true,
            serialization: "json",
            metadata: {application: "motion-lab-phone", version: 1},
        });
        this.attachConnection(connection);
    }

    attachConnection(connection) {
        this.connection = connection;
        connection.on("open", () => {
            this.onStatus("connected", this.role === "desktop" ? "Phone connected" : "Connected to computer");
            if (this.role === "phone") connection.send({type: "hello", device: navigator.userAgent});
        });
        connection.on("data", data => this.onData(data));
        connection.on("close", () => {
            this.onStatus("waiting", this.role === "desktop" ? "Phone disconnected" : "Computer disconnected");
        });
        connection.on("error", () => this.onStatus("error", "Peer connection failed"));
    }

    send(data) {
        if (!this.connection?.open) return false;
        this.connection.send(data);
        return true;
    }

    get connected() {
        return Boolean(this.connection?.open);
    }

    destroy() {
        if (this.connection) this.connection.close();
        if (this.peer && !this.peer.destroyed) this.peer.destroy();
        this.connection = null;
        this.peer = null;
    }

    friendlyError(error) {
        const messages = {
            "peer-unavailable": "Computer session was not found",
            "network": "Network connection failed",
            "server-error": "Rendezvous service is unavailable",
            "socket-error": "Rendezvous connection failed",
            "socket-closed": "Rendezvous connection closed",
            "unavailable-id": "Session identifier is already in use",
            "webrtc": "This network blocked the phone connection",
        };
        return messages[error?.type] ?? "Connection error";
    }
}
