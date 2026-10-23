import type { BoxDocumentNode } from "./box-document.js";

type ResolvedBoxDocumentNode = Exclude<BoxDocumentNode, { kind: "reference" }>;

export interface BoxTypeDocument {
	readonly nodes: readonly BoxDocumentNode[];
}

export interface BoxTypeComparer {
	resolved_type(document: BoxTypeDocument, type_id: string): ResolvedBoxDocumentNode;
	same_type(left_document: BoxTypeDocument, left_type_id: string, right_document: BoxTypeDocument, right_type_id: string): boolean;
	scalar_type(document: BoxTypeDocument, type_id: string, expected: "string" | "number" | "boolean" | "absence"): boolean;
}

export const create_box_type_comparer = (failure: (message: string) => Error = (message) => new Error(message)): BoxTypeComparer => {
	const nodes_by_document = new WeakMap<BoxTypeDocument, Map<string, BoxDocumentNode>>();
	const resolved_by_document = new WeakMap<BoxTypeDocument, Map<string, ResolvedBoxDocumentNode>>();
	const equality_by_documents = new WeakMap<BoxTypeDocument, WeakMap<BoxTypeDocument, Map<string, boolean>>>();

	const nodes_for = (document: BoxTypeDocument): Map<string, BoxDocumentNode> => {
		const cached = nodes_by_document.get(document);
		if (cached) return cached;
		const nodes = new Map(document.nodes.map((item) => [item.id, item]));
		nodes_by_document.set(document, nodes);
		return nodes;
	};

	const resolved_type = (document: BoxTypeDocument, type_id: string): ResolvedBoxDocumentNode => {
		let cache = resolved_by_document.get(document);
		if (!cache) {
			cache = new Map();
			resolved_by_document.set(document, cache);
		}
		const cached = cache.get(type_id);
		if (cached) return cached;
		const nodes = nodes_for(document);
		let current = nodes.get(type_id);
		const traversed: string[] = [];
		const seen = new Set<string>();
		while (current?.kind === "reference") {
			if (seen.has(current.id)) throw failure("Runtime type graph is cyclic");
			seen.add(current.id);
			traversed.push(current.id);
			current = nodes.get(current.target_id);
		}
		if (!current) throw failure("Runtime type is missing");
		cache.set(type_id, current);
		for (const id of traversed) cache.set(id, current);
		return current;
	};

	const equality_cache = (left_document: BoxTypeDocument, right_document: BoxTypeDocument): Map<string, boolean> => {
		let by_right = equality_by_documents.get(left_document);
		if (!by_right) {
			by_right = new WeakMap();
			equality_by_documents.set(left_document, by_right);
		}
		let cache = by_right.get(right_document);
		if (!cache) {
			cache = new Map();
			by_right.set(right_document, cache);
		}
		return cache;
	};

	const same_type = (left_document: BoxTypeDocument, left_type_id: string, right_document: BoxTypeDocument, right_type_id: string): boolean => {
		const left = resolved_type(left_document, left_type_id);
		const right = resolved_type(right_document, right_type_id);
		const key = `${left.id}\0${right.id}`;
		const reverse_key = `${right.id}\0${left.id}`;
		const cache = equality_cache(left_document, right_document);
		const cached = cache.get(key);
		if (cached !== undefined) return cached;
		const reverse_cache = equality_cache(right_document, left_document);
		cache.set(key, true);
		reverse_cache.set(reverse_key, true);
		let equal = left.kind === right.kind;
		if (equal && left.kind === "scalar" && right.kind === "scalar") equal = left.value_type === right.value_type;
		if (equal && left.kind === "list" && right.kind === "list") {
			equal = same_type(left_document, left.item_type_id, right_document, right.item_type_id);
		}
		if (equal && left.kind === "record" && right.kind === "record") {
			equal =
				left.fields.length === right.fields.length &&
				left.fields.every((field, index) => {
					const other = right.fields[index];
					return (
						other !== undefined &&
						field.name === other.name &&
						field.required === other.required &&
						field.record_target?.entity_id === other.record_target?.entity_id &&
						same_type(left_document, field.type_id, right_document, other.type_id)
					);
				});
		}
		cache.set(key, equal);
		reverse_cache.set(reverse_key, equal);
		return equal;
	};

	return {
		resolved_type,
		same_type,
		scalar_type: (document, type_id, expected) => {
			const item = resolved_type(document, type_id);
			return item.kind === "scalar" && item.value_type === expected;
		},
	};
};
