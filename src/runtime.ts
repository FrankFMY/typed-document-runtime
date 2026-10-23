import { z } from "zod";
import type { BoxDocument, BoxDocumentNode, BoxValue } from "./box-document.js";
import { normalize_box_value_at } from "./box-document.js";
import type { BoxProgramExpression } from "./box-program.js";
import { create_box_type_comparer } from "./box-type-system.js";
import type { ProcessDocument, ProcessEffectDeclaration } from "./process-document.js";
import { process_document_box_schema } from "./process-document.js";
import { compare_scalar } from "./scalar-comparison.js";
import type { ProcessEffectStatement } from "./process-program.js";
import type { ProjectSourceSnapshot } from "./project-source-snapshot.js";
import { is_canonical_project_source_snapshot } from "./project-source-snapshot.js";
import type {
	RuntimeInspection,
	RuntimeInspectionEvent,
	RuntimeInspectionFrame,
	RuntimeInspectionMode,
	RuntimeInspectionValue,
} from "./runtime-inspection.js";
import { RuntimeInspectionRecorder } from "./runtime-inspection.js";
import type { SandboxCellValue } from "./sandbox-state.js";
import { freeze_sandbox_state, sandbox_snapshot } from "./sandbox-state.js";

export type { RuntimeInspection, RuntimeInspectionEvent, RuntimeInspectionMode, RuntimeInspectionValue } from "./runtime-inspection.js";
export {
	is_canonical_runtime_inspection,
	matches_runtime_inspection_terminal,
	normalize_runtime_inspection,
	RUNTIME_INSPECTION_LIMITS,
} from "./runtime-inspection.js";

export interface RuntimeBudget {
	max_steps: number;
	max_call_depth: number;
	max_value_nodes: number;
	max_string_units: number;
}

export const RUNTIME_BUDGET_LIMITS = Object.freeze({
	max_steps: 100_000,
	max_call_depth: 64,
	max_value_nodes: 100_000,
	max_string_units: 16_777_216,
}) satisfies RuntimeBudget;

export interface RuntimePublication {
	id: string;
	snapshot: ProjectSourceSnapshot;
}

export interface RuntimeInputCell {
	cell_id: string;
	value: unknown;
}

export interface RuntimeExecutionRequest {
	publication: RuntimePublication;
	entry_box_id: string;
	input: readonly RuntimeInputCell[];
	output_cell_ids: readonly string[];
	budget: RuntimeBudget;
	inspection?: RuntimeInspectionMode;
}

export interface ProcessRuntimeBudget extends RuntimeBudget {
	max_effects: number;
}

export const PROCESS_RUNTIME_BUDGET_LIMITS = Object.freeze({
	...RUNTIME_BUDGET_LIMITS,
	max_effects: 64,
}) satisfies ProcessRuntimeBudget;

export interface ProcessEffectReceipt {
	statement_id: string;
	effect_id: string;
	capability: string;
	request: unknown;
	result: unknown;
}

export interface ProcessExecutionRequest {
	publication: RuntimePublication;
	process_id: string;
	invocation_id: string;
	input: readonly RuntimeInputCell[];
	effect_receipts: readonly ProcessEffectReceipt[];
	budget: ProcessRuntimeBudget;
	inspection?: RuntimeInspectionMode;
}

export interface RuntimeUsage {
	steps: number;
	calls: number;
	value_nodes: number;
	string_units: number;
}

export type RuntimeTraceEvent =
	| { sequence: number; kind: "box.enter"; box_id: string; depth: number }
	| { sequence: number; kind: "statement"; box_id: string; statement_id: string; statement_kind: string }
	| { sequence: number; kind: "box.call"; box_id: string; statement_id: string; target_box_id: string; depth: number }
	| { sequence: number; kind: "effect.intent" | "effect.replay"; box_id: string; statement_id: string; effect_id: string; index: number }
	| { sequence: number; kind: "cell.write"; box_id: string; statement_id: string; cell_id: string }
	| { sequence: number; kind: "box.exit"; box_id: string; depth: number; outcome: "success" | "rejected" | "fault" | "effect" };

type WithoutSequence<Event> = Event extends RuntimeTraceEvent ? Omit<Event, "sequence"> : never;
type RuntimeTraceInput = WithoutSequence<RuntimeTraceEvent>;

export interface RuntimeSuccess {
	status: "success";
	publication_id: string;
	project_id: string;
	source_revision: string;
	outputs: { cell_id: string; value: BoxValue }[];
	usage: RuntimeUsage;
	trace: RuntimeTraceEvent[];
	inspection?: RuntimeInspection;
}

export interface RuntimeFault {
	status: "fault";
	publication_id: string;
	project_id: string | null;
	source_revision: string | null;
	fault: { code: string; message: string };
	usage: RuntimeUsage;
	trace: RuntimeTraceEvent[];
	inspection?: RuntimeInspection;
}

export interface RuntimeRejected {
	status: "rejected";
	publication_id: string;
	project_id: string;
	source_revision: string;
	rejection: { code: string; details: BoxValue | null };
	usage: RuntimeUsage;
	trace: RuntimeTraceEvent[];
	inspection?: RuntimeInspection;
}

export type RuntimeExecutionOutcome = RuntimeSuccess | RuntimeRejected | RuntimeFault;

export interface ProcessUsage extends RuntimeUsage {
	effects: number;
}

interface ProcessOutcomeBase {
	publication_id: string;
	process_id: string;
	invocation_id: string;
	usage: ProcessUsage;
	trace: RuntimeTraceEvent[];
	inspection?: RuntimeInspection;
}

export interface ProcessSuccess extends ProcessOutcomeBase {
	status: "success";
	project_id: string;
	source_revision: string;
	outputs: { cell_id: string; value: BoxValue }[];
}

export interface ProcessRejected extends ProcessOutcomeBase {
	status: "rejected";
	project_id: string;
	source_revision: string;
	rejection: { code: string; details: BoxValue | null };
}

export interface ProcessFault extends ProcessOutcomeBase {
	status: "fault";
	project_id: string | null;
	source_revision: string | null;
	fault: { code: string; message: string };
}

export interface ProcessEffectIntent extends ProcessOutcomeBase {
	status: "effect";
	project_id: string;
	source_revision: string;
	effect: {
		index: number;
		statement_id: string;
		effect_id: string;
		capability: string;
		request: BoxValue;
	};
}

export type ProcessExecutionOutcome = ProcessSuccess | ProcessRejected | ProcessFault | ProcessEffectIntent;

type BoxExecutableDocument = Extract<BoxDocument, { schema: "box.document.v2" }>;
type ExecutableDocument = BoxExecutableDocument | ProcessDocument;
interface RuntimeCell {
	type_id: string;
	value: BoxValue | typeof UNSET;
}

interface RuntimeBinding {
	type_id: string;
	value: BoxValue;
}
type RuntimeBox = ProjectSourceSnapshot["boxes"][number] & { document: ExecutableDocument };
type RuntimeRoot = Extract<BoxDocumentNode, { kind: "record" }>;

