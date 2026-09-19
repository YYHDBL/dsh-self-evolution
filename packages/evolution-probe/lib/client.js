window.__ModuleLoader__.load({
	id: "@self-evolving/evolution-probe",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/index.ts
		const inject = ["slots"];
		function RecordingStatus() {
			return (0, react.createElement)("strong", { role: "status" }, "自进化：记录中");
		}
		function apply(ctx) {
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "evolution-recording",
				order: 100,
				label: "自进化记录状态"
			}, RecordingStatus));
		}
		//#endregion
		exports.RecordingStatus = RecordingStatus;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map