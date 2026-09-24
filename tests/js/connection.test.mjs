// Run with: node --test tests/js/
import assert from "node:assert/strict";
import {afterEach, test} from "node:test";

import {decodeSample, encodeSample, PairingBridge, PROTOCOL_VERSION} from "../../js/connection.js";
import {selectTransports} from "../../js/transports/index.js";

const FAST = {batchMs: 20, heartbeatMs: 60, healthTimeoutMs: 200, retryMs: 100, maxPending: 50, resendRows: 50, maxRowsPerMessage: 4};
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function until(predicate, milliseconds = 2000) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > milliseconds) throw new Error("condition not met in time");
        await wait(5);
    }
}

// An in-memory relay whose outage can be switched on and off by the test.
class MemoryRelay {
    constructor(id) {
        this.id = id;
        this.down = false;
        this.failOpen = false;
        this.members = new Set();
        this.delivered = 0;
        this.delay = 1;
    }

    factory() {
        return {
            id: this.id,
            label: this.id.toUpperCase(),
            configured: () => true,
            create: options => new MemoryTransport(this, options),
        };
    }

    publish(sender, message) {
        if (this.down) return;
        for (const member of this.members) {
            if (member !== sender && member.session === sender.session) {
                this.delivered += 1;
                const copy = structuredClone(message);
                setTimeout(() => member.onMessage(copy), this.delay);
            }
        }
    }
}

class MemoryTransport {
    constructor(relay, {session, onMessage, onState}) {
        this.relay = relay;
        this.session = session;
        this.onMessage = onMessage;
        this.onState = onState;
    }

    async open() {
        if (this.relay.failOpen) throw new Error(`${this.relay.id} unreachable`);
        this.relay.members.add(this);
    }

    send(message) {
        this.relay.publish(this, message);
        return true;
    }

    close() {
        this.relay.members.delete(this);
    }
}

function sample(seq, t = 1000 + seq * 35) {
    return {type: "sensor", seq, t, ax: seq, ay: 2.12345, az: 9.81, gx: 1, gy: 2, gz: 3, interval: 16, source: "test"};
}

const liveBridges = new Set();

// Every bridge made by a test is destroyed afterwards, even if an assertion
// failed, so stray timers cannot keep the test process alive.
function track(bridge) {
    liveBridges.add(bridge);
    return bridge;
}

afterEach(() => {
    for (const bridge of liveBridges) bridge.destroy();
    liveBridges.clear();
});

function pair(relays, {config} = {}) {
    const received = [];
    const statuses = {desktop: [], phone: []};
    let session = "";
    const desktop = track(new PairingBridge({
        role: "desktop",
        transports: relays.map(relay => relay.factory()),
        timing: FAST,
        config,
        onReady: code => {
            session = code;
        },
        onStatus: (state, message) => statuses.desktop.push(`${state}: ${message}`),
        onData: data => received.push(data),
    }));
    desktop.start();
    const phone = track(new PairingBridge({
        role: "phone",
        session,
        transports: relays.map(relay => relay.factory()),
        timing: FAST,
        onStatus: (state, message) => statuses.phone.push(`${state}: ${message}`),
    }));
    phone.start();
    return {desktop, phone, received, statuses, session};
}

test("samples survive the compact encoding", () => {
    const decoded = decodeSample(encodeSample(sample(7)), "test");
    assert.equal(decoded.seq, 7);
    assert.equal(decoded.ay, 2.123);
    assert.equal(decoded.az, 9.81);
    assert.equal(decoded.type, "sensor");
    assert.equal(decoded.source, "test");
});

test("the computer shows a session code immediately, before any relay answers", () => {
    const relay = new MemoryRelay("a");
    relay.failOpen = true;
    let code = "";
    const desktop = new PairingBridge({role: "desktop", transports: [relay.factory()], timing: FAST, onReady: value => { code = value; }});
    desktop.start();
    assert.match(code, /^[a-z2-7]{20}$/);
    desktop.destroy();
});