interface RuntimeFrame {
	frame_id: number;
	parent_frame_id: number | null;
	box: RuntimeBox;
	document: ExecutableDocument;
	root: RuntimeRoot;
	cells: Map<string, RuntimeCell>;
	cell_types: Map<string, string>;
	bindings: Map<string, RuntimeBinding>;
	depth: number;
	inspection: RuntimeInspectionFrame | null;
	statement_id: string | null;
}

interface RuntimeBoundary {
	kind: "statement" | "effect";
	frames: RuntimeFrame[];
	usage: ProcessUsage;
	effect?: SandboxEffect;
}
type RuntimeContinuation = Generator<RuntimeBoundary, RuntimeExecutionOutcome | ProcessExecutionOutcome, ProcessEffectReceipt | undefined>;

export type SandboxExecutionRequest = Omit<ProcessExecutionRequest, "invocation_id" | "effect_receipts">;
export type SandboxControl = "into" | "over" | "out" | "continue";
export interface SandboxBreakpoint {
	readonly box_id: string;
	readonly statement_id: string;
}
export interface SandboxFrame {
	readonly frame_id: number;
	readonly parent_frame_id: number | null;
	readonly box_id: string;
	readonly depth: number;
	readonly statement_id: string | null;
	readonly cells: readonly ({ readonly cell_id: string; readonly type_id: string } & SandboxCellValue)[];
}
export type SandboxEffect = ProcessEffectIntent["effect"] & { readonly result_type_id: string };
export interface SandboxView {
	readonly session_id: string | null;
	readonly publication: RuntimePublication | null;
	readonly status: "paused" | "running" | "effect" | "success" | "rejected" | "fault" | "stopped";
	readonly reason: "entry" | "step" | "breakpoint" | "effect" | null;
	readonly frames: readonly SandboxFrame[];
	readonly usage: Readonly<ProcessUsage>;
	readonly effect: SandboxEffect | null;
	readonly outcome: ProcessSuccess | ProcessRejected | ProcessFault | null;
	readonly breakpoints: readonly SandboxBreakpoint[];
}

class RuntimeFailureError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "RuntimeFailureError";
		this.code = code;
	}
}

class RuntimeExpectedRejectionError extends Error {
	readonly code: string;
	readonly details: BoxValue | null;

	constructor(code: string, details: BoxValue | null) {
		super(code);
		this.name = "RuntimeExpectedRejectionError";
		this.code = code;
		this.details = details;
	}
}

class RuntimeEffectIntentError extends Error {
	readonly effect: ProcessEffectIntent["effect"];

	constructor(effect: ProcessEffectIntent["effect"]) {
		super("Process execution requires an effect receipt");
		this.name = "RuntimeEffectIntentError";
		this.effect = effect;
	}
}

const UNSET = Symbol("runtime.unset");
const canonical_uuid = z.uuid();

const json_values_equal = (left: BoxValue, right: BoxValue): boolean => {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		return left.every((value, index) => json_values_equal(value, right[index] as BoxValue));
	}
	if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
	const left_record = left as Record<string, BoxValue>;
	const right_record = right as Record<string, BoxValue>;
	const keys = Object.keys(left_record);
	return (
		keys.length === Object.keys(right_record).length &&
		keys.every((key) => Object.hasOwn(right_record, key) && json_values_equal(left_record[key]!, right_record[key]!))
	);
};

interface RuntimeValueMetrics {
	nodes: number;
	string_units: number;
}

const value_metrics = (value: BoxValue): RuntimeValueMetrics => {
	if (Array.isArray(value)) {
		const total = { nodes: 1, string_units: 0 };
		for (const item of value as readonly BoxValue[]) {
			const item_metrics = value_metrics(item);
			total.nodes += item_metrics.nodes;
			total.string_units += item_metrics.string_units;
		}
		return total;
	}
	if (typeof value === "object" && value !== null) {
		const total = { nodes: 1, string_units: 0 };
		for (const item of Object.values(value)) {
			const item_metrics = value_metrics(item);
			total.nodes += item_metrics.nodes;
			total.string_units += item_metrics.string_units;
		}
		return total;
	}
	return { nodes: 1, string_units: typeof value === "string" ? value.length : 0 };
};

const valid_budget = (budget: RuntimeBudget): boolean =>
	Number.isSafeInteger(budget.max_steps) &&
	budget.max_steps > 0 &&
	budget.max_steps <= RUNTIME_BUDGET_LIMITS.max_steps &&
	Number.isSafeInteger(budget.max_call_depth) &&
	budget.max_call_depth > 0 &&
	budget.max_call_depth <= RUNTIME_BUDGET_LIMITS.max_call_depth &&
	Number.isSafeInteger(budget.max_value_nodes) &&
	budget.max_value_nodes > 0 &&
	budget.max_value_nodes <= RUNTIME_BUDGET_LIMITS.max_value_nodes &&
	Number.isSafeInteger(budget.max_string_units) &&
	budget.max_string_units > 0 &&
	budget.max_string_units <= RUNTIME_BUDGET_LIMITS.max_string_units;

const valid_process_budget = (budget: ProcessRuntimeBudget): boolean =>
	valid_budget(budget) &&
	Number.isSafeInteger(budget.max_effects) &&
	budget.max_effects > 0 &&
	budget.max_effects <= PROCESS_RUNTIME_BUDGET_LIMITS.max_effects;

const effect_receipt_result = (document: ProcessDocument, type_id: string, result: unknown): BoxValue => {
	try {
		return normalize_box_value_at(process_document_box_schema(document), type_id, result);
	} catch {
		throw new RuntimeFailureError("invalid_effect_receipt", "Process effect receipt result is invalid");
	}
};

