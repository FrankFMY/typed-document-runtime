import { verify_scenario } from "./scenario.js";

try {
	const result = await verify_scenario();
	document.body.textContent = JSON.stringify(result);
	document.body.dataset.status = "pass";
} catch (error) {
	document.body.textContent = String(error);
	document.body.dataset.status = "fail";
	throw error;
}
