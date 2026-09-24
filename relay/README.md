# Phone pairing relays

The phone and the computer never connect to each other directly. Both join a
short-lived session on one or more **relay services**, and the phone sends its
readings through whichever relay is currently answering.

- The computer creates the session code itself, so the QR code appears
  immediately, even with no network.
- Each relay is independent. The phone checks every relay every few seconds
  and uses the preferred healthy one. If that relay stops answering, it switches
  and re-sends the last few seconds of readings, so nothing is lost.
- Both relays use ordinary HTTPS/WebSocket traffic on port 443, and both fall
  back to plain HTTPS polling if WebSockets are blocked.
- Nothing needs a server of our own, and neither free plan pauses when idle.

This replaced PeerJS, whose public server (`peerjs.com`) is blocked by the
University's endpoint protection on managed Windows PCs, and whose built-in TURN
relays no longer exist.

| Relay | Runs on | Free plan (as of September 2026) | Roughly enough for |
|---|---|---|---|
| Firebase Realtime Database | Google Cloud | 100 simultaneous connections, 10 GB downloaded a month | ~1,000 station-hours of streaming a month |
| Ably | Ably (AWS) | 200 connections, 6 million messages a month | ~150 station-hours as the main relay; ~1,200 as the backup |

A "station-hour" is one phone streaming to one computer for an hour. Each
station uses two connections. Check the providers' pages for current limits:
[Ably limits](https://ably.com/docs/platform/pricing/limits),
[Firebase Realtime Database limits](https://firebase.google.com/docs/database/usage/limits).

## One-off setup (about 15 minutes)

You can set up one relay or both. Both are recommended so there is a backup.
Use a shared outreach Google account, not a personal one.

### Firebase Realtime Database

1. Go to <https://console.firebase.google.com>, choose **Create a project**
   (e.g. `motionlab-uob`) and turn Google Analytics off.
2. Go to **Build → Realtime Database → Create database**, choose
   **europe-west1 (Belgium)**, and start in **locked mode**.
3. Open the **Rules** tab, replace the contents with
   [`firebase-database.rules.json`](firebase-database.rules.json), and press
   **Publish**. These rules allow only session mailboxes with a 20-character
   random code, holding small text messages. Nobody can list the sessions.
4. Copy the database URL from the top of the **Data** tab (for example
   `https://motionlab-uob-default-rtdb.europe-west1.firebasedatabase.app`)
   into `firebase.databaseURL` in [`js/relay-config.js`](../js/relay-config.js).

You don't need to register a web app or add an API key. `apiKey` and
`projectId` are optional.

### Ably

1. Sign up at <https://ably.com/sign-up> (free plan) and create an app
   (e.g. `motionlab`).
2. Under **API Keys**, choose **Create new API key**:
   - Capabilities: **Publish** and **Subscribe** only.
   - Resource restrictions: **Selected channels and queues**, channel
     `motionlab:*`.
3. Copy the key (it looks like `abc123.def456:ghi...`) into `ably.key` in
   [`js/relay-config.js`](../js/relay-config.js).

The key is visible to anyone who views the page source. With the restrictions
above, the most anyone could do with it is use up the monthly message
allowance. If that happens, or after each event, revoke the key and create a
new one.

## Checking it works

1. Commit the config and let GitHub Pages deploy.
2. On a lab PC, open `network-check.html` and press **Run all checks**. Each
   relay gets a **Relay: … (end to end)** line. The verdict says whether both
   work, so you know whether you have a backup.
3. Press **Start pairing test** in section 3 and scan the QR code with a phone
   on the network visitors will use (guest wifi or mobile data).

To test a single relay, add `?relay=firebase` or `?relay=ably` to the address
of either the activity or the network check. The QR code carries the setting
to the phone.

The computer and phone pages also show a small **Relays:** line under the
QR code / status, which shows which relay is in use and why any other is
unavailable (hover for details).

## Development

- `?relay=local` uses a same-browser relay. Open the activity in one tab and
  the QR link in another, with no accounts or network needed.
- `node --test "tests/js/*.test.mjs"` runs the pairing tests, including
  failover between two relays and recovery after an outage.
- To add another relay, write an adapter in `js/transports/` with
  `open()`, `send(message)` and `close()` (see `local.js` for the smallest
  example), then register it in `js/transports/index.js`.

### Options we looked at and did not use

- **Supabase Realtime:** a good fit technically, but free projects pause
  after a week without use, which would break an occasional outreach activity.
- **Public MQTT brokers (HiveMQ, EMQX, Mosquitto):** they need no account,
  but they use ports 8084/8884/8081, which campus firewalls commonly block.
- **PubNub:** its free plan is capped by monthly active users, and every
  visitor's phone would count.
- **Our own relay on Cloudflare Workers (Durable Objects):** this could be a
  third relay later, but it needs deploying and it isn't clear the free plan
  covers a full day of streaming.
- **WebRTC with a TURN server (the old approach):** it still needs a
  signalling service, and TURN credentials can't be kept secret in a static
  page.
