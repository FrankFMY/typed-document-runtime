// The Kernel's scalar comparison semantics, shared by executable binary operators
// and source-owned form visibility. Missing/invalid values never satisfy a predicate.
export type ScalarComparisonOperator = "equal" | "not_equal" | "less_than" | "less_or_equal" | "greater_than" | "greater_or_equal";
export type ComparableScalar = string | number | boolean;

export const compare_scalar = (operator: ScalarComparisonOperator, left: unknown, right: unknown): boolean => {
	if (typeof left !== typeof right || !["string", "number", "boolean"].includes(typeof left)) return false;
	if (typeof left === "number" && (!Number.isFinite(left) || !Number.isFinite(right))) return false;
	if (operator === "equal") return left === right;
	if (operator === "not_equal") return left !== right;
	if (!((typeof left === "number" && typeof right === "number") || (typeof left === "string" && typeof right === "string"))) return false;
	const order = left < right ? -1 : left > right ? 1 : 0;
	switch (operator) {
		case "less_than": return order < 0;
		case "less_or_equal": return order <= 0;
		case "greater_than": return order > 0;
		case "greater_or_equal": return order >= 0;
	}
};
