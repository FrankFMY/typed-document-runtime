import type { BoxDocument, BoxDocumentNode } from "@frankfmy/typed-document-runtime/box-document";
import type { BoxProgramStatement } from "@frankfmy/typed-document-runtime/box-program";
import type { ProcessExecutionRequest, ProcessExecutionOutcome, RuntimeBudget, SandboxView } from "@frankfmy/typed-document-runtime/runtime";
import type { ProcessEffectReceipt } from "@frankfmy/typed-document-runtime/process-runtime";

// @ts-expect-error Unknown wire schemas are not accepted by the declared API.
export const invalid_schema: BoxDocument["schema"] = "box.document.v99";
// @ts-expect-error Node kinds are a closed discriminated union.
export const invalid_node: BoxDocumentNode["kind"] = "object";
// @ts-expect-error An executable statement requires its cell and expression.
export const invalid_statement: BoxProgramStatement = { id: "id", kind: "write" };
// @ts-expect-error Budgets are numbers, without string coercion.
export const invalid_budget: RuntimeBudget = { max_steps: "100", max_call_depth: 8, max_value_nodes: 100, max_string_units: 1000 };
// @ts-expect-error Effect transcripts require a typed result payload field.
export const invalid_receipt: ProcessEffectReceipt = { statement_id: "id", effect_id: "id", capability: "example.echo.v1", request: "value" };

export function inspect_types(outcome: ProcessExecutionOutcome, view: SandboxView, request: ProcessExecutionRequest): string {
	if (outcome.status === "fault") {
		// @ts-expect-error Faults have no success outputs.
		void outcome.outputs;
		void outcome.fault.code;
	}
	// @ts-expect-error Public sandbox views are immutable.
	view.status = "running";
	// @ts-expect-error Process requests require an invocation identity.
	const incomplete: ProcessExecutionRequest = { publication: request.publication, process_id: request.process_id, input: [], effect_receipts: [], budget: request.budget };
	return incomplete.process_id;
}
// @ts-expect-error The package deliberately has no implicit root barrel.
export type { RuntimeBudget as RootBudget } from "@frankfmy/typed-document-runtime";
// @ts-expect-error Internal implementation files are not public subpaths.
export type { SandboxCellValue } from "@frankfmy/typed-document-runtime/dist/sandbox-state.js";
