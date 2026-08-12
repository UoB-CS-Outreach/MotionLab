# Motion Lab prototype

Motion Lab is a browser-based university open-day activity. A participant connects their phone to a lab computer, streams accelerometer and gyroscope readings, records labelled movements, and trains a small human-activity-recognition model.

The prototype deliberately has no accounts, database, Python environment, or installation step for participants. The same static site provides the computer view and the phone view.

## What currently works

- A desktop session creates a phone link and QR code.
- The phone requests motion permission only after a button press, as required by iOS.
- Accelerometer (including gravity) and gyroscope values are sent at approximately 25 samples per second.
- The computer shows six live values and two scrolling charts.
- Participants can record three-second labelled trials.
- Any recorded trial can be selected and viewed as acceleration and gyroscope series.
- Raw trials can be downloaded as CSV.
- A k-nearest-neighbours model is trained entirely in the computer browser.
- Leave-one-trial-out accuracy and live predictions are displayed.
- A four-pattern signal simulator exercises the complete workflow without a phone.

## Try it locally

From this directory, run:

```powershell
python run_local.py
```

Then open `http://localhost:8000`. Expand **No phone yet? Use the signal simulator**, start it, and record at least two examples from two different simulated movements. Press **Train activity model**, then switch the simulated movement to test live prediction.

The simulator is the correct way to test from a local HTTP server. A real phone needs the site to be published over HTTPS because mobile browsers block motion sensors on ordinary network HTTP addresses.

## Try it on a real phone

1. Publish this directory through GitHub Pages with HTTPS enabled.
2. Open the published page on the lab computer.
3. Scan its QR code using the phone's normal camera.
4. On the phone, press **Enable motion sensors** and approve the browser prompt if one appears.
5. Return to the computer screen to see and record the live signal.

No build step is required. In GitHub repository settings, Pages can publish directly from the repository root (or from a `/docs` directory if the files are moved there).

## Components

| File | Purpose |
| --- | --- |
| `index.html` | Both the computer and phone interfaces. `?mode=phone&peer=...` selects phone mode. |
| `styles.css` | Responsive visual design and accessible interaction states. |
| `js/app.js` | Page orchestration, recording workflow, CSV export, and live predictions. |
| `js/connection.js` | PeerJS/WebRTC pairing and browser-to-browser data connection. |
| `js/sensors.js` | Mobile `DeviceMotionEvent` permission and sensor capture. |
| `js/simulator.js` | Synthetic still, shake, bounce, and circle signals. |
| `js/chart.js` | Lightweight canvas charts with no charting dependency. |
| `js/model.js` | Feature extraction, standardisation, k-nearest-neighbours, and trial-level evaluation. |
| `tests/model.test.mjs` | Automated checks for the signal-processing and model code. |
| `run_local.py` | Small local static-file server for development. |

## How phone pairing works

The prototype uses PeerJS. Its free cloud service only introduces the two browsers and exchanges connection metadata. Sensor readings then travel over an encrypted WebRTC data channel between the phone and computer.

This choice lets the prototype remain a static GitHub Pages site, but it is not the recommended final open-day infrastructure. The two pinned third-party scripts are:

- PeerJS 1.5.5 from jsDelivr
- QRCode.js 1.0.0 from cdnjs

If those scripts cannot load, the simulator remains usable but phone pairing or QR generation will not be available.

## How the model works

Each three-second trial is kept intact. Motion Lab calculates seven simple properties for each of the six channels: mean, standard deviation, minimum, maximum, root-mean-square energy, average absolute change, and a normalised zero-crossing count. It also measures acceleration and rotation magnitudes and the observed sampling rate.

Features are standardised, then a small k-nearest-neighbours classifier compares a live two-second window with the recorded examples. Evaluation leaves out one complete trial at a time. Keeping whole trials together avoids the overly optimistic result produced when almost-identical windows from one movement are placed in both training and test sets.

The percentage next to a live prediction is a neighbour-vote heuristic, not a statistically calibrated probability.

## Current issues and constraints

1. **Campus network reliability:** the free PeerJS service supplies signalling and a public STUN server, but no guaranteed TURN relay. Symmetric NAT, strict firewall rules, separate Wi-Fi/wired VLANs, or blocked WebRTC can prevent a connection.
2. **Prototype external services:** the rendezvous service and two CDN files are outside university control and have no open-day availability guarantee.
3. **Device differences:** sampling rates, sensor axes, precision, and missing gyroscope values vary between phone/browser combinations. A compatibility check is performed, but this needs testing on the actual event devices and network.
4. **Phone orientation:** the model sees device-coordinate axes. Rotating the phone between training and prediction can change the signal substantially.
5. **Small-data evaluation:** with only a handful of recordings, accuracy is illustrative and can vary sharply. It should be presented as an experiment rather than a reliable scientific estimate.
6. **No persistence:** refreshing the computer page clears the dataset and model. Participants should download CSV if they want to keep readings.
7. **Background throttling:** mobile browsers may slow or pause sensor events when the phone page is hidden or the screen locks. The prototype requests a screen wake lock where supported.
8. **Local real-phone testing:** `localhost` URLs in the QR code refer to the phone itself, and plain LAN HTTP does not meet the secure-context requirement. Use an HTTPS test deployment or secure development tunnel.

## Recommended next improvements

Before using this at a busy open day:

1. Replace the public PeerJS rendezvous with a university-controlled secure WebSocket relay, or deploy a private PeerServer plus TURN over port 443. A WebSocket relay is simplest and most predictable for low-volume sensor messages.
2. Bundle third-party code with the repository and add a strict content-security policy.
3. Run a device/network compatibility trial using university wired computers, guest Wi-Fi, iPhones, and Android phones.
4. Add a pre-recorded fallback dataset and a clear facilitator reset button for every station.
5. Add calibration, fixed-rate resampling, gravity separation, magnitude/orientation-invariant features, and configurable window sizes.
6. Add a confusion-matrix view and guided questions explaining overfitting, validation, and why different people produce different signals.
7. Offer model choices: feature k-NN as the baseline, 1-NN dynamic time warping as a time-series model, and optionally a Pyodide/scikit-learn classifier or compact ROCKET-style transform.
8. Add installable PWA/offline support once the controlled pairing service is available.
9. Add an explicit privacy notice and data-retention statement reviewed for an event involving young visitors.

## Automated check

If Node.js is installed, run:

```powershell
npm test
```

The automated tests cover feature extraction, synthetic activity separation, leave-one-trial-out evaluation, and dataset readiness. Phone sensor permissions and cross-device WebRTC still require physical-device testing after HTTPS deployment.