test("phone readings reach the computer in order", async () => {
    const relay = new MemoryRelay("a");
    const {desktop, phone, received} = pair([relay]);
    await until(() => phone.connected && desktop.connected);
    for (let seq = 1; seq <= 20; seq += 1) phone.send(sample(seq));
    await until(() => received.length === 20);
    assert.deepEqual(received.map(item => item.seq), Array.from({length: 20}, (_, index) => index + 1));
    phone.destroy();
    desktop.destroy();
});

test("the phone switches to the second relay when the first goes down, without losing readings", async () => {
    const first = new MemoryRelay("a");
    const second = new MemoryRelay("b");
    const {desktop, phone, received, statuses} = pair([first, second]);
    await until(() => phone.routes.every(route => route.healthy));
    assert.equal(phone.activeRoute.id, "a");

    for (let seq = 1; seq <= 5; seq += 1) phone.send(sample(seq));
    await until(() => received.length === 5);

    // The first relay starts silently dropping messages. Readings sent before
    // the phone notices are lost on that relay and must be re-sent on the other.
    first.down = true;
    for (let seq = 6; seq <= 10; seq += 1) phone.send(sample(seq));
    await wait(FAST.batchMs * 3);
    assert.equal(received.length, 5, "readings 6-10 went into the dead relay");
    await until(() => !phone.routes[0].healthy, 1000);
    assert.equal(phone.activeRoute.id, "b");
    for (let seq = 11; seq <= 12; seq += 1) phone.send(sample(seq));
    await until(() => received.length === 12);
    assert.deepEqual(received.map(item => item.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.equal(desktop.routeSummary().find(route => route.active)?.id, "b");

    first.down = false;
    await until(() => phone.routes[0].healthy, 1000);
    assert.equal(phone.activeRoute.id, "a", "returns to the preferred relay once it recovers");
    phone.destroy();
    desktop.destroy();
});

test("moving back to the preferred relay does not lose readings still in flight on the backup", async () => {
    const first = new MemoryRelay("a");
    const second = new MemoryRelay("b");
    const received = [];
    let session = "";
    const timing = {...FAST, healthTimeoutMs: 1000};
    const desktop = track(new PairingBridge({
        role: "desktop", transports: [first.factory(), second.factory()], timing,
        onReady: code => { session = code; }, onData: data => received.push(data),
    }));
    desktop.start();
    const phone = track(new PairingBridge({role: "phone", session, transports: [first.factory(), second.factory()], timing}));
    phone.start();
    await until(() => phone.routes.every(route => route.healthy));

    first.down = true;
    await until(() => !phone.routes[0].healthy, 3000);
    // The backup is slow, so these readings are still on their way when the
    // preferred relay recovers and the phone moves back to it.
    second.delay = 200;
    for (let seq = 1; seq <= 5; seq += 1) phone.send(sample(seq));
    await until(() => phone.pending.length === 0);
    first.down = false;
    await until(() => phone.activeRoute?.id === "a", 1000);
    for (let seq = 6; seq <= 10; seq += 1) phone.send(sample(seq));
    await until(() => received.length === 10, 2000);
    assert.deepEqual(received.map(item => item.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("readings sent during a total outage are delivered once a relay recovers", async () => {
    const relay = new MemoryRelay("a");
    const {desktop, phone, received} = pair([relay]);
    await until(() => phone.connected);
    relay.down = true;
    await until(() => !phone.connected, 1000);
    for (let seq = 1; seq <= 5; seq += 1) phone.send(sample(seq));
    relay.down = false;
    await until(() => received.length === 5, 3000);
    phone.destroy();
    desktop.destroy();
});

test("a relay that cannot be reached at first is retried", async () => {
    const flaky = new MemoryRelay("a");
    flaky.failOpen = true;
    const {desktop, phone, statuses} = pair([flaky]);
    await until(() => statuses.phone.some(line => line.startsWith("error: No relay service reachable")));
    flaky.failOpen = false;
    await until(() => phone.connected && desktop.connected, 1500);
    phone.destroy();
    desktop.destroy();
});

test("duplicate batches are ignored by the computer", async () => {
    const relay = new MemoryRelay("a");
    const {desktop, phone, received} = pair([relay]);
    await until(() => phone.connected);
    const route = phone.routes[0];
    const batch = {k: "data", p: phone.phoneId, s: [encodeSample(sample(1)), encodeSample(sample(2))], src: "test"};
    phone.sendOn(route, batch);
    phone.sendOn(route, batch);
    await wait(80);
    assert.deepEqual(received.map(item => item.seq), [1, 2]);
    phone.destroy();
    desktop.destroy();
});

test("a second phone scanning the code takes over from the first", async () => {
    const relay = new MemoryRelay("a");
    const {desktop, phone, received, session} = pair([relay]);
    await until(() => phone.connected);
    const phoneStatuses = [];
    const second = track(new PairingBridge({
        role: "phone",
        session,
        transports: [relay.factory()],
        timing: FAST,
        onStatus: (state, message) => phoneStatuses.push(`${state}: ${message}`),
    }));
    second.start();
    await until(() => second.connected);
    second.send(sample(1));
    await until(() => received.length === 1);
    await until(() => !phone.connected, 1000);
    assert.ok(phone.destroyed, "the first phone stops once replaced");
    second.destroy();
    desktop.destroy();
});

test("a phone that has been replaced cannot take the session back", async () => {
    const relay = new MemoryRelay("a");
    const {desktop, phone, session} = pair([relay]);
    await until(() => phone.connected && desktop.connected);
    const second = track(new PairingBridge({role: "phone", session, transports: [relay.factory()], timing: FAST}));
    second.start();
    await until(() => desktop.currentPhone === second.phoneId);

    // A late hello from the first phone: one sent on a relay that has just
    // reconnected, or one that waited in a Firebase mailbox.
    desktop.receive(desktop.routes[0], {k: "hello", v: PROTOCOL_VERSION, p: phone.phoneId, r: "phone"});
    await wait(FAST.heartbeatMs * 4);
    assert.equal(desktop.currentPhone, second.phoneId, "the computer stays with the newer phone");
    assert.ok(!second.destroyed, "the newer phone keeps its connection");
});

test("a phone link without a session code reports an error", () => {
    const relay = new MemoryRelay("a");
    const statuses = [];
    const phone = new PairingBridge({role: "phone", transports: [relay.factory()], onStatus: (state, message) => statuses.push(`${state}: ${message}`)});
    phone.start();
    assert.deepEqual(statuses, ["error: Pairing link is incomplete"]);
    phone.destroy();
});

test("relay selection honours configuration and the ?relay= override", () => {
    const empty = {order: ["ably", "firebase"], ably: {key: ""}, firebase: {databaseURL: ""}};
    assert.deepEqual(selectTransports(empty).map(item => item.id), []);

    const both = {order: ["ably", "firebase"], ably: {key: "x.y:z"}, firebase: {databaseURL: "https://example.firebaseio.com"}};
    assert.deepEqual(selectTransports(both).map(item => item.id), ["ably", "firebase"]);
    assert.deepEqual(selectTransports(both, "firebase").map(item => item.id), ["firebase"]);
    assert.deepEqual(selectTransports(both, "local").map(item => item.id), ["local"]);
    assert.deepEqual(selectTransports(both, "nonsense").map(item => item.id), []);
});

test("desktop with no configured relay says so", () => {
    const statuses = [];
    let code = "";
    const desktop = new PairingBridge({
        role: "desktop",
        transports: [],
        onReady: value => { code = value; },
        onStatus: (state, message) => statuses.push(`${state}: ${message}`),
    });
    desktop.start();
    assert.equal(code, "");
    assert.deepEqual(statuses, ["error: No relay service configured"]);
    desktop.announce();
    assert.deepEqual(statuses, ["error: No relay service configured", "error: No relay service configured"]);
    desktop.destroy();
});
