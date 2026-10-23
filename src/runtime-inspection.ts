import { z } from "zod";
import type { BoxValue } from "./box-document.js";

export type RuntimeInspectionMode = "structure" | "values";

export type RuntimeInspectionValue = { status: "available"; value: BoxValue } | { status: "uninitialized" | "not_recorded" | "redacted" | "omitted" };

export type RuntimeInspectionEventKind =
	| "frame.enter"
	| "frame.exit"
	| "statement"
	| "expression"
	| "cell.input"
	| "cell.write"
	| "effect"
	| "failure";

export type RuntimeInspectionOutcome = "success" | "rejected" | "fault" | "effect" | null;

export interface RuntimeInspectionEvent {
	sequence: number;
	frame_id: number;
	parent_frame_id: number | null;
	depth: number;
	box_id: string;
	kind: RuntimeInspectionEventKind;
	statement_id: string | null;
	expression_id: string | null;
	cell_id: string | null;
	value: RuntimeInspectionValue | null;
	outcome: RuntimeInspectionOutcome;
}

export interface RuntimeInspection {
	schema: "runtime.inspection.v1";
	mode: RuntimeInspectionMode;
	values: "not_requested" | "recorded" | "redacted";
	events: RuntimeInspectionEvent[];
	truncated: boolean;
}

export const RUNTIME_INSPECTION_LIMITS = Object.freeze({
	max_events: 4096,
	max_value_nodes: 20_000,
	max_string_units: 100_000,
	max_value_depth: 64,
});

export interface RuntimeInspectionFrame {
	frame_id: number;
	parent_frame_id: number | null;
	depth: number;
	box_id: string;
}

type RuntimeInspectionEventInput = Omit<RuntimeInspectionEvent, "sequence" | keyof RuntimeInspectionFrame>;

class RuntimeInspectionValueOmittedError extends Error {
	constructor() {
		super("Runtime inspection value was omitted");
		this.name = "RuntimeInspectionValueOmittedError";
	}
}

interface RuntimeInspectionValueMetrics {
	nodes: number;
	string_units: number;
}

const detached_inspection_value = (
	value: BoxValue,
	depth: number,
	metrics: RuntimeInspectionValueMetrics,
	remaining_nodes: number,
	remaining_string_units: number,
	active: Set<object>,
): BoxValue => {
	if (depth > RUNTIME_INSPECTION_LIMITS.max_value_depth || metrics.nodes >= remaining_nodes) throw new RuntimeInspectionValueOmittedError();
	metrics.nodes += 1;
	if (typeof value === "string") {
		if (value.length > remaining_string_units - metrics.string_units) throw new RuntimeInspectionValueOmittedError();
		metrics.string_units += value.length;
		return value;
	}
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (active.has(value)) throw new RuntimeInspectionValueOmittedError();
	active.add(value);
	try {
		if (Array.isArray(value)) {
			return Object.freeze(value.map((item) => detached_inspection_value(item, depth + 1, metrics, remaining_nodes, remaining_string_units, active)));
		}
		const entries: [string, BoxValue][] = [];
		for (const [key, item] of Object.entries(value)) {
			if (key.length > remaining_string_units - metrics.string_units) throw new RuntimeInspectionValueOmittedError();
			metrics.string_units += key.length;
			entries.push([key, detached_inspection_value(item, depth + 1, metrics, remaining_nodes, remaining_string_units, active)]);
		}
		return Object.freeze(Object.fromEntries(entries) as Record<string, BoxValue>);
	} finally {
		active.delete(value);
	}
};

const invalid_inspection = (): never => {
	throw new TypeError("Invalid RuntimeInspection");
};

const strict_record = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid_inspection();
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return invalid_inspection();
	const own_keys = Reflect.ownKeys(value);
	if (own_keys.length !== keys.length || own_keys.some((key) => typeof key !== "string" || !keys.includes(key))) return invalid_inspection();
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid_inspection();
	}
	return value as Record<string, unknown>;
};

const strict_array = (value: unknown, max_length: number): readonly unknown[] => {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max_length) return invalid_inspection();
	const length_descriptor = Object.getOwnPropertyDescriptor(value, "length");
	if (!length_descriptor || !("value" in length_descriptor) || length_descriptor.value !== value.length) return invalid_inspection();
	const own_keys = Reflect.ownKeys(value);
	if (own_keys.length !== value.length + 1) return invalid_inspection();
	for (let index = 0; index < value.length; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid_inspection();
	}
	return value;
};

