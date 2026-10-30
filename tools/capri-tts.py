#!/usr/bin/env python3
# Capri's cloned voice: Chatterbox (Resemble AI, MIT) as a small HTTP server on
# 127.0.0.1, with the model in memory and conditioned once on a reference clip
# of the voice (used with its owner's consent). src/voice.js starts it with the
# Python from her chatterbox venv, the first time she needs it.
#
#   GET  /                                             -> "ok" once the model is ready
#   POST /tts {"text", "exaggeration", "cfg_weight"}   -> audio/wav, 24 kHz mono
#
# Everything Chatterbox generates carries its inaudible watermark.

import argparse
import io
import json
import sys
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer

import torch
from chatterbox.tts import ChatterboxTTS


def load(device):
    model = ChatterboxTTS.from_pretrained(device=device)
    return model


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=47916)
    parser.add_argument("--reference", required=True, help="a clip of the voice, 10 to 20 seconds")
    args = parser.parse_args()

    # An NVIDIA GPU, else Apple's GPU, else the CPU.
    model = None
    devices = (["cuda"] if torch.cuda.is_available() else []) + (["mps"] if torch.backends.mps.is_available() else []) + ["cpu"]
    for device in devices:
        try:
            model = load(device)
            break
        except Exception as err:  # noqa: BLE001 - try the next device
            print(f"chatterbox: {device} failed ({err}), trying the next one", file=sys.stderr, flush=True)
    if model is None:
        raise SystemExit("chatterbox: no device worked")
    model.prepare_conditionals(args.reference)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            text = str(body.get("text", "")).strip()
            if not text:
                self.send_response(400)
                self.end_headers()
                return
            with torch.inference_mode():
                audio = model.generate(
                    text,
                    exaggeration=float(body.get("exaggeration", 0.5)),
                    cfg_weight=float(body.get("cfg_weight", 0.5)),
                )
            pcm = (audio.squeeze(0).clamp(-1, 1) * 32767).to(torch.int16).cpu().numpy().tobytes()
            buf = io.BytesIO()
            with wave.open(buf, "wb") as out:
                out.setnchannels(1)
                out.setsampwidth(2)
                out.setframerate(model.sr)
                out.writeframes(pcm)
            data = buf.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    print(f"chatterbox: ready on 127.0.0.1:{args.port}", file=sys.stderr, flush=True)
    HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
