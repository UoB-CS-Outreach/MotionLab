import {randomToken, withTimeout} from "./util.js";

// Google's own CDN, already confirmed reachable from the lab PCs by the network check.
export const FIREBASE_SDK_BASE = "https://www.gstatic.com/firebasejs/10.12.0/";
const OPEN_TIMEOUT_MS = 15000;

export const firebaseTransport = {
    id: "firebase",
    label: "Firebase",
    configured: config => Boolean(config?.firebase?.databaseURL),
    create: options => new FirebaseTransport(options),
};

// Each session is a small mailbox in the Realtime Database:
//   motionlab/<session>/toDesktop/<push id> = {m: "<json>"}
//   motionlab/<session>/toPhone/<push id>   = {m: "<json>"}
// The receiver deletes every message as soon as it has read it, and the
// computer's onDisconnect handler removes the whole session when it leaves,
// so nothing accumulates in the database.
class FirebaseTransport {
    constructor({session, role, config, onMessage, onState}) {
        this.session = session;
        this.role = role;
        this.config = config.firebase;
        this.onMessage = onMessage;
        this.onState = onState;
        this.sdk = null;
        this.app = null;
        this.database = null;
        this.outbox = null;
        this.unsubscribers = [];
        this.connected = false;
        this.closed = false;
    }

    async open() {
        const [appSdk, databaseSdk] = await withTimeout(
            Promise.all([
                import(`${FIREBASE_SDK_BASE}firebase-app.js`),
                import(`${FIREBASE_SDK_BASE}firebase-database.js`),
            ]).catch(() => {
                throw new Error("Firebase library did not load (www.gstatic.com blocked?)");
            }),
            OPEN_TIMEOUT_MS,
            "Firebase library did not load",
        );
        if (this.closed) return;
        this.sdk = {...appSdk, ...databaseSdk};
        const sdk = this.sdk;

        const options = {databaseURL: this.config.databaseURL};
        if (this.config.apiKey) options.apiKey = this.config.apiKey;
        if (this.config.projectId) options.projectId = this.config.projectId;
        // A uniquely named app per connection lets the network check run a
        // computer and a phone side by side in one tab.
        this.app = sdk.initializeApp(options, `motionlab-${this.role}-${randomToken(6)}`);
        this.database = sdk.getDatabase(this.app);

        const base = sdk.ref(this.database, `motionlab/${this.session}`);
        const inbox = sdk.child(base, this.role === "desktop" ? "toDesktop" : "toPhone");
        this.outbox = sdk.child(base, this.role === "desktop" ? "toPhone" : "toDesktop");

        let everConnected = false;
        const firstConnection = new Promise((resolve, reject) => {
            this.unsubscribers.push(sdk.onValue(sdk.ref(this.database, ".info/connected"), snapshot => {
                this.connected = snapshot.val() === true;
                if (this.closed) return;
                if (this.connected) {
                    everConnected = true;
                    // Server-side clean-up if this tab closes or drops off: the computer
                    // removes the whole session, a phone removes what it sent. An
                    // onDisconnect handler fires only once, so re-arm it on every connection.
                    sdk.onDisconnect(this.role === "desktop" ? base : this.outbox).remove().catch(() => {});
                    this.onState("ready", "");
                    resolve();
                } else {
                    // The SDK always reports "not connected" once before its first connection.
                    this.onState("connecting", everConnected ? "Reconnecting to Firebase" : "Connecting to Firebase");
                }
            }, reject));
        });

        this.unsubscribers.push(sdk.onChildAdded(inbox, snapshot => {
            sdk.remove(snapshot.ref).catch(() => {});
            try {
                this.onMessage(JSON.parse(snapshot.val()?.m ?? "null"));
            } catch {
                // Ignore anything that is not one of our messages.
            }
        }, error => {
            if (!this.closed) this.onState("failed", describeError(error));
        }));

        await withTimeout(
            firstConnection,
            OPEN_TIMEOUT_MS,
            "Firebase did not respond in time (check databaseURL in js/relay-config.js, or firebasedatabase.app may be blocked here)",
        );
    }

    send(message) {
        if (!this.outbox || !this.connected) return false;
        this.sdk.push(this.outbox, {m: JSON.stringify(message)}).catch(error => {
            if (!this.closed) this.onState("failed", describeError(error));
        });
        return true;
    }

    close() {
        this.closed = true;
        for (const unsubscribe of this.unsubscribers) {
            try {
                unsubscribe();
            } catch {
                // Listener already gone.
            }
        }
        this.unsubscribers = [];
        if (this.role === "desktop" && this.sdk && this.database) {
            this.sdk.remove(this.sdk.ref(this.database, `motionlab/${this.session}`)).catch(() => {});
        }
        if (this.app && this.sdk) this.sdk.deleteApp(this.app).catch(() => {});
        this.app = null;
        this.outbox = null;
        this.onState("closed", "");
    }
}

function describeError(error) {
    const text = String(error?.message ?? error ?? "");
    if (/permission/i.test(text)) return "Firebase refused access (check the database rules)";
    return text || "Firebase error";
}