const canonical_uuid = z.uuid();
const canonical_uuid_or_null = (value: unknown): string | null => {
	if (value === null) return null;
	const parsed = canonical_uuid.safeParse(value);
	if (!parsed.success || parsed.data !== value || value !== value.toLowerCase()) return invalid_inspection();
	return value;
};
const bounded_integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): number => {
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) return invalid_inspection();
	return value as number;
};

const normalize_inspection_box_value = (value: unknown, depth: number, metrics: RuntimeInspectionValueMetrics, active: Set<object>): BoxValue => {
	if (depth > RUNTIME_INSPECTION_LIMITS.max_value_depth || metrics.nodes >= RUNTIME_INSPECTION_LIMITS.max_value_nodes) return invalid_inspection();
	metrics.nodes += 1;
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return invalid_inspection();
		return Object.is(value, -0) ? 0 : value;
	}
	if (typeof value === "string") {
		if (value.length > RUNTIME_INSPECTION_LIMITS.max_string_units - metrics.string_units) return invalid_inspection();
		metrics.string_units += value.length;
		return value;
	}
	if (typeof value !== "object" || active.has(value)) return invalid_inspection();
	active.add(value);
	try {
		if (Array.isArray(value)) {
			const items = strict_array(value, RUNTIME_INSPECTION_LIMITS.max_value_nodes);
			return Object.freeze(items.map((item) => normalize_inspection_box_value(item, depth + 1, metrics, active)));
		}
		const prototype: unknown = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return invalid_inspection();
		const entries: [string, BoxValue][] = [];
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string") return invalid_inspection();
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid_inspection();
			if (key.length > RUNTIME_INSPECTION_LIMITS.max_string_units - metrics.string_units) return invalid_inspection();
			metrics.string_units += key.length;
			entries.push([key, normalize_inspection_box_value(descriptor.value, depth + 1, metrics, active)]);
		}
		return Object.freeze(Object.fromEntries(entries) as Record<string, BoxValue>);
	} finally {
		active.delete(value);
	}
};

const event_keys = [
	"sequence",
	"frame_id",
	"parent_frame_id",
	"depth",
	"box_id",
	"kind",
	"statement_id",
	"expression_id",
	"cell_id",
	"value",
	"outcome",
] as const;
const event_kinds = new Set<RuntimeInspectionEventKind>([
	"frame.enter",
	"frame.exit",
	"statement",
	"expression",
	"cell.input",
	"cell.write",
	"effect",
	"failure",
]);
const terminal_outcomes = new Set<RuntimeInspectionOutcome>(["success", "rejected", "fault", "effect"]);

const normalize_inspection_event_value = (
	input: unknown,
	mode: RuntimeInspectionMode,
	values: RuntimeInspection["values"],
	metrics: RuntimeInspectionValueMetrics,
): RuntimeInspectionValue | null => {
	if (input === null) return null;
	const record = strict_record(input, Object.hasOwn(input as object, "value") ? ["status", "value"] : ["status"]);
	const status = record.status;
	if (status === "available") {
		if (mode !== "values" || values !== "recorded") return invalid_inspection();
		return Object.freeze({ status, value: normalize_inspection_box_value(record.value, 1, metrics, new Set()) });
	}
	if (status !== "uninitialized" && status !== "not_recorded" && status !== "redacted" && status !== "omitted") return invalid_inspection();
	if (Object.hasOwn(record, "value")) return invalid_inspection();
	if (status === "not_recorded" && (mode !== "structure" || values !== "not_requested")) return invalid_inspection();
	if (status === "redacted" && values !== "redacted") return invalid_inspection();
	if (status === "omitted" && (mode !== "values" || values !== "recorded")) return invalid_inspection();
	return Object.freeze({ status });
};

interface ValidatedFrame {
	frame_id: number;
	parent_frame_id: number | null;
	depth: number;
	box_id: string;
	exited: boolean;
	exit_outcome: RuntimeInspectionOutcome;
}

