#!/usr/bin/env python3
"""Build the native MCP executable and a Claude Desktop binary MCPB.

The release pipeline signs the executable before packing. No user runtime is
needed. MCPB installation asks for the socket and connection ID supplied by
Kuku; neither is an OAuth token. Actual access is enforced by the app grant.
"""
import argparse
import json
from pathlib import Path
import shutil
import os
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[2]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--signing-identity", default=os.environ.get("APPLE_SIGNING_IDENTITY"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    command = ["cargo", "build", "-p", "kuku-mcp"]
    if not args.debug:
        command.append("--release")
    subprocess.run(command, cwd=ROOT, check=True)
    binary = ROOT / "target" / ("debug" if args.debug else "release") / "kuku-mcp"
    destination = ROOT / "apps/desktop/src-tauri/resources/memory/kuku-mcp"
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(binary, destination)
    if args.signing_identity:
        subprocess.run(["codesign", "--force", "--options", "runtime", "--timestamp", "--sign", args.signing_identity, str(destination)], check=True)
        subprocess.run(["codesign", "--verify", "--strict", str(destination)], check=True)
    manifest = {
        "manifest_version": "0.3", "name": "kuku-memory", "version": "0.1.0",
        "display_name": "Kuku Memory", "description": "Your shared preferences and decisions from Kuku.",
        "author": {"name": "Kuku"},
        "server": {"type": "binary", "entry_point": "server/kuku-mcp", "mcp_config": {
            "command": "${__dirname}/server/kuku-mcp",
            "args": ["--socket", "${user_config.socket}", "--connection", "${user_config.connection}", "--bundle", "${user_config.bundle}"]}},
        "user_config": {
            "socket": {"type": "string", "title": "Kuku socket", "description": "Copy from Kuku's connection settings.", "required": True},
            "connection": {"type": "string", "title": "Connection ID", "description": "Copy from Kuku's connection settings.", "required": True},
            "bundle": {"type": "string", "title": "Kuku application", "description": "The bundle identifier shown in Kuku connection settings.", "default": "mom.kuku.app"}},
        "compatibility": {"platforms": ["darwin"]},
    }
    output = args.output or destination.parent / "kuku-memory.mcpb"
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, indent=2))
        archive.write(destination, "server/kuku-mcp")
    print(output)

if __name__ == "__main__":
    main()
