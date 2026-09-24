import {ablyTransport} from "./ably.js";
import {firebaseTransport} from "./firebase.js";
import {localTransport} from "./local.js";

export const TRANSPORTS = {
    ably: ablyTransport,
    firebase: firebaseTransport,
    local: localTransport,
};

// Picks the relays to use, in preference order. `override` is the ?relay=
// URL parameter (e.g. "firebase" or "ably,firebase"), which lets staff test
// one service on its own; it is carried from the computer into the QR link.
export function selectTransports(config, override = "") {
    const requested = override
        ? override.split(",").map(name => name.trim().toLowerCase()).filter(Boolean)
        : config?.order ?? [];
    const chosen = [];
    for (const name of requested) {
        const transport = TRANSPORTS[name];
        if (transport && !chosen.includes(transport) && transport.configured(config)) chosen.push(transport);
    }
    return chosen;
}
