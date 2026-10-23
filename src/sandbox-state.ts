import type { BoxValue } from "./box-document.js";

/** Detach only plain JSON data. Reject getters, sparse arrays, cycles and oversized input before retaining it. */
export const sandbox_snapshot = <Value>(input: Value): Value => {
	let nodes = 0,
		units = 0;
	const active = new Set<object>();
	const copy = (value: unknown, depth: number): unknown => {
		if (++nodes > 1_000_000 || depth > 256) throw new TypeError("Sandbox snapshot exceeds its capacity");
		if (typeof value === "string") {
			units += value.length;
			if (units > 16_777_216) throw new TypeError("Sandbox snapshot exceeds its capacity");
			return value;
		}
		if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
		if (typeof value !== "object" || active.has(value)) throw new TypeError("Sandbox requires plain JSON data");
		const array = Array.isArray(value);
		if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
			throw new TypeError("Sandbox requires plain JSON data");
		const keys = Reflect.ownKeys(value).filter((key) => !array || key !== "length");
		if (array && keys.length !== value.length) throw new TypeError("Sandbox requires dense arrays");
		active.add(value);
		const entries = keys.map((key, index): [string, unknown] => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
			if (typeof key !== "string" || !("value" in descriptor) || !descriptor.enumerable || (array && key !== String(index)))
				throw new TypeError("Sandbox requires plain JSON data");
			copy(key, depth + 1);
			return [key, copy(descriptor.value, depth + 1)];
		});
		active.delete(value);
		return Object.freeze(array ? entries.map((entry) => entry[1]) : Object.fromEntries(entries));
	};
	return copy(input, 0) as Value;
};

export type SandboxCellValue = { readonly status: "unset" } | { readonly status: "value"; readonly value: BoxValue };

/** Only for engine-owned, already admitted data. Terminal traces must not incur another admission budget. */
export const freeze_sandbox_state = <Value>(value: Value): Value => {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) freeze_sandbox_state(child);
	return Object.freeze(value);
};
