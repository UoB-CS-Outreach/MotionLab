"""Serve Motion Lab locally for simulator-based development.

A real phone needs an HTTPS deployment. Browsers do not grant motion-sensor
access to ordinary HTTP pages opened from another device on the local network.
"""

from argparse import ArgumentParser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def main() -> None:
    parser = ArgumentParser(description="Run the Motion Lab static site locally.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    site_directory = Path(__file__).resolve().parent
    handler = partial(SimpleHTTPRequestHandler, directory=site_directory)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Motion Lab is running at http://localhost:{args.port}")
    print("Press Ctrl+C to stop. Use the simulator for local HTTP testing.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nMotion Lab stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