const execute_runtime = function* execute_runtime(
	request: RuntimeExecutionRequest | ProcessExecutionRequest,
	mode: "box" | "process",
	sandbox = false,
	on_failure?: (frames: readonly RuntimeFrame[]) => void,
): RuntimeContinuation {
	const process_request = mode === "process" ? (request as ProcessExecutionRequest) : null;
	const box_request = mode === "box" ? (request as RuntimeExecutionRequest) : null;
	const usage: RuntimeUsage = { steps: 0, calls: 0, value_nodes: 0, string_units: 0 };
	const inspection_recorder = request.inspection ? new RuntimeInspectionRecorder(request.inspection) : null;
	const inspection_fields = (): { inspection: RuntimeInspection } | Record<string, never> =>
		inspection_recorder ? { inspection: inspection_recorder.inspection() } : {};
	let consumed_effects = 0;
	const trace: RuntimeTraceEvent[] = [];
	const publication_id = request.publication.id;
	let project_id: string | null = null;
	let source_revision: string | null = null;
	let current_frame: RuntimeFrame | null = null;
	let next_frame_id = 0;
	const frames: RuntimeFrame[] = [];
	const active_box_ids = new Set<string>();
	const type_comparer = create_box_type_comparer((message) => new RuntimeFailureError("invalid_source", message));
	const resolved_type = (document: ExecutableDocument, type_id: string): ReturnType<typeof type_comparer.resolved_type> =>
		type_comparer.resolved_type(document, type_id);
	const same_type = (document: ExecutableDocument, left: string, right: string): boolean => type_comparer.same_type(document, left, document, right);
	const same_type_between = (left_document: ExecutableDocument, left: string, right_document: ExecutableDocument, right: string): boolean =>
		type_comparer.same_type(left_document, left, right_document, right);
	const scalar_type = (document: ExecutableDocument, type_id: string, expected: "string" | "number" | "boolean" | "absence"): boolean =>
		type_comparer.scalar_type(document, type_id, expected);

	const process_usage = (): ProcessUsage => ({ ...usage, effects: consumed_effects });
	const fault = (code: string, message: string): RuntimeFault | ProcessFault =>
		process_request
			? {
					status: "fault",
					publication_id,
					process_id: process_request.process_id,
					invocation_id: process_request.invocation_id,
					project_id,
					source_revision,
					fault: { code, message },
					usage: process_usage(),
					trace,
					...inspection_fields(),
				}
			: {
					status: "fault",
					publication_id,
					project_id,
					source_revision,
					fault: { code, message },
					usage,
					trace,
					...inspection_fields(),
				};
	const rejected = (error: RuntimeExpectedRejectionError): RuntimeRejected | RuntimeFault | ProcessRejected | ProcessFault => {
		if (project_id === null || source_revision === null) return fault("runtime_fault", "Runtime rejection escaped publication binding");
		if (process_request) {
			return {
				status: "rejected",
				publication_id,
				process_id: process_request.process_id,
				invocation_id: process_request.invocation_id,
				project_id,
				source_revision,
				rejection: { code: error.code, details: error.details },
				usage: process_usage(),
				trace,
				...inspection_fields(),
			};
		}
		return {
			status: "rejected",
			publication_id,
			project_id,
			source_revision,
			rejection: { code: error.code, details: error.details },
			usage,
			trace,
			...inspection_fields(),
		};
	};
	const effect_intent = (error: RuntimeEffectIntentError): ProcessEffectIntent | ProcessFault => {
		if (!process_request || project_id === null || source_revision === null)
			return fault("runtime_fault", "Effect intent escaped Process execution") as ProcessFault;
		return {
			status: "effect",
			publication_id,
			process_id: process_request.process_id,
			invocation_id: process_request.invocation_id,
			project_id,
			source_revision,
			effect: error.effect,
			usage: process_usage(),
			trace,
			...inspection_fields(),
		};
	};
	const append_trace = (event: RuntimeTraceInput): void => {
		trace.push({ sequence: trace.length, ...event } as RuntimeTraceEvent);
	};
	const inspection_value = (value: BoxValue | typeof UNSET): RuntimeInspectionValue =>
		inspection_recorder?.value(value === UNSET ? undefined : value, value !== UNSET) ?? { status: "not_recorded" };
	const record_inspection = (
		frame: RuntimeFrame,
		event: Omit<RuntimeInspectionEvent, "sequence" | "frame_id" | "parent_frame_id" | "depth" | "box_id">,
	): void => {
		if (inspection_recorder && frame.inspection) inspection_recorder.record(frame.inspection, event);
	};
	const recorded_failures = new WeakSet<object>();
	const record_failure = (error: unknown, frame: RuntimeFrame, expression_id: string | null, cell_id: string | null = null): void => {
		if (error instanceof RuntimeEffectIntentError || (typeof error === "object" && error !== null && recorded_failures.has(error))) return;
		if (typeof error === "object" && error !== null) recorded_failures.add(error);
		record_inspection(frame, {
			kind: "failure",
			statement_id: frame.statement_id,
			expression_id,
			cell_id,
			value: null,
			outcome: error instanceof RuntimeExpectedRejectionError ? "rejected" : "fault",
		});
	};
	const consume_step = (): void => {
		if (usage.steps >= request.budget.max_steps) throw new RuntimeFailureError("budget_exceeded", "Runtime step budget was exceeded");
		usage.steps += 1;
	};
	const assert_value_capacity = (metrics: RuntimeValueMetrics): void => {
		if (
			usage.value_nodes + metrics.nodes > request.budget.max_value_nodes ||
			usage.string_units + metrics.string_units > request.budget.max_string_units
		) {
			throw new RuntimeFailureError("budget_exceeded", "Runtime value budget was exceeded");
		}
	};
	const commit_value_usage = (metrics: RuntimeValueMetrics): void => {
		usage.value_nodes += metrics.nodes;
		usage.string_units += metrics.string_units;
	};
	const record_value = (value: BoxValue): BoxValue => {
		const metrics = value_metrics(value);
		assert_value_capacity(metrics);
		commit_value_usage(metrics);
		return value;
	};
	const record_output = (value: BoxValue): BoxValue => {
		const metrics = { nodes: 0, string_units: value_metrics(value).string_units };
		assert_value_capacity(metrics);
		commit_value_usage(metrics);
		return value;
	};
	const assert_input_value_budget = (value: unknown): void => {
		const remaining_nodes = request.budget.max_value_nodes - usage.value_nodes;
		const remaining_string_units = request.budget.max_string_units - usage.string_units;
		let nodes = 0;
		let string_units = 0;
		const pending: unknown[] = [value];
		while (pending.length > 0) {
			const current = pending.pop();
			if (nodes >= remaining_nodes) throw new RuntimeFailureError("budget_exceeded", "Runtime value budget was exceeded");
			nodes += 1;
			if (typeof current === "string") {
				if (current.length > remaining_string_units - string_units)
					throw new RuntimeFailureError("budget_exceeded", "Runtime value budget was exceeded");
				string_units += current.length;
			}
			if (Array.isArray(current)) {
				if (nodes + pending.length + current.length > remaining_nodes) {
					throw new RuntimeFailureError("budget_exceeded", "Runtime value budget was exceeded");
				}
				for (let index = current.length - 1; index >= 0; index -= 1) pending.push(current[index]);
				continue;
			}
			if (typeof current !== "object" || current === null) continue;
			const keys = Object.keys(current);
			if (nodes + pending.length + keys.length > remaining_nodes) {
				throw new RuntimeFailureError("budget_exceeded", "Runtime value budget was exceeded");
			}
			for (let index = keys.length - 1; index >= 0; index -= 1) pending.push((current as Record<string, unknown>)[keys[index]!]);
		}
	};
	const normalized_value = (document: ExecutableDocument, type_id: string, value: unknown, code: string, message: string): BoxValue => {
		try {
			return normalize_box_value_at(document.schema === "process.document.v1" ? process_document_box_schema(document) : document, type_id, value);
		} catch {
			throw new RuntimeFailureError(code, message);
		}
	};
	const create_frame = (box: RuntimeBox, depth: number, parent_frame_id: number | null): RuntimeFrame => {
		const root = box.document.nodes.find((item) => item.id === box.document.root_id);
		if (!root || root.kind !== "record") throw new RuntimeFailureError("invalid_source", "Executable Box frame is invalid");
		return {
			frame_id: next_frame_id++,
			parent_frame_id,
			box,
			document: box.document,
			root,
			cells: new Map(root.fields.map((field) => [field.id, { type_id: field.type_id, value: UNSET }])),
			cell_types: new Map(root.fields.map((field) => [field.id, field.type_id])),
			bindings: new Map(),
			depth,
			inspection: inspection_recorder?.frame(box.id, depth, parent_frame_id) ?? null,
			statement_id: null,
		};
	};

	const parsed_publication_id = canonical_uuid.safeParse(publication_id);
	if (!parsed_publication_id.success || parsed_publication_id.data !== publication_id || publication_id !== publication_id.toLowerCase()) {
		return fault("invalid_publication", "Publication identity is not canonical");
	}
	if (process_request) {
		const parsed_process_id = canonical_uuid.safeParse(process_request.process_id);
		if (
			!parsed_process_id.success ||
			parsed_process_id.data !== process_request.process_id ||
			process_request.process_id !== process_request.process_id.toLowerCase()
		) {
			return fault("invalid_process", "Process identity is not canonical");
		}
		const parsed_invocation_id = canonical_uuid.safeParse(process_request.invocation_id);
		if (
			!parsed_invocation_id.success ||
			parsed_invocation_id.data !== process_request.invocation_id ||
			process_request.invocation_id !== process_request.invocation_id.toLowerCase()
		) {
			return fault("invalid_invocation", "Process invocation identity is not canonical");
		}
		if (!valid_process_budget(process_request.budget) || process_request.effect_receipts.length > process_request.budget.max_effects) {
			return fault("invalid_budget", "Process runtime budget is invalid");
		}
	} else if (!valid_budget(request.budget)) {
		return fault("invalid_budget", "Runtime budget is invalid");
	}
	if (!is_canonical_project_source_snapshot(request.publication.snapshot)) {
		return fault("invalid_publication", "Published Project source snapshot is not canonical");
	}

	const snapshot = request.publication.snapshot;
	project_id = snapshot.project_id;
	source_revision = snapshot.revision;
	const entry_id = process_request ? process_request.process_id : box_request!.entry_box_id;
	const entry_box = snapshot.boxes.find((item) => item.id === entry_id);
	if (!entry_box)
		return fault(
			process_request ? "process_missing" : "entry_box_missing",
			process_request ? "Published Process is missing" : "Runtime entry Box is missing",
		);
	if (process_request ? entry_box.document.schema !== "process.document.v1" : entry_box.document.schema !== "box.document.v2") {
		return fault(
			process_request ? "entry_not_process" : "entry_box_not_executable",
			process_request ? "Published entry is not a Process" : "Runtime entry Box is not executable",
		);
	}
	if (process_request && entry_box.document.schema === "process.document.v1" && entry_box.document.effects.length > 0) {
		inspection_recorder?.redact_values();
	}
	const entry_frame = create_frame(entry_box as RuntimeBox, 0, null);

	const evaluate = (expression: BoxProgramExpression): BoxValue => {
		const frame = current_frame;
		if (!frame) throw new RuntimeFailureError("runtime_fault", "Runtime frame is unavailable");
		try {
			const value = evaluate_value(expression);
			record_inspection(frame, {
				kind: "expression",
				statement_id: frame.statement_id,
				expression_id: expression.id,
				cell_id: null,
				value: inspection_value(value),
				outcome: null,
			});
			return value;
		} catch (error) {
			record_failure(error, frame, expression.id);
			throw error;
		}
	};

	const evaluate_value = (expression: BoxProgramExpression): BoxValue => {
		const frame = current_frame;
		if (!frame) throw new RuntimeFailureError("runtime_fault", "Runtime frame is unavailable");
		const { bindings, cells, document } = frame;
		consume_step();
		if (expression.kind === "literal") {
			return record_value(
				normalized_value(document, expression.type_id, expression.value, "invalid_source", "Runtime literal does not match its declared type"),
			);
		}
		if (expression.kind === "cell") {
			const cell = cells.get(expression.cell_id);
			const cell_type = frame.cell_types.get(expression.cell_id);
			if (!cell || !cell_type || !same_type(document, cell_type, expression.type_id)) {
				throw new RuntimeFailureError("invalid_source", "Runtime cell expression type is inconsistent");
			}
			if (cell.value === UNSET) throw new RuntimeFailureError("uninitialized_cell", "Runtime cell is uninitialized");
			return record_value(cell.value);
		}
		if (expression.kind === "binding") {
			const binding = bindings.get(expression.binding_id);
			if (!binding || !same_type(document, binding.type_id, expression.type_id)) {
				throw new RuntimeFailureError("invalid_source", "Runtime binding is unavailable or mistyped");
			}
			return record_value(binding.value);
		}
		if (expression.kind === "select") {
			if (!scalar_type(document, expression.condition.type_id, "boolean")) {
				throw new RuntimeFailureError("invalid_source", "Runtime select condition is not boolean");
			}
			if (
				!same_type(document, expression.type_id, expression.when_true.type_id) ||
				!same_type(document, expression.type_id, expression.when_false.type_id)
			) {
				throw new RuntimeFailureError("invalid_source", "Runtime select branches have inconsistent types");
			}
			const condition = evaluate(expression.condition);
			if (typeof condition !== "boolean") throw new RuntimeFailureError("invalid_source", "Runtime select condition is invalid");
			return condition ? evaluate(expression.when_true) : evaluate(expression.when_false);
		}
		if (expression.kind === "binary") {
			const result_is_boolean = scalar_type(document, expression.type_id, "boolean");
			if (expression.operator === "and" || expression.operator === "or") {
				if (
					!result_is_boolean ||
					!scalar_type(document, expression.left.type_id, "boolean") ||
					!scalar_type(document, expression.right.type_id, "boolean")
				) {
					throw new RuntimeFailureError("invalid_source", "Runtime boolean expression has inconsistent types");
				}
				const left = evaluate(expression.left);
				if (typeof left !== "boolean") throw new RuntimeFailureError("invalid_source", "Runtime boolean operand is invalid");
				if (expression.operator === "and" && !left) return record_value(false);
				if (expression.operator === "or" && left) return record_value(true);
				const right = evaluate(expression.right);
				if (typeof right !== "boolean") throw new RuntimeFailureError("invalid_source", "Runtime boolean operand is invalid");
				return record_value(right);
			}
			const left = evaluate(expression.left);
			const right = evaluate(expression.right);
			if (expression.operator === "equal" || expression.operator === "not_equal") {
				if (!result_is_boolean || !same_type(document, expression.left.type_id, expression.right.type_id)) {
					throw new RuntimeFailureError("invalid_source", "Runtime equality expression has inconsistent types");
				}
				const equal = (typeof left === "string" || typeof left === "number" || typeof left === "boolean") && typeof right === typeof left
					? compare_scalar("equal", left, right) : json_values_equal(left, right);
				return record_value(expression.operator === "equal" ? equal : !equal);
			}
			if (expression.operator === "concat") {
				if (
					!scalar_type(document, expression.type_id, "string") ||
					!scalar_type(document, expression.left.type_id, "string") ||
					!scalar_type(document, expression.right.type_id, "string")
				) {
					throw new RuntimeFailureError("invalid_source", "Runtime concat expression has inconsistent types");
				}
				if (typeof left !== "string" || typeof right !== "string")
					throw new RuntimeFailureError("invalid_source", "Runtime concat operand is invalid");
				const result_metrics = { nodes: 1, string_units: left.length + right.length };
				assert_value_capacity(result_metrics);
				const result = left + right;
				commit_value_usage(result_metrics);
				return result;
			}
			if (["less_than", "less_or_equal", "greater_than", "greater_or_equal"].includes(expression.operator)) {
				const comparable =
					(scalar_type(document, expression.left.type_id, "number") && scalar_type(document, expression.right.type_id, "number")) ||
					(scalar_type(document, expression.left.type_id, "string") && scalar_type(document, expression.right.type_id, "string"));
				if (!result_is_boolean || !comparable) {
					throw new RuntimeFailureError("invalid_source", "Runtime comparison expression has inconsistent types");
				}
				if (!((typeof left === "number" && typeof right === "number") || (typeof left === "string" && typeof right === "string"))) {
					throw new RuntimeFailureError("invalid_source", "Runtime comparison operands are invalid");
				}
				const result = compare_scalar(expression.operator as "less_than" | "less_or_equal" | "greater_than" | "greater_or_equal", left, right);
				return record_value(result);
			}
			if (
				!scalar_type(document, expression.type_id, "number") ||
				!scalar_type(document, expression.left.type_id, "number") ||
				!scalar_type(document, expression.right.type_id, "number") ||
				typeof left !== "number" ||
				typeof right !== "number"
			) {
				throw new RuntimeFailureError("invalid_source", "Runtime arithmetic expression has inconsistent types");
			}
			if (expression.operator === "divide" && right === 0) throw new RuntimeFailureError("invalid_number", "Runtime division by zero is undefined");
			const arithmetic =
				expression.operator === "add"
					? left + right
					: expression.operator === "subtract"
						? left - right
						: expression.operator === "multiply"
							? left * right
							: left / right;
			if (!Number.isFinite(arithmetic)) throw new RuntimeFailureError("invalid_number", "Runtime arithmetic produced a non-finite number");
			return record_value(Object.is(arithmetic, -0) ? 0 : arithmetic);
		}
		if (expression.kind === "record") {
			const node = resolved_type(document, expression.type_id);
			if (node.kind !== "record") throw new RuntimeFailureError("invalid_source", "Runtime record expression type is not a record");
			const supplied = new Map(expression.fields.map((field) => [field.field_id, field.value]));
			const entries: [string, BoxValue][] = [];
			for (const field of node.fields) {
				const field_expression = supplied.get(field.id);
				if (!field_expression) {
					if (field.required) throw new RuntimeFailureError("invalid_source", "Runtime record expression is missing a required field");
					continue;
				}
				if (!same_type(document, field.type_id, field_expression.type_id)) {
					throw new RuntimeFailureError("invalid_source", "Runtime record field type is inconsistent");
				}
				entries.push([field.name, evaluate(field_expression)]);
				supplied.delete(field.id);
			}
			if (supplied.size > 0) throw new RuntimeFailureError("invalid_source", "Runtime record expression contains an unknown field");
			return record_value(Object.freeze(Object.fromEntries(entries) as Record<string, BoxValue>));
		}
		if (expression.kind === "field") {
			const node = resolved_type(document, expression.record.type_id);
			if (node.kind !== "record") throw new RuntimeFailureError("invalid_source", "Runtime field source is not a record");
			const field = node.fields.find((candidate) => candidate.id === expression.field_id);
			if (!field || !same_type(document, field.type_id, expression.type_id)) {
				throw new RuntimeFailureError("invalid_source", "Runtime field expression type is inconsistent");
			}
			const record = evaluate(expression.record);
			if (typeof record !== "object" || record === null || Array.isArray(record) || !Object.hasOwn(record, field.name)) {
				throw new RuntimeFailureError("uninitialized_cell", "Runtime record field is absent");
			}
			return record_value((record as Record<string, BoxValue>)[field.name]!);
		}
		const list = evaluate(expression.list);
		const input_list_type = resolved_type(document, expression.list.type_id);
		if (!Array.isArray(list) || input_list_type.kind !== "list")
			throw new RuntimeFailureError("invalid_source", "Runtime list expression source is not a list");
		const values = list as readonly BoxValue[];
		if (expression.kind === "list.length") {
			if (!scalar_type(document, expression.type_id, "number"))
				throw new RuntimeFailureError("invalid_source", "Runtime list length type is not number");
			return record_value(values.length);
		}
		if (expression.kind === "list.map") {
			const output_type = resolved_type(document, expression.type_id);
			if (output_type.kind !== "list" || !same_type(document, output_type.item_type_id, expression.value.type_id)) {
				throw new RuntimeFailureError("invalid_source", "Runtime list map result type is inconsistent");
			}
			const mapped: BoxValue[] = [];
			for (const item of values) {
				consume_step();
				bindings.set(expression.item_binding_id, { type_id: input_list_type.item_type_id, value: item });
				mapped.push(evaluate(expression.value));
			}
			bindings.delete(expression.item_binding_id);
			return record_value(Object.freeze(mapped));
		}
		if (expression.kind === "list.fold") {
			if (
				!same_type(document, expression.type_id, expression.initial.type_id) ||
				!same_type(document, expression.type_id, expression.value.type_id)
			) {
				throw new RuntimeFailureError("invalid_source", "Runtime list fold result type is inconsistent");
			}
			let accumulator = evaluate(expression.initial);
			for (const item of values) {
				consume_step();
				bindings.set(expression.item_binding_id, { type_id: input_list_type.item_type_id, value: item });
				bindings.set(expression.accumulator_binding_id, { type_id: expression.type_id, value: accumulator });
				accumulator = evaluate(expression.value);
			}
			bindings.delete(expression.item_binding_id);
			bindings.delete(expression.accumulator_binding_id);
			return record_value(accumulator);
		}
		if (!scalar_type(document, expression.type_id, "boolean") || !scalar_type(document, expression.predicate.type_id, "boolean")) {
			throw new RuntimeFailureError("invalid_source", "Runtime list every predicate type is inconsistent");
		}
		for (const item of values) {
			consume_step();
			bindings.set(expression.item_binding_id, { type_id: input_list_type.item_type_id, value: item });
			const predicate = evaluate(expression.predicate);
			if (typeof predicate !== "boolean") throw new RuntimeFailureError("invalid_source", "Runtime list every predicate is invalid");
			if (!predicate) {
				bindings.delete(expression.item_binding_id);
				return record_value(false);
			}
		}
		bindings.delete(expression.item_binding_id);
		return record_value(true);
	};

	const require_initialized_cells = (frame: RuntimeFrame, code: string, message: string): void => {
		for (const field of frame.root.fields) {
			if (field.required && frame.cells.get(field.id)?.value === UNSET) throw new RuntimeFailureError(code, message);
		}
	};

	const run_effect = function* run_effect(
		frame: RuntimeFrame,
		statement: ProcessEffectStatement,
	): Generator<RuntimeBoundary, void, ProcessEffectReceipt | undefined> {
		if (!process_request || frame.depth !== 0 || frame.document.schema !== "process.document.v1") {
			throw new RuntimeFailureError("invalid_source", "Effects are available only in the Process entry frame");
		}
		if (consumed_effects >= process_request.budget.max_effects) {
			throw new RuntimeFailureError("budget_exceeded", "Process effect budget was exceeded");
		}
		const declaration: ProcessEffectDeclaration | undefined = frame.document.effects.find((item) => item.id === statement.effect_id);
		if (!declaration) throw new RuntimeFailureError("invalid_source", "Process effect declaration is missing");
		const request_cell = frame.cells.get(declaration.request_cell_id);
		if (!request_cell || request_cell.value === UNSET)
			throw new RuntimeFailureError("uninitialized_cell", "Process effect request cell is uninitialized");
		const effect_request = record_output(
			normalized_value(frame.document, declaration.request_type_id, request_cell.value, "invalid_source", "Process effect request value is invalid"),
		);
		let receipt: ProcessEffectReceipt | undefined = process_request.effect_receipts[consumed_effects];
		if (sandbox) {
			receipt = yield {
				kind: "effect",
				frames,
				usage: process_usage(),
				effect: {
					index: consumed_effects,
					statement_id: statement.id,
					effect_id: declaration.id,
					capability: declaration.capability,
					request: effect_request,
					result_type_id: declaration.result_type_id,
				},
			};
		}
		if (!receipt) {
			const effect = {
				index: consumed_effects,
				statement_id: statement.id,
				effect_id: declaration.id,
				capability: declaration.capability,
				request: effect_request,
			};
			append_trace({ kind: "effect.intent", box_id: frame.box.id, statement_id: statement.id, effect_id: declaration.id, index: consumed_effects });
			record_inspection(frame, {
				kind: "effect",
				statement_id: statement.id,
				expression_id: null,
				cell_id: null,
				value: inspection_value(effect_request),
				outcome: "effect",
			});
			throw new RuntimeEffectIntentError(effect);
		}
		if (receipt.statement_id !== statement.id || receipt.effect_id !== declaration.id || receipt.capability !== declaration.capability) {
			throw new RuntimeFailureError("invalid_effect_receipt", "Process effect receipt does not match the requested effect");
		}
		assert_input_value_budget(receipt.request);
		const receipt_request = normalized_value(
			frame.document,
			declaration.request_type_id,
			receipt.request,
			"invalid_effect_receipt",
			"Process effect receipt request is invalid",
		);
		if (!json_values_equal(effect_request, receipt_request)) {
			throw new RuntimeFailureError("invalid_effect_receipt", "Process effect receipt request does not match the deterministic request");
		}
		assert_input_value_budget(receipt.result);
		const result = effect_receipt_result(frame.document, declaration.result_type_id, receipt.result);
		const result_cell = frame.cells.get(declaration.result_cell_id);
		if (!result_cell) throw new RuntimeFailureError("invalid_source", "Process effect result cell is missing");
		result_cell.value = record_value(result);
		append_trace({ kind: "effect.replay", box_id: frame.box.id, statement_id: statement.id, effect_id: declaration.id, index: consumed_effects });
		record_inspection(frame, {
			kind: "effect",
			statement_id: statement.id,
			expression_id: null,
			cell_id: null,
			value: inspection_value(result),
			outcome: "effect",
		});
		append_trace({ kind: "cell.write", box_id: frame.box.id, statement_id: statement.id, cell_id: declaration.result_cell_id });
		record_inspection(frame, {
			kind: "cell.write",
			statement_id: statement.id,
			expression_id: null,
			cell_id: declaration.result_cell_id,
			value: inspection_value(result_cell.value),
			outcome: null,
		});
		consumed_effects += 1;
	};

	const run_frame = function* run_frame(frame: RuntimeFrame): Generator<RuntimeBoundary, void, ProcessEffectReceipt | undefined> {
		if (frame.depth >= request.budget.max_call_depth) throw new RuntimeFailureError("budget_exceeded", "Runtime call depth budget was exceeded");
		if (active_box_ids.has(frame.box.id)) throw new RuntimeFailureError("recursive_call", "Recursive Box calls are not allowed");
		const previous_frame = current_frame;
		current_frame = frame;
		frames.push(frame);
		active_box_ids.add(frame.box.id);
		usage.calls += 1;
		append_trace({ kind: "box.enter", box_id: frame.box.id, depth: frame.depth });
		record_inspection(frame, {
			kind: "frame.enter",
			statement_id: null,
			expression_id: null,
			cell_id: null,
			value: null,
			outcome: null,
		});
		for (const field of frame.root.fields) {
			const cell = frame.cells.get(field.id);
			record_inspection(frame, {
				kind: "cell.input",
				statement_id: null,
				expression_id: null,
				cell_id: field.id,
				value: inspection_value(cell ? cell.value : UNSET),
				outcome: null,
			});
		}
		try {
			require_initialized_cells(
				frame,
				frame.depth === 0 ? "invalid_input" : "invalid_call",
				frame.depth === 0 ? "Runtime input is missing a required cell" : "Runtime Box call is missing a required cell",
			);
			for (const statement of frame.document.program.body) {
				frame.statement_id = statement.id;
				yield { kind: "statement", frames, usage: process_usage() };
				consume_step();
				append_trace({ kind: "statement", box_id: frame.box.id, statement_id: statement.id, statement_kind: statement.kind });
				record_inspection(frame, {
					kind: "statement",
					statement_id: statement.id,
					expression_id: null,
					cell_id: null,
					value: null,
					outcome: null,
				});
				if (statement.kind === "effect") {
					yield* run_effect(frame, statement);
					continue;
				}
				if (statement.kind === "write") {
					const cell = frame.cells.get(statement.cell_id);
					const cell_type = frame.cell_types.get(statement.cell_id);
					if (!cell || !cell_type || !same_type(frame.document, cell_type, statement.value.type_id)) {
						throw new RuntimeFailureError("invalid_source", "Runtime write type is inconsistent");
					}
					cell.value = evaluate(statement.value);
					append_trace({ kind: "cell.write", box_id: frame.box.id, statement_id: statement.id, cell_id: statement.cell_id });
					record_inspection(frame, {
						kind: "cell.write",
						statement_id: statement.id,
						expression_id: null,
						cell_id: statement.cell_id,
						value: inspection_value(cell.value),
						outcome: null,
					});
					continue;
				}
				if (statement.kind === "reject_if") {
					if (!scalar_type(frame.document, statement.condition.type_id, "boolean")) {
						throw new RuntimeFailureError("invalid_source", "Runtime rejection condition is not boolean");
					}
					const condition = evaluate(statement.condition);
					if (typeof condition !== "boolean") throw new RuntimeFailureError("invalid_source", "Runtime rejection condition is invalid");
					if (condition) {
						const details = statement.details ? evaluate(statement.details) : null;
						throw new RuntimeExpectedRejectionError(statement.code, details);
					}
					continue;
				}

				const target_box = snapshot.boxes.find((candidate) => candidate.id === statement.box_id);
				if (!target_box || target_box.document.schema !== "box.document.v2") {
					throw new RuntimeFailureError("invalid_call", "Runtime Box call target is missing or not executable");
				}
				if (target_box.realm_id !== frame.box.realm_id)
					throw new RuntimeFailureError("invalid_call", "Runtime Box calls cannot cross Realm boundaries");
				if (frame.depth + 1 >= request.budget.max_call_depth) {
					throw new RuntimeFailureError("budget_exceeded", "Runtime call depth budget was exceeded");
				}
				if (active_box_ids.has(target_box.id)) throw new RuntimeFailureError("recursive_call", "Recursive Box calls are not allowed");
				const target_frame = create_frame(target_box as RuntimeBox, frame.depth + 1, frame.frame_id);
				for (const init of statement.init) {
					const target_cell = target_frame.cells.get(init.callee_cell_id);
					const target_type = target_frame.cell_types.get(init.callee_cell_id);
					if (!target_cell || !target_type) throw new RuntimeFailureError("invalid_source", "Runtime Box call initializes an unknown cell");
					if (init.kind === "value") {
						if (!same_type_between(frame.document, init.value.type_id, target_frame.document, target_type)) {
							throw new RuntimeFailureError("invalid_source", "Runtime Box call value type is inconsistent");
						}
						target_cell.value = normalized_value(
							target_frame.document,
							target_type,
							evaluate(init.value),
							"invalid_call",
							"Runtime Box call value is invalid",
						);
						continue;
					}
					const caller_cell = frame.cells.get(init.caller_cell_id);
					const caller_type = frame.cell_types.get(init.caller_cell_id);
					if (!caller_cell || !caller_type || !same_type_between(frame.document, caller_type, target_frame.document, target_type)) {
						throw new RuntimeFailureError("invalid_source", "Runtime Box call cell type is inconsistent");
					}
					if (init.kind === "share") {
						target_frame.cells.set(init.callee_cell_id, caller_cell);
						continue;
					}
					if (caller_cell.value === UNSET) throw new RuntimeFailureError("uninitialized_cell", "Runtime copied cell is uninitialized");
					target_cell.value = normalized_value(
						target_frame.document,
						target_type,
						caller_cell.value,
						"invalid_call",
						"Runtime copied cell value is invalid",
					);
				}
				append_trace({ kind: "box.call", box_id: frame.box.id, statement_id: statement.id, target_box_id: target_frame.box.id, depth: frame.depth });
				yield* run_frame(target_frame);
			}
			frame.statement_id = null;
			append_trace({ kind: "box.exit", box_id: frame.box.id, depth: frame.depth, outcome: "success" });
			record_inspection(frame, {
				kind: "frame.exit",
				statement_id: null,
				expression_id: null,
				cell_id: null,
				value: null,
				outcome: "success",
			});
		} catch (error) {
			if (!(error instanceof RuntimeEffectIntentError)) on_failure?.(frames);
			record_failure(error, frame, null);
			const outcome = error instanceof RuntimeExpectedRejectionError ? "rejected" : error instanceof RuntimeEffectIntentError ? "effect" : "fault";
			append_trace({
				kind: "box.exit",
				box_id: frame.box.id,
				depth: frame.depth,
				outcome,
			});
			record_inspection(frame, {
				kind: "frame.exit",
				statement_id: null,
				expression_id: null,
				cell_id: null,
				value: null,
				outcome,
			});
			throw error;
		} finally {
			active_box_ids.delete(frame.box.id);
			current_frame = previous_frame;
			frames.pop();
		}
	};

	try {
		const process_document = process_request ? (entry_frame.document as ProcessDocument) : null;
		const projected_inputs = process_document ? new Set(process_document.input_cell_ids) : null;
		const output_cell_ids = process_document ? process_document.output_cell_ids : box_request!.output_cell_ids;
		const seen_input = new Set<string>();
		for (const entry of request.input) {
			if (seen_input.has(entry.cell_id)) throw new RuntimeFailureError("invalid_input", "Runtime input contains a duplicate cell");
			seen_input.add(entry.cell_id);
			if (projected_inputs && !projected_inputs.has(entry.cell_id))
				throw new RuntimeFailureError("invalid_input", "Process input cell is not externally projected");
			const cell = entry_frame.cells.get(entry.cell_id);
			const cell_type = entry_frame.cell_types.get(entry.cell_id);
			if (!cell || !cell_type) throw new RuntimeFailureError("invalid_input", "Runtime input cell is missing");
			assert_input_value_budget(entry.value);
			cell.value = record_value(
				normalized_value(entry_frame.document, cell_type, entry.value, "invalid_input", "Runtime input value does not match its cell type"),
			);
		}

		const seen_output = new Set<string>();
		for (const cell_id of output_cell_ids) {
			if (seen_output.has(cell_id)) throw new RuntimeFailureError("invalid_output", "Runtime output contains a duplicate cell");
			seen_output.add(cell_id);
			if (!entry_frame.cells.has(cell_id)) throw new RuntimeFailureError("invalid_output", "Runtime output cell is missing");
		}

		yield* run_frame(entry_frame);
		if (process_request && !sandbox && consumed_effects !== process_request.effect_receipts.length) {
			throw new RuntimeFailureError("invalid_effect_receipt", "Process invocation contains an unused effect receipt");
		}
		const outputs: { cell_id: string; value: BoxValue }[] = [];
		for (const cell_id of output_cell_ids) {
			const cell = entry_frame.cells.get(cell_id)!;
			if (cell.value === UNSET) {
				const error = new RuntimeFailureError("uninitialized_cell", "Runtime output cell is uninitialized");
				record_failure(error, entry_frame, null, cell_id);
				throw error;
			}
			try {
				outputs.push({ cell_id, value: record_output(cell.value) });
			} catch (error) {
				record_failure(error, entry_frame, null, cell_id);
				throw error;
			}
		}
		outputs.sort((left, right) => (left.cell_id < right.cell_id ? -1 : left.cell_id > right.cell_id ? 1 : 0));
		if (process_request) {
			return {
				status: "success",
				publication_id,
				process_id: process_request.process_id,
				invocation_id: process_request.invocation_id,
				project_id,
				source_revision,
				outputs,
				usage: process_usage(),
				trace,
				...inspection_fields(),
			};
		}
		return {
			status: "success",
			publication_id,
			project_id,
			source_revision,
			outputs,
			usage,
			trace,
			...inspection_fields(),
		};
	} catch (error) {
		if (error instanceof RuntimeEffectIntentError) return effect_intent(error);
		// Output accounting can fail after the completed root has left the live stack.
		on_failure?.([entry_frame]);
		if (error instanceof RuntimeExpectedRejectionError) {
			if (process_request && !sandbox && consumed_effects !== process_request.effect_receipts.length) {
				return fault("invalid_effect_receipt", "Process invocation contains an unused effect receipt");
			}
			return rejected(error);
		}
		if (error instanceof RuntimeFailureError) return fault(error.code, error.message);
		return fault("runtime_fault", "Runtime execution failed");
	}
};

