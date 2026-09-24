// Same-browser relay for development and automated tests: open the computer
// page and the phone link (with ?relay=local) as two tabs of one browser.
export const localTransport = {
    id: "local",
    label: "Local test relay",
    configured: () => typeof BroadcastChannel === "function",
    create: options => new LocalTransport(options),
};

class LocalTransport {
    constructor({session, role, onMessage, onState}) {
        this.session = session;
        this.role = role;
        this.onMessage = onMessage;
        this.onState = onState;
        this.channel = null;
    }

    async open() {
        this.channel = new BroadcastChannel(`motionlab:${this.session}`);
        this.channel.onmessage = event => {
            if (event.data?.from !== this.role) this.onMessage(event.data?.message);
        };
        this.onState("ready", "");
    }

    send(message) {
        if (!this.channel) return false;
        this.channel.postMessage({from: this.role, message});
        return true;
    }

    close() {
        this.channel?.close();
        this.channel = null;
        this.onState("closed", "");
    }
}
