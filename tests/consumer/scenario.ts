import * as application_package from "@frankfmy/typed-document-runtime/application-package";
import * as application_package_merge from "@frankfmy/typed-document-runtime/application-package-merge";
import * as application_package_plan from "@frankfmy/typed-document-runtime/application-package-plan";
import * as box_document from "@frankfmy/typed-document-runtime/box-document";
import * as box_presentation from "@frankfmy/typed-document-runtime/box-presentation";
import * as box_program from "@frankfmy/typed-document-runtime/box-program";
import * as box_program_semantics from "@frankfmy/typed-document-runtime/box-program-semantics";
import * as box_type_system from "@frankfmy/typed-document-runtime/box-type-system";
import * as application_data_contract from "@frankfmy/typed-document-runtime/application-data-contract";
import * as application_data_query from "@frankfmy/typed-document-runtime/application-data-query";
import * as process_document from "@frankfmy/typed-document-runtime/process-document";
import * as process_contract from "@frankfmy/typed-document-runtime/process-contract";
import * as process_program from "@frankfmy/typed-document-runtime/process-program";
import * as process_runtime from "@frankfmy/typed-document-runtime/process-runtime";
import * as project_source_snapshot from "@frankfmy/typed-document-runtime/project-source-snapshot";
import * as project_source_history from "@frankfmy/typed-document-runtime/project-source-history";
import * as project_source_comparison from "@frankfmy/typed-document-runtime/project-source-comparison";
import * as published_document from "@frankfmy/typed-document-runtime/published-document";
import * as runtime from "@frankfmy/typed-document-runtime/runtime";