const drain_runtime = (continuation: RuntimeContinuation): RuntimeExecutionOutcome | ProcessExecutionOutcome => {
	let next = continuation.next();
	while (!next.done) next = continuation.next();
	return next.value;
};

export const execute_project_runtime = (request: RuntimeExecutionRequest): RuntimeExecutionOutcome =>
	drain_runtime(execute_runtime(request, "box")) as RuntimeExecutionOutcome;

export const execute_process_runtime = (request: ProcessExecutionRequest): ProcessExecutionOutcome =>
	drain_runtime(execute_runtime(request, "process")) as ProcessExecutionOutcome;

const sandbox_frames = (frames: readonly RuntimeFrame[]): readonly SandboxFrame[] =>
	Object.freeze(
		frames.map(
			(frame): SandboxFrame =>
				Object.freeze({
					frame_id: frame.frame_id,
					parent_frame_id: frame.parent_frame_id,
					box_id: frame.box.id,
					depth: frame.depth,
					statement_id: frame.statement_id,
					cells: Object.freeze(
						[...frame.cells].map(([cell_id, cell]) =>
							Object.freeze({
								cell_id,
								type_id: frame.cell_types.get(cell_id)!,
								...(cell.value === UNSET ? { status: "unset" as const } : { status: "value" as const, value: cell.value }),
							}),
						),
					),
				}),
		),
	);

