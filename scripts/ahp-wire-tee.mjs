#!/usr/bin/env node
/**
 * AHP Wire Tee — a transparent WebSocket "tee" proxy for capturing the EXACT
 * frames ahpx exchanges with an Agent Host (AHP) server.
 *
 * Place it between ahpx and the real host:
 *
 *     ahpx ──ws──▶ tee (LISTEN_PORT) ──ws──▶ host (TARGET_URL)
 *
 * Every frame is logged with a direction tag (C->S / S->C), an ISO timestamp,
 * and the parsed JSON payload — both to stderr (human-readable) and, if a log
 * path is given, appended as one JSON object per line (NDJSON) for later
 * `node -e` filtering.
 *
 * Usage:
 *   node scripts/ahp-wire-tee.mjs [--listen 8099] [--target ws://127.0.0.1:8090] [--log wire.ndjson]
 *
 * Equivalent env vars (flags win):
 *   TEE_LISTEN_PORT   port the proxy listens on            (default 8099)
 *   TEE_TARGET_URL    upstream host WebSocket URL          (default ws://127.0.0.1:8090)
 *   TEE_LOG_PATH      NDJSON frame log file                (default: none, stderr only)
 *
 * The proxy is byte-faithful for framing: it relays each WebSocket message
 * verbatim (text or binary) and only *parses* a copy for logging, so it never
 * alters what ahpx sends or what the host returns.
 */

import { appendFileSync } from "node:fs";
import { WebSocket, WebSocketServer } from "ws";

function parseArgs(argv) {
	const args = { listen: undefined, target: undefined, log: undefined };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--listen") args.listen = argv[++i];
		else if (a === "--target") args.target = argv[++i];
		else if (a === "--log") args.log = argv[++i];
		else if (a === "--help" || a === "-h") args.help = true;
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
	console.log(
		"Usage: node scripts/ahp-wire-tee.mjs [--listen 8099] [--target ws://127.0.0.1:8090] [--log wire.ndjson]",
	);
	process.exit(0);
}

const LISTEN_PORT = Number(args.listen ?? process.env.TEE_LISTEN_PORT ?? 8099);
const TARGET_URL = args.target ?? process.env.TEE_TARGET_URL ?? "ws://127.0.0.1:8090";
const LOG_PATH = args.log ?? process.env.TEE_LOG_PATH ?? "";

function record(direction, raw) {
	const ts = new Date().toISOString();
	const text = typeof raw === "string" ? raw : raw.toString("utf-8");
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = null;
	}
	const summary = parsed?.method ?? (parsed?.id != null ? `response#${parsed.id}` : "");
	console.error(`${ts} ${direction} ${summary}`.trimEnd());
	if (LOG_PATH) {
		const entry = JSON.stringify({ ts, direction, summary, json: parsed, raw: parsed ? undefined : text });
		appendFileSync(LOG_PATH, `${entry}\n`);
	}
}

const wss = new WebSocketServer({ port: LISTEN_PORT, host: "127.0.0.1" });

wss.on("connection", (client) => {
	const upstream = new WebSocket(TARGET_URL);
	const pending = [];
	let upstreamOpen = false;

	upstream.on("open", () => {
		upstreamOpen = true;
		for (const { data, isBinary } of pending) upstream.send(data, { binary: isBinary });
		pending.length = 0;
	});

	client.on("message", (data, isBinary) => {
		record("C->S", isBinary ? data : data.toString("utf-8"));
		if (upstreamOpen) upstream.send(data, { binary: isBinary });
		else pending.push({ data, isBinary });
	});

	upstream.on("message", (data, isBinary) => {
		record("S->C", isBinary ? data : data.toString("utf-8"));
		if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
	});

	client.on("close", (code, reason) => upstream.close(code, reason));
	upstream.on("close", (code, reason) => {
		if (client.readyState === WebSocket.OPEN) client.close(code, reason);
	});

	client.on("error", () => upstream.close());
	upstream.on("error", (err) => {
		console.error(`upstream error: ${err.message}`);
		if (client.readyState === WebSocket.OPEN) client.close();
	});
});

wss.on("listening", () => {
	console.error(`ahp-wire-tee listening on ws://127.0.0.1:${LISTEN_PORT} -> ${TARGET_URL}`);
	if (LOG_PATH) console.error(`logging frames to ${LOG_PATH}`);
});

wss.on("error", (err) => {
	console.error(`tee proxy error: ${err.message}`);
	process.exit(1);
});
