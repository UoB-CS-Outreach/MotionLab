// Relay services that carry phone readings to the computer.
//
// Both values below are *client* credentials: they are designed to sit in a
// public web page. Access is limited by the key's capability (Ably) and the
// database rules (Firebase), not by keeping them secret. See relay/README.md
// for how to create them and how to lock them down.
//
// A service with an empty setting is simply skipped. With nothing configured
// the activity still works through the built-in simulator.

export const RELAY_CONFIG = {
    // Order of preference. The phone uses the first relay that is answering,
    // moves to the next if it stops, and returns once the preferred one
    // recovers. Firebase goes first
    // because its free plan is metered by bandwidth, which goes much further
    // than Ably's monthly message allowance (see relay/README.md).
    order: ["firebase", "ably"],

    ably: {
        // API key restricted to {"motionlab:*": ["publish", "subscribe"]}.
        key: "swXShg.h9C55A:-UOM1ZYCn0qJjnBcTCcj8A3ClKbV2lqmGQCGN9oF6qc",
    },

    firebase: {
        // Only databaseURL is required for the Realtime Database. Use the URL
        // shown at the top of the Realtime Database "Data" tab, e.g.
        // "https://motionlab-uob-default-rtdb.europe-west1.firebasedatabase.app".
        databaseURL: "https://motionlab-uob-default-rtdb.europe-west1.firebasedatabase.app/",
        apiKey: "",
        projectId: "",
    },
};