export const normalize_runtime_inspection = (input: unknown): RuntimeInspection => {
	const root = strict_record(input, ["schema", "mode", "values", "events", "truncated"]);
	if (root.schema !== "runtime.inspection.v1") return invalid_inspection();
	const mode = root.mode;
	if (mode !== "structure" && mode !== "values") return invalid_inspection();
	const values = root.values;
	if (values !== "not_requested" && values !== "recorded" && values !== "redacted") return invalid_inspection();
	if ((mode === "structure" && values !== "not_requested") || (mode === "values" && values === "not_requested")) return invalid_inspection();
	if (typeof root.truncated !== "boolean") return invalid_inspection();
	const input_events = strict_array(root.events, RUNTIME_INSPECTION_LIMITS.max_events);
	const events: RuntimeInspectionEvent[] = [];
	const frames = new Map<number, ValidatedFrame>();
	const stack: ValidatedFrame[] = [];
	const metrics = { nodes: 0, string_units: 0 };
	let next_frame_id = 0;
	let saw_omitted = false;
	for (let index = 0; index < input_events.length; index += 1) {
		const record = strict_record(input_events[index], event_keys);
		const sequence = bounded_integer(record.sequence, RUNTIME_INSPECTION_LIMITS.max_events - 1);
		if (sequence !== index) return invalid_inspection();
		const frame_id = bounded_integer(record.frame_id);
		const parent_frame_id = record.parent_frame_id === null ? null : bounded_integer(record.parent_frame_id);
		const depth = bounded_integer(record.depth, RUNTIME_INSPECTION_LIMITS.max_value_depth);
		const box_id = canonical_uuid_or_null(record.box_id);
		if (box_id === null) return invalid_inspection();
		const kind = record.kind;
		if (typeof kind !== "string" || !event_kinds.has(kind as RuntimeInspectionEventKind)) return invalid_inspection();
		const statement_id = canonical_uuid_or_null(record.statement_id);
		const expression_id = canonical_uuid_or_null(record.expression_id);
		const cell_id = canonical_uuid_or_null(record.cell_id);
		const value = normalize_inspection_event_value(record.value, mode, values, metrics);
		const outcome = record.outcome;
		if (outcome !== null && (typeof outcome !== "string" || !terminal_outcomes.has(outcome as RuntimeInspectionOutcome))) {
			return invalid_inspection();
		}

		let frame = frames.get(frame_id);
		if (kind === "frame.enter") {
			if (
				frame ||
				frame_id !== next_frame_id ||
				statement_id !== null ||
				expression_id !== null ||
				cell_id !== null ||
				value !== null ||
				outcome !== null
			) {
				return invalid_inspection();
			}
			const parent = stack.at(-1) ?? null;
			if (
				(parent === null && (parent_frame_id !== null || depth !== 0)) ||
				(parent !== null && (parent_frame_id !== parent.frame_id || depth !== parent.depth + 1))
			) {
				return invalid_inspection();
			}
			frame = { frame_id, parent_frame_id, depth, box_id, exited: false, exit_outcome: null };
			frames.set(frame_id, frame);
			stack.push(frame);
			next_frame_id += 1;
		} else if (kind === "failure" && frame?.exited) {
			if (
				frame.parent_frame_id !== null ||
				stack.length > 0 ||
				frame.parent_frame_id !== parent_frame_id ||
				frame.depth !== depth ||
				frame.box_id !== box_id ||
				expression_id !== null ||
				value !== null ||
				outcome !== "fault" ||
				(statement_id !== null && frame.exit_outcome !== "effect") ||
				(statement_id !== null && cell_id !== null)
			) {
				return invalid_inspection();
			}
		} else {
			if (!frame || frame.exited || stack.at(-1) !== frame) return invalid_inspection();
			if (frame.parent_frame_id !== parent_frame_id || frame.depth !== depth || frame.box_id !== box_id) return invalid_inspection();
			if (kind === "frame.exit") {
				if (statement_id !== null || expression_id !== null || cell_id !== null || value !== null || outcome === null) return invalid_inspection();
				frame.exited = true;
				frame.exit_outcome = outcome as RuntimeInspectionOutcome;
				stack.pop();
			} else if (kind === "statement") {
				if (statement_id === null || expression_id !== null || cell_id !== null || value !== null || outcome !== null) return invalid_inspection();
			} else if (kind === "expression") {
				if (statement_id === null || expression_id === null || cell_id !== null || value === null || outcome !== null) return invalid_inspection();
			} else if (kind === "cell.input") {
				if (statement_id !== null || expression_id !== null || cell_id === null || value === null || outcome !== null) return invalid_inspection();
			} else if (kind === "cell.write") {
				if (statement_id === null || expression_id !== null || cell_id === null || value === null || outcome !== null) return invalid_inspection();
			} else if (kind === "effect") {
				if (statement_id === null || expression_id !== null || cell_id !== null || value === null || outcome !== "effect")
					return invalid_inspection();
			} else if (value !== null || (outcome !== "fault" && outcome !== "rejected")) {
				return invalid_inspection();
			}
		}
		if (value?.status === "omitted") saw_omitted = true;
		events.push(
			Object.freeze({
				sequence,
				frame_id,
				parent_frame_id,
				depth,
				box_id,
				kind: kind as RuntimeInspectionEventKind,
				statement_id,
				expression_id,
				cell_id,
				value,
				outcome: outcome as RuntimeInspectionOutcome,
			}),
		);
	}
	if (saw_omitted && root.truncated !== true) return invalid_inspection();
	if (!root.truncated && stack.length > 0) return invalid_inspection();
	return Object.freeze({
		schema: "runtime.inspection.v1",
		mode,
		values,
		events: Object.freeze(events) as RuntimeInspectionEvent[],
		truncated: root.truncated,
	});
};

