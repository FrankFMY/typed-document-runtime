import { expect, test } from "bun:test";
import type { ProcessDocument } from "./process-document.js";
import { normalize_project_source_snapshot } from "./project-source-snapshot.js";
import type { ProcessEffectReceipt, SandboxExecutionRequest } from "./runtime.js";
import { execute_process_runtime, RuntimeSandbox } from "./runtime.js";

const id = (n: number): string => `95000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const process_id = id(3),
	number_id = id(10),
	cell_id = id(12);
const document: ProcessDocument = {
	schema: "process.document.v1",
	root_id: id(11),
	nodes: [
		{ id: number_id, kind: "scalar", value_type: "number" },
		{ id: id(11), kind: "record", fields: [{ id: cell_id, name: "Count", type_id: number_id, required: true }] },
	],
	input_cell_ids: [cell_id],
	output_cell_ids: [cell_id],
	effects: [],
	program: {
		schema: "process.program.v1",
		body: [1, 2].map((n) => ({
			id: id(100 + n),
			kind: "write",
			cell_id,
			value: { id: id(200 + n), kind: "literal", type_id: number_id, value: n * 7 },
		})),
	},
};
const request = (): SandboxExecutionRequest => ({
	publication: {
		id: id(4),
		snapshot: normalize_project_source_snapshot({
			schema: "project.source.snapshot.v1",
			project_id: id(1),
			revision: "1",
			realms: [{ id: id(2), name: "Main", is_primary: true }],
			boxes: [{ id: process_id, realm_id: id(2), parent_id: null, name: "Count", document_version: "1", document }],
		}),
	},
	process_id,
	input: [{ cell_id, value: 3 }],
	budget: { max_steps: 100, max_call_depth: 8, max_value_nodes: 1000, max_string_units: 10000, max_effects: 4 },
});

test("sandbox pauses before the first write and resumes real memory one statement at a time", () => {
	const sandbox = new RuntimeSandbox(request());
	expect(sandbox.view.status).toBe("paused");
	expect(sandbox.view.frames[0]?.cells[0]).toMatchObject({ cell_id, value: 3 });
	sandbox.resume("into");
	expect(sandbox.view.status).toBe("paused");
	expect(sandbox.view.frames[0]?.cells[0]).toMatchObject({ cell_id, value: 7 });
	sandbox.resume("into");
	expect(sandbox.view.status).toBe("success");
});

const current_cell = (sandbox: RuntimeSandbox, field = cell_id, frame = 0) =>
	sandbox.view.frames[frame]?.cells.find((cell) => cell.cell_id === field);
const finish = (sandbox: RuntimeSandbox): void => {
	sandbox.resume("continue");
	while (sandbox.view.status === "running") sandbox.drive();
};
const process_document = (req: SandboxExecutionRequest): ProcessDocument =>
	req.publication.snapshot.boxes.find((box) => box.id === process_id)!.document as ProcessDocument;
const canonical = (req: SandboxExecutionRequest): SandboxExecutionRequest => ({
	...req,
	publication: { ...req.publication, snapshot: normalize_project_source_snapshot(req.publication.snapshot) },
});
const child_id = id(50),
	leaf_id = id(51),
	copy_id = id(52),
	value_id = id(53);
const nested_request = (): SandboxExecutionRequest => {
	const req = request();
	const doc = process_document(req);
	const call = (n: number, mode: "copy" | "share"): ProcessDocument["program"]["body"][number] => ({
		id: id(n),
		kind: "call",
		box_id: child_id,
		init: [
			{ id: id(n + 1), kind: mode, caller_cell_id: cell_id, callee_cell_id: cell_id },
			{ id: id(n + 2), kind: "copy", caller_cell_id: cell_id, callee_cell_id: copy_id },
			{ id: id(n + 3), kind: "value", callee_cell_id: value_id, value: { id: id(n + 4), kind: "literal", type_id: number_id, value: 5 } },
		],
	});
	doc.program.body = [doc.program.body[0]!, call(300, "share"), call(310, "copy"), doc.program.body[1]!];
	const nodes = [
		{ id: number_id, kind: "scalar" as const, value_type: "number" as const },
		{
			id: id(11),
			kind: "record" as const,
			fields: [
				{ id: cell_id, name: "Count", type_id: number_id, required: true },
				{ id: copy_id, name: "Copy", type_id: number_id, required: true },
				{ id: value_id, name: "Value", type_id: number_id, required: true },
			],
		},
	];
	req.publication.snapshot.boxes.push({
		id: child_id,
		realm_id: id(2),
		parent_id: null,
		name: "Worker",
		document_version: "1",
		document: {
			schema: "box.document.v2",
			root_id: id(11),
			nodes,
			program: {
				schema: "box.program.v1",
				body: [
					{
						id: id(101),
						kind: "write",
						cell_id,
						value: {
							id: id(410),
							kind: "binary",
							type_id: number_id,
							operator: "add",
							left: { id: id(411), kind: "cell", type_id: number_id, cell_id: copy_id },
							right: { id: id(412), kind: "cell", type_id: number_id, cell_id: value_id },
						},
					},
					{ id: id(420), kind: "call", box_id: leaf_id, init: [{ id: id(421), kind: "share", caller_cell_id: cell_id, callee_cell_id: cell_id }] },
					{ id: id(430), kind: "write", cell_id: copy_id, value: { id: id(431), kind: "literal", type_id: number_id, value: 99 } },
				],
			},
		},
	});
	req.publication.snapshot.boxes.push({
		id: leaf_id,
		realm_id: id(2),
		parent_id: null,
		name: "Leaf",
		document_version: "1",
		document: {
			schema: "box.document.v2",
			root_id: id(11),
			nodes: structuredClone(document.nodes),
			program: {
				schema: "box.program.v1",
				body: [{ id: id(101), kind: "write", cell_id, value: { id: id(500), kind: "literal", type_id: number_id, value: 20 } }],
			},
		},
	});
	return canonical(req);
};

test("nested repeated value/copy/share calls have distinct live frames and identical normal trace, usage and inspection", () => {
	const req = { ...nested_request(), inspection: "values" as const };
	const sandbox = new RuntimeSandbox(req);
	sandbox.resume("into");
	sandbox.resume("into");
	expect(sandbox.view.frames.map((frame) => frame.box_id)).toEqual([process_id, child_id]);
	expect(current_cell(sandbox, copy_id, 1)).toMatchObject({ value: 7 });
	expect(current_cell(sandbox, value_id, 1)).toMatchObject({ value: 5 });
	const first_frame = sandbox.view.frames[1]!.frame_id;
	sandbox.resume("into");
	expect(current_cell(sandbox)).toMatchObject({ value: 12 });
	sandbox.resume("into");
	expect(sandbox.view.frames).toHaveLength(3);
	sandbox.resume("out");
	expect(sandbox.view.frames).toHaveLength(2);
	expect(current_cell(sandbox)).toMatchObject({ value: 20 });
	sandbox.resume("out");
	sandbox.resume("into");
	expect(sandbox.view.frames[1]!.frame_id).not.toBe(first_frame);
	sandbox.resume("into");
	expect(current_cell(sandbox)).toMatchObject({ value: 20 });
	expect(current_cell(sandbox, cell_id, 1)).toMatchObject({ value: 25 });
	finish(sandbox);
	expect(execute_process_runtime({ ...req, invocation_id: sandbox.view.session_id!, effect_receipts: [] })).toEqual(sandbox.view.outcome!);
});

test("over/out honor Box-qualified colliding breakpoints and continuing always progresses", () => {
	const sandbox = new RuntimeSandbox(nested_request());
	sandbox.set_breakpoints([{ box_id: leaf_id, statement_id: id(101) }]);
	sandbox.resume("over");
	expect(sandbox.view.reason).toBe("step");
	sandbox.resume("over");
	expect(sandbox.view.reason).toBe("breakpoint");
	expect(sandbox.view.frames.at(-1)?.box_id).toBe(leaf_id);
	sandbox.resume("continue");
	expect(sandbox.view.frames.at(-1)?.box_id).toBe(leaf_id);
	expect(sandbox.view.frames.at(-1)?.frame_id).toBe(4);
	sandbox.resume("continue");
	expect(sandbox.view.status).toBe("success");
	sandbox.restart();
	expect(sandbox.view.breakpoints).toEqual([]);
	sandbox.resume("into");
	sandbox.resume("into");
	sandbox.set_breakpoints([{ box_id: leaf_id, statement_id: id(101) }]);
	sandbox.resume("out");
	expect(sandbox.view.reason).toBe("breakpoint");
	expect(sandbox.view.frames.at(-1)?.box_id).toBe(leaf_id);
});

const effect_request = (): SandboxExecutionRequest => {
	const req = nested_request();
	const doc = process_document(req);
	doc.effects = [600, 610].map((n) => ({
		id: id(n),
		capability: "postgres.probe.append.v1",
		request_cell_id: cell_id,
		request_type_id: number_id,
		result_cell_id: cell_id,
		result_type_id: number_id,
	}));
	doc.program.body.push(...[601, 602].map((n, i) => ({ id: id(n), kind: "effect" as const, effect_id: id(600 + i * 10) })));
	return canonical({ ...req, inspection: "values" });
};

test("typed mock correction preserves pause and multiple effects resume without replay; real receipt parity", () => {
	const req = effect_request(),
		sandbox = new RuntimeSandbox(req);
	finish(sandbox);
	expect(sandbox.view).toMatchObject({ status: "effect", effect: { index: 0, request: 14 } });
	const paused = sandbox.view;
	expect(sandbox.submit_mock("wrong")).toBe(false);
	expect(sandbox.view).toBe(paused);
	expect(sandbox.submit_mock(25)).toBe(true);
	expect(sandbox.view.status).toBe("paused");
	expect(current_cell(sandbox)).toMatchObject({ value: 25 });
	finish(sandbox);
	expect(sandbox.view).toMatchObject({ status: "effect", effect: { index: 1, request: 25 }, usage: { calls: 5 } });
	const receipts: ProcessEffectReceipt[] = [
		{ statement_id: id(601), effect_id: id(600), capability: "postgres.probe.append.v1", request: 14, result: 25 },
		{ statement_id: id(602), effect_id: id(610), capability: "postgres.probe.append.v1", request: 25, result: 38 },
	];
	expect(sandbox.submit_mock(38)).toBe(true);
	expect(execute_process_runtime({ ...req, invocation_id: sandbox.view.session_id!, effect_receipts: receipts })).toEqual(sandbox.view.outcome!);
	const terminal = sandbox.view;
	sandbox.resume("into");
	sandbox.drive();
	sandbox.submit_mock(99);
	expect(sandbox.view).toBe(terminal);
});

test("unset differs from null and request, source, budget and exposed memory are detached", () => {
	const req = request(),
		doc = process_document(req);
	doc.nodes.push({ id: id(700), kind: "scalar", value_type: "absence" });
	const root = doc.nodes.find((node) => node.kind === "record")!;
	if (root.kind !== "record") throw new Error("Expected root");
	root.fields.push(
		{ id: id(701), name: "Absent", type_id: id(700), required: false },
		{ id: id(702), name: "Unset", type_id: number_id, required: false },
	);
	doc.input_cell_ids.push(id(701));
	const input = [
		{ cell_id, value: 3 },
		{ cell_id: id(701), value: null },
	];
	const start = canonical({ ...req, input }),
		sandbox = new RuntimeSandbox(start);
	const before = sandbox.view;
	expect(current_cell(sandbox, id(701))).toMatchObject({ status: "value", value: null });
	expect(current_cell(sandbox, id(702))).toEqual({ cell_id: id(702), type_id: number_id, status: "unset" });
	input[0]!.value = 99;
	start.budget.max_steps = 1;
	process_document(start).program.body.length = 0;
	expect(Object.isFrozen(sandbox.view.publication?.snapshot.boxes)).toBe(true);
	expect(Object.isFrozen(current_cell(sandbox))).toBe(true);
	sandbox.resume("into");
	expect(current_cell(sandbox)).toMatchObject({ value: 7 });
	expect(before.frames[0]?.cells.find((cell) => cell.cell_id === cell_id)).toMatchObject({ value: 3 });
	finish(sandbox);
	expect(sandbox.view.status).toBe("success");
	sandbox.restart();
	expect(current_cell(sandbox)).toMatchObject({ value: 3 });
	sandbox.stop();
	expect(sandbox.view).toMatchObject({ status: "stopped", publication: null, frames: [], outcome: null, breakpoints: [], session_id: null });
	sandbox.resume("continue");
	sandbox.restart();
	expect(sandbox.view.status).toBe("stopped");
});

test.each(["rejection", "uninitialized", "steps", "depth", "values", "strings", "effects"] as const)("shared engine parity for %s", (mode) => {
	let req = mode === "effects" ? effect_request() : nested_request();
	const doc = process_document(req);
	if (mode === "rejection") {
		doc.nodes.push({ id: id(800), kind: "scalar", value_type: "boolean" });
		doc.program.body.push({
			id: id(801),
			kind: "reject_if",
			code: "declined",
			condition: { id: id(802), kind: "literal", type_id: id(800), value: true },
		});
	}
	if (mode === "uninitialized") {
		doc.input_cell_ids = [];
		req.input = [];
		const root = doc.nodes.find((node) => node.kind === "record")!;
		if (root.kind === "record") root.fields[0]!.required = false;
		doc.program.body = [{ id: id(900), kind: "write", cell_id, value: { id: id(901), kind: "cell", cell_id, type_id: number_id } }];
	}
	if (mode === "steps") req.budget.max_steps = 5;
	if (mode === "depth") req.budget.max_call_depth = 2;
	if (mode === "values") req.budget.max_value_nodes = 2;
	if (mode === "strings") {
		const scalar = doc.nodes.find((node) => node.id === number_id)!;
		if (scalar.kind === "scalar") scalar.value_type = "string";
		req.input = [{ cell_id, value: "overflow" }];
		req.budget.max_string_units = 2;
		doc.program.body = [];
	}
	if (mode === "effects") req.budget.max_effects = 1;
	req = canonical({ ...req, inspection: "values" });
	const sandbox = new RuntimeSandbox(req);
	finish(sandbox);
	const receipts: ProcessEffectReceipt[] = [];
	if (mode === "effects") {
		const effect = sandbox.view.effect!;
		receipts.push({ ...effect, result: 10 });
		sandbox.submit_mock(10);
		finish(sandbox);
	}
	expect(sandbox.view.status).toBe(mode === "rejection" ? "rejected" : "fault");
	expect(execute_process_runtime({ ...req, invocation_id: sandbox.view.session_id!, effect_receipts: receipts })).toEqual(sandbox.view.outcome!);
});

test.each(["fault", "rejected"] as const)("terminal %s retains detached failing stack and cells", (mode) => {
	const req = nested_request();
	const leaf = req.publication.snapshot.boxes.find((box) => box.id === leaf_id)!.document;
	if (leaf.schema !== "box.document.v2") throw new Error("Expected executable leaf");
	const failure_id = id(6000);
	if (mode === "fault") {
		leaf.program.body = [
			{
				id: failure_id,
				kind: "write",
				cell_id,
				value: {
					id: id(6001),
					kind: "binary",
					type_id: number_id,
					operator: "divide",
					left: { id: id(6002), kind: "cell", cell_id, type_id: number_id },
					right: { id: id(6003), kind: "literal", type_id: number_id, value: 0 },
				},
			},
		];
	} else {
		leaf.nodes.push({ id: id(6004), kind: "scalar", value_type: "boolean" });
		leaf.program.body = [
			{ id: failure_id, kind: "reject_if", code: "declined", condition: { id: id(6005), kind: "literal", type_id: id(6004), value: true } },
		];
	}
	const sandbox = new RuntimeSandbox(canonical(req));
	finish(sandbox);
	expect(sandbox.view.status).toBe(mode);
	expect(sandbox.view.frames.map((frame) => frame.box_id)).toEqual([process_id, child_id, leaf_id]);
	expect(sandbox.view.frames.at(-1)).toMatchObject({ statement_id: failure_id });
	expect(current_cell(sandbox, cell_id, 2)).toMatchObject({ status: "value", value: 12 });
	const terminal = sandbox.view;
	expect(Object.isFrozen(terminal.frames.at(-1)?.cells)).toBe(true);
	sandbox.resume("continue");
	sandbox.drive();
	expect(sandbox.view).toBe(terminal);
	sandbox.restart();
	expect(sandbox.view.status).toBe("paused");
	expect(sandbox.view.frames).toHaveLength(1);
	expect(terminal.frames).toHaveLength(3);
	sandbox.stop();
	expect(sandbox.view.frames).toHaveLength(0);
});

test("output faults retain completed root memory without claiming an active statement", () => {
	const req = request();
	const doc = process_document(req);
	doc.input_cell_ids = [];
	req.input = [];
	const root = doc.nodes.find((node) => node.kind === "record")!;
	if (root.kind === "record") root.fields[0]!.required = false;
	doc.program.body = [];
	const sandbox = new RuntimeSandbox(canonical(req));
	expect(sandbox.view.status).toBe("fault");
	expect(sandbox.view.frames[0]).toMatchObject({ box_id: process_id, statement_id: null });
	expect(current_cell(sandbox)).toMatchObject({ status: "unset" });
});

test("long continue is bounded, preserves plan across batches and can be stopped", () => {
	const req = request(),
		doc = process_document(req);
	doc.program.body = Array.from({ length: 100 }, (_, n) => ({
		id: id(1000 + n),
		kind: "write",
		cell_id,
		value: { id: id(2000 + n), kind: "literal", type_id: number_id, value: n },
	}));
	req.budget.max_steps = 1000;
	const sandbox = new RuntimeSandbox(canonical(req));
	sandbox.resume("continue");
	expect(sandbox.view.status).toBe("running");
	expect(sandbox.view.usage.steps).toBe(128);
	sandbox.drive();
	expect(sandbox.view.status).toBe("success");
	sandbox.restart();
	sandbox.resume("continue");
	sandbox.stop();
	sandbox.drive();
	expect(sandbox.view.status).toBe("stopped");
});

test("snapshot rejects accessor backed and cyclic values without executing getters", () => {
	let calls = 0;
	const sparse: number[] = [];
	sparse.length = 2;
	sparse[1] = 1;
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	for (const value of [
		cyclic,
		{
			get unsafe() {
				calls += 1;
				return 1;
			},
		},
		sparse,
		Infinity,
	]) {
		expect(() => new RuntimeSandbox({ ...request(), input: [{ cell_id, value }] })).toThrow();
	}
	expect(calls).toBe(0);
});

test("collection expressions are atomic and nested caller and mock values cannot mutate live cells", () => {
	const req = request(),
		doc = process_document(req);
	const list_id = id(4000),
		list_cell = id(4001),
		item_id = id(4002);
	doc.nodes.push({ id: list_id, kind: "list", item_type_id: number_id });
	const root = doc.nodes.find((node) => node.kind === "record")!;
	if (root.kind !== "record") throw new Error("Expected root");
	root.fields.push({ id: list_cell, name: "Samples", type_id: list_id, required: true });
	doc.input_cell_ids.push(list_cell);
	doc.output_cell_ids = [list_cell];
	doc.effects = [
		{
			id: id(4010),
			capability: "samples.read.v1",
			request_cell_id: list_cell,
			request_type_id: list_id,
			result_cell_id: list_cell,
			result_type_id: list_id,
		},
	];
	doc.program.body = [
		{
			id: id(4020),
			kind: "write",
			cell_id: list_cell,
			value: {
				id: id(4021),
				kind: "list.map",
				type_id: list_id,
				item_binding_id: item_id,
				list: { id: id(4022), kind: "cell", type_id: list_id, cell_id: list_cell },
				value: {
					id: id(4023),
					kind: "binary",
					type_id: number_id,
					operator: "add",
					left: { id: id(4024), kind: "binding", type_id: number_id, binding_id: item_id },
					right: { id: id(4025), kind: "literal", type_id: number_id, value: 1 },
				},
			},
		},
		{ id: id(4030), kind: "effect", effect_id: id(4010) },
	];
	const samples = [1, 2, 3];
	req.input = [...req.input, { cell_id: list_cell, value: samples }];
	const exact = canonical({ ...req, inspection: "values" });
	const sandbox = new RuntimeSandbox(exact);
	const before = sandbox.view;
	samples[0] = 900;
	sandbox.resume("into");
	expect(current_cell(sandbox, list_cell)).toMatchObject({ value: [2, 3, 4] });
	expect(before.frames[0]?.cells.find((cell) => cell.cell_id === list_cell)).toMatchObject({ value: [1, 2, 3] });
	expect(sandbox.view.usage.steps).toBe(15);
	sandbox.resume("into");
	expect(sandbox.view.effect?.request).toEqual([2, 3, 4]);
	expect(Object.isFrozen(sandbox.view.effect?.request)).toBe(true);
	const pause = sandbox.view;
	expect(sandbox.submit_mock([1, "bad"])).toBe(false);
	expect(sandbox.view).toBe(pause);
	const mock = [4, 5];
	sandbox.submit_mock(mock);
	mock[0] = 99;
	expect(sandbox.view.outcome).toMatchObject({ status: "success", outputs: [{ cell_id: list_cell, value: [4, 5] }] });
	expect(Object.isFrozen(sandbox.view.outcome?.trace)).toBe(true);
	expect(
		execute_process_runtime({
			...exact,
			input: [
				{ cell_id, value: 3 },
				{ cell_id: list_cell, value: [1, 2, 3] },
			],
			invocation_id: sandbox.view.session_id!,
			effect_receipts: [{ statement_id: id(4030), effect_id: id(4010), capability: "samples.read.v1", request: [2, 3, 4], result: [4, 5] }],
		}),
	).toEqual(sandbox.view.outcome!);
});

test("restart from an effect removes prior mocks, and an over-budget typed mock faults like normal replay", () => {
	const req = effect_request(),
		sandbox = new RuntimeSandbox(req);
	finish(sandbox);
	const first_id = sandbox.view.session_id;
	sandbox.submit_mock(81);
	finish(sandbox);
	sandbox.restart();
	expect(sandbox.view.session_id).not.toBe(first_id);
	expect(sandbox.view.effect).toBeNull();
	finish(sandbox);
	expect(sandbox.view.effect).toMatchObject({ index: 0, request: 14 });
	sandbox.stop();
	expect(sandbox.submit_mock(1)).toBe(false);
	expect(sandbox.view.publication).toBeNull();
	const probe = new RuntimeSandbox(req);
	finish(probe);
	const limited = { ...req, budget: { ...req.budget, max_value_nodes: probe.view.usage.value_nodes } };
	const bounded = new RuntimeSandbox(limited);
	finish(bounded);
	expect(bounded.view.status).toBe("effect");
	expect(bounded.submit_mock(1)).toBe(true);
	expect(bounded.view.outcome).toMatchObject({ status: "fault", fault: { code: "budget_exceeded" } });
	expect(
		execute_process_runtime({
			...limited,
			invocation_id: bounded.view.session_id!,
			effect_receipts: [{ statement_id: id(601), effect_id: id(600), capability: "postgres.probe.append.v1", request: 14, result: 1 }],
		}),
	).toEqual(bounded.view.outcome!);
});

test("empty programs and invalid budgets terminate without exposing usable controls", () => {
	const req = request();
	process_document(req).program.body = [];
	const empty = new RuntimeSandbox(canonical(req));
	expect(empty.view.status).toBe("success");
	const view = empty.view;
	empty.resume("out");
	expect(empty.view).toBe(view);
	const invalid = new RuntimeSandbox({ ...req, budget: { ...req.budget, max_steps: 100001 } });
	expect(invalid.view.outcome).toMatchObject({ status: "fault", fault: { code: "invalid_budget" }, usage: { steps: 0 } });
	expect(invalid.set_breakpoints([{ box_id: process_id, statement_id: id(101) }])).toBe(false);
});