const empty_sandbox_view = (): SandboxView =>
	Object.freeze({
		session_id: null,
		publication: null,
		status: "stopped",
		reason: null,
		frames: Object.freeze([]),
		effect: null,
		outcome: null,
		breakpoints: Object.freeze([]),
		usage: Object.freeze({ steps: 0, calls: 0, value_nodes: 0, string_units: 0, effects: 0 }),
	});

/** Live statement continuation. No adapter, transaction, transport or production receipt is owned here. */
export class RuntimeSandbox {
	private request: SandboxExecutionRequest | null;
	private continuation: RuntimeContinuation | null = null;
	private boundary: RuntimeBoundary | null = null;
	private failure_frames: readonly SandboxFrame[] = Object.freeze([]);
	private current: SandboxView = empty_sandbox_view();
	private plan: { control: SandboxControl; depth: number } | null = null;

	constructor(request: SandboxExecutionRequest) {
		this.request = sandbox_snapshot(request);
		this.restart();
	}

	get view(): SandboxView {
		return this.current;
	}

	restart(): void {
		if (!this.request) return;
		this.close_continuation();
		const session_id = crypto.randomUUID();
		this.current = Object.freeze({ ...empty_sandbox_view(), publication: this.request.publication, session_id });
		this.continuation = execute_runtime({ ...this.request, invocation_id: session_id, effect_receipts: [] }, "process", true, (frames) => {
			// Capture the deepest failure once, before generator finally blocks unwind shared cells.
			if (this.failure_frames.length === 0) this.failure_frames = sandbox_frames(frames);
		});
		this.accept(this.continuation.next(), "entry");
	}

