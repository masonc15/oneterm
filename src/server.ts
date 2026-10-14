import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { groupItemIds, remove, restore } from "./restore.ts";
import { type Scope, stash } from "./stash.ts";
import { displayCwd, load, restoreCommand } from "./store.ts";

const PAGE = new URL("../web/index.html", import.meta.url);

function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
	res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
	res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
	let raw = "";
	for await (const chunk of req) {
		raw += chunk;
		if (raw.length > 64_000) throw new Error("body too large");
	}
	return raw ? JSON.parse(raw) : {};
}

function ids(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function state() {
	const stash = load();
	return {
		groups: [...stash.groups].reverse().map((g) => ({
			...g,
			items: g.items.map((i) => ({ ...i, cwdShort: displayCwd(i.cwd), restoreCommand: restoreCommand(i) ?? null })),
		})),
	};
}

export function serve(port: number) {
	const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
	const server = createServer(async (req, res) => {
		// Only this machine, and only pages served from here: any website can aim requests
		// at localhost, so writes need a same-origin custom header that a form can't send.
		if (!hosts.has(req.headers.host ?? "")) return send(res, 403, { error: "bad host" });
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		try {
			if (req.method === "GET" && url.pathname === "/") return send(res, 200, readFileSync(PAGE, "utf8"), "text/html; charset=utf-8");
			if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, state());
			if (req.method !== "POST") return send(res, 404, { error: "not found" });
			const origin = req.headers.origin;
			if (req.headers["x-oneterm"] !== "1" || (origin && !hosts.has(origin.replace(/^https?:\/\//, ""))))
				return send(res, 403, { error: "forbidden" });

			const data = await body(req);
			switch (url.pathname) {
				case "/api/restore": {
					const list = typeof data.groupId === "string" ? groupItemIds(data.groupId) : ids(data.itemIds);
					return send(res, 200, restore(list));
				}
				case "/api/delete": {
					const list = typeof data.groupId === "string" ? groupItemIds(data.groupId) : ids(data.itemIds);
					return send(res, 200, { deleted: remove(list) });
				}
				case "/api/stash": {
					const scope: Scope = data.scope === "others" ? "others" : "all";
					return send(res, 200, stash({ scope }));
				}
				default:
					return send(res, 404, { error: "not found" });
			}
		} catch (err) {
			return send(res, 500, { error: err instanceof Error ? err.message : String(err) });
		}
	});
	server.listen(port, "127.0.0.1", () => console.log(`oneterm: http://127.0.0.1:${port}/`));
}