/** Bind a canonical observation stream to its claimed terminal invocation without re-executing it. */
export const matches_runtime_inspection_terminal = (
	inspection: RuntimeInspection,
	entry_box_id: string,
	status: "success" | "rejected" | "fault",
): boolean => {
	const first = inspection.events[0];
	if (!first) return status === "fault";
	if (first.kind !== "frame.enter" || first.frame_id !== 0 || first.parent_frame_id !== null || first.box_id !== entry_box_id) return false;
	let root_exit: RuntimeInspectionEvent | undefined;
	let observed_failure = false;
	for (const event of inspection.events) {
		// This evaluator has no recovery branch: after a fatal event only unwinding remains.
		if (observed_failure && (event.kind !== "frame.exit" || event.outcome !== status)) return false;
		if (event.kind === "failure") {
			if (event.outcome !== status) return false;
			observed_failure = true;
		}
		if (event.kind === "frame.exit") {
			if ((event.outcome === "fault" || event.outcome === "rejected") && (event.outcome !== status || !observed_failure)) return false;
			if (event.frame_id === 0) root_exit = event;
		}
	}
	if (status === "fault") {
		// Output/host failures may occur after a successful/effect-suspended body.
		// At the event cap their failure event can be outside the recorded prefix.
		return observed_failure || inspection.truncated;
	}
	if (root_exit) return root_exit.outcome === status;
	return inspection.truncated;
};

export const is_canonical_runtime_inspection = (input: unknown): input is RuntimeInspection => {
	try {
		normalize_runtime_inspection(input);
		return true;
	} catch {
		return false;
	}
};

export class RuntimeInspectionRecorder {
	readonly mode: RuntimeInspectionMode;
	readonly events: RuntimeInspectionEvent[] = [];
	truncated = false;
	values: RuntimeInspection["values"];
	#next_frame_id = 0;
	#value_nodes = 0;
	#string_units = 0;

	constructor(mode: RuntimeInspectionMode) {
		this.mode = mode;
		this.values = mode === "structure" ? "not_requested" : "recorded";
	}

	redact_values(): void {
		if (this.mode === "values") this.values = "redacted";
	}

	frame(box_id: string, depth: number, parent_frame_id: number | null): RuntimeInspectionFrame {
		return { frame_id: this.#next_frame_id++, parent_frame_id, depth, box_id };
	}

	value(value: BoxValue | undefined, initialized = true): RuntimeInspectionValue {
		if (this.events.length >= RUNTIME_INSPECTION_LIMITS.max_events) {
			this.truncated = true;
			return Object.freeze({ status: "omitted" });
		}
		if (!initialized) return Object.freeze({ status: "uninitialized" });
		if (this.mode === "structure") return Object.freeze({ status: "not_recorded" });
		if (this.values === "redacted") return Object.freeze({ status: "redacted" });
		try {
			const metrics = { nodes: 0, string_units: 0 };
			const detached = detached_inspection_value(
				value as BoxValue,
				1,
				metrics,
				RUNTIME_INSPECTION_LIMITS.max_value_nodes - this.#value_nodes,
				RUNTIME_INSPECTION_LIMITS.max_string_units - this.#string_units,
				new Set(),
			);
			this.#value_nodes += metrics.nodes;
			this.#string_units += metrics.string_units;
			return Object.freeze({ status: "available", value: detached });
		} catch (error) {
			if (!(error instanceof RuntimeInspectionValueOmittedError)) throw error;
			this.truncated = true;
			return Object.freeze({ status: "omitted" });
		}
	}

	record(frame: RuntimeInspectionFrame, event: RuntimeInspectionEventInput): void {
		if (this.events.length >= RUNTIME_INSPECTION_LIMITS.max_events) {
			this.truncated = true;
			return;
		}
		this.events.push(Object.freeze({ sequence: this.events.length, ...frame, ...event }));
	}

	inspection(): RuntimeInspection {
		return Object.freeze({
			schema: "runtime.inspection.v1",
			mode: this.mode,
			values: this.values,
			events: Object.freeze([...this.events]) as RuntimeInspectionEvent[],
			truncated: this.truncated,
		});
	}
}