export const modules = {
	"application-package": application_package,
	"application-package-merge": application_package_merge,
	"application-package-plan": application_package_plan,
	"box-document": box_document,
	"box-presentation": box_presentation,
	"box-program": box_program,
	"box-program-semantics": box_program_semantics,
	"box-type-system": box_type_system,
	"application-data-contract": application_data_contract,
	"application-data-query": application_data_query,
	"process-document": process_document,
	"process-contract": process_contract,
	"process-program": process_program,
	"process-runtime": process_runtime,
	"project-source-snapshot": project_source_snapshot,
	"project-source-history": project_source_history,
	"project-source-comparison": project_source_comparison,
	"published-document": published_document,
	"runtime": runtime,
};
const id = (n: number): string => `20000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const root = id(10), text = id(11), output = id(12), input = id(13), effect = id(14), statement = id(15);

export async function verify_scenario() {
	let assertions = 0;
	function check(value: unknown, message: string): asserts value {
		assertions++;
		if (!value) throw new Error(message);
	}
	const equal = (actual: unknown, expected: unknown, message: string): void => check(JSON.stringify(actual) === JSON.stringify(expected), message);
	const throws = (run: () => unknown, message: string): void => {
		let failed = false;
		try { run(); } catch { failed = true; }
		check(failed, message);
	};
	check(Object.keys(modules).length === 19, "all 19 public subpaths");
	for (const [name, module] of Object.entries(modules)) check(Object.keys(module).length > 0, `empty public module: ${name}`);
	check(process_runtime.execute_process_runtime === runtime.execute_process_runtime, "one Process evaluator");
	const box: box_document.BoxDocument = {
		schema: "box.document.v2",
		root_id: root,
		nodes: [
			{ id: text, kind: "scalar", value_type: "string" },
			{ id: root, kind: "record", fields: [{ id: output, name: "title", type_id: text, required: false }] },
		],
		program: {
			schema: "box.program.v1",
			body: [2, 1].map((n) => ({ id: id(20 + n), kind: "write", cell_id: output, value: { id: id(30 + n), kind: "literal", type_id: text, value: `value-${n}` } })),
		},
	};
	const process: process_document.ProcessDocument = {
		schema: "process.document.v1",
		root_id: root,
		nodes: [
			{ id: text, kind: "scalar", value_type: "string" },
			{ id: root, kind: "record", fields: [
				{ id: output, name: "output", type_id: text, required: false },
				{ id: input, name: "input", type_id: text, required: true },
			] },
		],
		input_cell_ids: [input], output_cell_ids: [output],
		effects: [{ id: effect, capability: "example.echo.v1", request_cell_id: input, request_type_id: text, result_cell_id: output, result_type_id: text }],
		program: { schema: "process.program.v1", body: [{ id: statement, kind: "effect", effect_id: effect }] },
	};
	const canonical = box_document.normalize_box_document(box);
	check(box_document.is_canonical_box_document(canonical), "canonical document");
	equal(canonical.nodes.map((node) => node.id), [root, text], "canonical type sorting");
	const record = canonical.nodes.find((node) => node.id === root);
	check(record?.kind === "record", "record root");
	box_program_semantics.validate_box_program_semantics(canonical.nodes, record, box.program);
	equal(box_program.normalize_box_program(box.program).body.map((node) => node.id), [id(22), id(21)], "authored statement order");
	check(box_document.project_box_document_schema(canonical).declarations.length === 2, "type projection");
	const normalized_process = process_document.normalize_process_document(process);
	check(process_document.is_canonical_process_document(normalized_process), "canonical Process");
	equal(process_program.normalize_process_program(process.program), normalized_process.program, "process program normalization");
	check(published_document.is_canonical_published_document(normalized_process), "published union");
	const comparer = box_type_system.create_box_type_comparer();
	check(comparer.same_type(canonical, text, normalized_process, text), "structural type equality");
	check(!comparer.scalar_type(canonical, text, "number"), "scalar mismatch");
	throws(() => box_document.normalize_box_value_at(canonical, text, 42), "typed value rejection");

	const data = application_data_contract.normalize_application_data_schema({ schema: "box.document.v1", root_id: root, nodes: box.nodes });
	check(application_data_contract.application_data_operation_contracts(id(40), "1", data).length === 8, "eight data contracts");
	check(application_data_query.normalize_application_data_query(data, {}).limit === 25, "query defaults");
	check(box_presentation.normalize_box_presentation({ schema: "box.presentation.v1", label: { ru: "Example", en: "Example" }, fields: [] }, data).schema === "box.presentation.v1", "presentation binding");
	throws(() => box_presentation.normalize_box_presentation({ schema: "box.presentation.v1", fields: [] }, data), "empty presentation rejection");
	const requirement = process_contract.process_operation_contracts(normalized_process)[0]!;
	check(process_contract.check_process_operation_contract(requirement, requirement).compatible, "operation compatibility");
	check(!process_contract.check_process_operation_contract(requirement, null).compatible, "missing operation");

	const snapshot = project_source_snapshot.normalize_project_source_snapshot({
		schema: "project.source.snapshot.v1", project_id: id(1), revision: "1",
		realms: [{ id: id(2), name: " Main ", is_primary: true }],
		boxes: [
			{ id: id(4), realm_id: id(2), parent_id: null, name: "Echo", document_version: "1", document: process },
			{ id: id(3), realm_id: id(2), parent_id: null, name: "Title", document_version: "1", document: box },
		],
	});
	check(project_source_snapshot.is_canonical_project_source_snapshot(snapshot), "canonical snapshot");
	equal(snapshot.boxes.map((item) => item.id), [id(3), id(4)], "canonical box sorting");
	check(snapshot.realms[0]!.name === "Main", "name normalization");
	equal(project_source_comparison.compare_project_source(snapshot, structuredClone(snapshot)), [], "stable comparison");
	equal(application_package_merge.merge_package_source(snapshot, snapshot, snapshot).source, snapshot, "three-way no-op merge");
	check(project_source_history.parse_project_source_history_page({ project_id: id(1), head_revision: "1", items: [], next_before_revision: null }, { project_id: id(1), limit: 20 }) !== null, "history page validation");
	const budget = { max_steps: 100, max_call_depth: 8, max_value_nodes: 1000, max_string_units: 10000, max_effects: 4 };
	const publication = { id: id(5), snapshot };
	const box_request = { publication, entry_box_id: id(3), input: [], output_cell_ids: [output], budget, inspection: "values" as const };
	const result = runtime.execute_project_runtime(box_request);
	check(result.status === "success", "Box execution");
	equal(result.outputs, [{ cell_id: output, value: "value-1" }], "write order and output");
	equal(runtime.execute_project_runtime(box_request), result, "determinism");
	check(result.inspection?.events.length, "inspection records real execution");
	check(runtime.execute_project_runtime({ ...box_request, budget: { ...budget, max_steps: 1 } }).status === "fault", "budget enforcement");
	const request: runtime.ProcessExecutionRequest = { publication, process_id: id(4), invocation_id: id(6), input: [{ cell_id: input, value: "request" }], effect_receipts: [], budget };
	const intent = process_runtime.execute_process_runtime(request);
	check(intent.status === "effect", "effect suspension");
	check(intent.effect.request === "request" && intent.effect.capability === "example.echo.v1", "typed effect intent");
	const receipt = { statement_id: statement, effect_id: effect, capability: "example.echo.v1", request: "request", result: "response" };
	const resumed = process_runtime.execute_process_runtime({ ...request, effect_receipts: [receipt] });
	check(resumed.status === "success", "receipt replay");
	equal(resumed.outputs, [{ cell_id: output, value: "response" }], "replayed output");
	check(process_runtime.execute_process_runtime({ ...request, effect_receipts: [{ ...receipt, capability: "example.wrong.v1" }] }).status === "fault", "mismatched receipt");
	check(process_runtime.execute_process_runtime({ ...request, input: [{ cell_id: input, value: 42 }] }).status === "fault", "mismatched input");

	const sandbox = new runtime.RuntimeSandbox(request);
	check(sandbox.view.status === "paused", "sandbox entry pause");
	check(Object.isFrozen(sandbox.view) && Object.isFrozen(sandbox.view.frames), "detached frozen sandbox state");
	sandbox.resume("into");
	// Read a fresh view after each continuation transition.
	const effect_view = (): runtime.SandboxView => sandbox.view;
	check(effect_view().status === "effect", "sandbox effect suspension");
	const before_mock = sandbox.view;
	check(!sandbox.submit_mock(42) && sandbox.view === before_mock, "invalid mock preserves continuation");
	check(sandbox.submit_mock("response"), "typed mock acceptance");
	check(effect_view().status === "success", "sandbox completion");
	equal(sandbox.view.outcome?.status === "success" && sandbox.view.outcome.outputs, resumed.outputs, "sandbox replay parity");
	sandbox.restart();
	check(effect_view().status === "paused", "sandbox restart");
	sandbox.stop();
	check(effect_view().status === "stopped", "sandbox cleanup");

	const digest = await application_package.package_digest(snapshot);
	const pkg = await application_package.create_application_package({ name: "Example", publication: { id: id(5), content_digest: digest }, source: snapshot, data_schemas: [] });
	check(Object.isFrozen(pkg), "immutable application package");
	equal(await application_package.parse_application_package(JSON.parse(JSON.stringify(pkg))), pkg, "package round trip");
	let tamper_rejected = false;
	try { await application_package.parse_application_package({ ...pkg, name: "Changed" }); } catch { tamper_rejected = true; }
	check(tamper_rejected, "package tamper rejection");
	const golden = "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777";
	check(await application_package.package_digest({ a: 1, b: 2 }) === golden, "SHA-256 golden vector");
	check(await application_package.package_digest({ b: 2, a: 1 }) !== golden, "publication insertion-order identity");
	check(await application_package.package_operation_digest({ b: 2, a: 1 }) === golden, "operation sorted-key identity");
	const identity = await application_package_plan.package_identity(id(50), "box", id(3));
	check(identity === await application_package_plan.package_identity(id(50), "box", id(3)), "stable installation identity");
	check(identity !== await application_package_plan.package_identity(id(51), "box", id(3)), "installation isolation");
	return { status: "pass", assertions, subpaths: Object.keys(modules), digest, package_digest: pkg.digest, output: result.outputs, process_output: resumed.outputs };
}