	private close_continuation(): void {
		// Returning unwinds generator finally blocks, releasing live cells and stack references.
		this.continuation?.return(undefined as never);
		this.continuation = null;
		this.boundary = null;
		this.failure_frames = Object.freeze([]);
		this.plan = null;
	}

	stop(): void {
		this.close_continuation();
		this.request = null;
		this.current = empty_sandbox_view();
	}

	set_breakpoints(breakpoints: readonly SandboxBreakpoint[]): boolean {
		if (!this.request || breakpoints.length > 512) return false;
		const source = this.request.publication.snapshot;
		if (
			breakpoints.some((point) => {
				const document = source.boxes.find((box) => box.id === point.box_id)?.document;
				return !document || document.schema === "box.document.v1" || !document.program.body.some((statement) => statement.id === point.statement_id);
			})
		)
			return false;
		const unique = new Map(
			breakpoints.map((point) => [`${point.box_id}:${point.statement_id}`, { box_id: point.box_id, statement_id: point.statement_id }]),
		);
		this.current = Object.freeze({ ...this.current, breakpoints: sandbox_snapshot([...unique.values()]) });
		return true;
	}

	resume(control: SandboxControl): void {
		if (this.current.status !== "paused" || !this.boundary) return;
		this.plan = { control, depth: this.boundary.frames.at(-1)!.depth };
		this.current = Object.freeze({ ...this.current, status: "running", reason: null });
		this.drive();
	}

