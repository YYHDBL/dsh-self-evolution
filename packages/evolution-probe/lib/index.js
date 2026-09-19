import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
//#region src/index.ts
const name = "evolution-probe";
const inject = ["sessions"];
function apply(ctx, config) {
	if (!isAbsolute(config.path)) throw new Error("evolution-probe: path must be absolute");
	mkdirSync(dirname(config.path), { recursive: true });
	ctx.on("session/event", (session, event) => {
		if (event.type !== "turn/end") return;
		appendFileSync(config.path, `${JSON.stringify({
			sessionId: session.id,
			event: event.type,
			seq: event.seq,
			time: event.time
		})}\n`);
	});
}
//#endregion
export { apply, inject, name };