	/** At most 64 statement boundaries per batch. Hosts must yield to their event loop between batches. */
	drive(): void {
		if (this.current.status !== "running" || !this.plan || !this.continuation) return;
		for (let count = 0; count < 64; count += 1) {
			const next = this.continuation.next();
			if (next.done || next.value.kind === "effect") {
				this.accept(next, "step");
				return;
			}
			const frame = next.value.frames.at(-1)!;
			const breakpoint = this.current.breakpoints.some((point) => point.box_id === frame.box.id && point.statement_id === frame.statement_id);
			const pause =
				breakpoint ||
				this.plan.control === "into" ||
				(this.plan.control === "over" && frame.depth <= this.plan.depth) ||
				(this.plan.control === "out" && frame.depth < this.plan.depth);
			if (pause || count === 63) this.accept(next, breakpoint ? "breakpoint" : "step", !pause);
			if (pause) return;
		}
	}

	/** Invalid typed mocks leave both the continuation and its public view unchanged. */
	submit_mock(value: unknown): boolean {
		if (this.current.status !== "effect" || !this.boundary?.effect || !this.continuation) return false;
		const effect = this.boundary.effect;
		const frame = this.boundary.frames.at(-1)!;
		if (frame.document.schema !== "process.document.v1") return false;
		let result: BoxValue;
		try {
			result = effect_receipt_result(frame.document, effect.result_type_id, sandbox_snapshot(value));
		} catch {
			return false;
		}
		this.plan = null;
		this.accept(
			this.continuation.next({
				statement_id: effect.statement_id,
				effect_id: effect.effect_id,
				capability: effect.capability,
				request: effect.request,
				result,
			}),
			"step",
		);
		return true;
	}

	private accept(
		next: IteratorResult<RuntimeBoundary, RuntimeExecutionOutcome | ProcessExecutionOutcome>,
		reason: "entry" | "step" | "breakpoint",
		running = false,
	): void {
		if (next.done) {
			const outcome = next.value as ProcessSuccess | ProcessRejected | ProcessFault;
			this.boundary = null;
			this.continuation = null;
			this.plan = null;
			this.current = Object.freeze({
				...this.current,
				status: outcome.status,
				reason: null,
				frames: outcome.status === "success" ? Object.freeze([]) : this.failure_frames,
				effect: null,
				usage: Object.freeze({ ...outcome.usage }),
				outcome: freeze_sandbox_state(outcome),
			});
			return;
		}
		const boundary = next.value;
		this.boundary = boundary;
		this.current = Object.freeze({
			...this.current,
			status: boundary.kind === "effect" ? "effect" : running ? "running" : "paused",
			reason: boundary.kind === "effect" ? "effect" : running ? null : reason,
			usage: Object.freeze({ ...boundary.usage }),
			effect: boundary.effect ? Object.freeze({ ...boundary.effect }) : null,
			frames: sandbox_frames(boundary.frames),
		});
	}
}
