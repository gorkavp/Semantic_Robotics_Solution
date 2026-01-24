import { Servient } from "@node-wot/core";
import { HttpClientFactory } from "@node-wot/binding-http";
import { WoT } from "wot-typescript-definitions";

const DEBUG = ["1", "true", "yes", "on"].includes(
	(process.env.DEBUG || "").toLowerCase(),
);

function debugLog(...args: unknown[]) {
	if (!DEBUG) return;
	const ts = new Date().toISOString();
	console.log(`[debug ${ts}]`, ...args);
}

function listTitles(tds: any[]): string[] {
	return tds
		.map((td) => td?.title)
		.filter((t): t is string => typeof t === "string")
		.sort();
}

function hrefFor(
	td: any,
	kind: "properties" | "actions",
	name: string,
): string | undefined {
	const forms = td?.[kind]?.[name]?.forms;
	if (
		Array.isArray(forms) &&
		forms.length > 0 &&
		typeof forms[0]?.href === "string"
	) {
		return forms[0].href;
	}
	return undefined;
}

async function main() {
	const servient = new Servient();
	servient.addClientFactory(new HttpClientFactory());

	const WoTHelpers = await servient.start();

	console.log("Blue Light Control script started...");
	console.log("Monitoring for blue cube detection...");

	try {
		// Fetch all TDs from Thing Directory
		debugLog("Fetching TD list from http://localhost:8081/things");
		const response = await fetch("http://localhost:8081/things");
		const allTDs = (await response.json()) as any[];
		debugLog("Thing Directory returned TD count:", allTDs?.length);

		// Find specific TDs by title
		const blueLightTD = allTDs.find(
			(td: any) => td.title === "virtualLightBlue",
		);
		const colorSensorTD = allTDs.find(
			(td: any) => td.title === "VirtualColorSensor",
		);

		if (!blueLightTD || !colorSensorTD) {
			throw new Error(
				[
					"Missing required TD(s) for blueLight script.",
					`Have titles: ${listTitles(allTDs).join(", ")}`,
					"Need: virtualLightBlue, VirtualColorSensor",
				].join("\n"),
			);
		}

		debugLog(
			"VirtualColorSensor objectPresence href:",
			hrefFor(colorSensorTD, "properties", "objectPresence"),
		);
		debugLog(
			"VirtualColorSensor color href:",
			hrefFor(colorSensorTD, "properties", "color"),
		);
		debugLog(
			"virtualLightBlue lightState href:",
			hrefFor(blueLightTD, "properties", "lightState"),
		);

		// Consume Things
		const blueLight = await WoTHelpers.consume(blueLightTD);
		const colorSensor = await WoTHelpers.consume(colorSensorTD);

		console.log("Connected to blue light and color sensor");

		// Initialize light to off
		await blueLight.writeProperty("lightState", false);

		const COLOR_THRESHOLD = 100;
		let blueCubeDetected = false;
		let lastHeartbeat = Date.now();

		// Monitor color sensor for blue cubes on the blue base
		const checkInterval = setInterval(async () => {
			try {
				const presence = await colorSensor.readProperty("objectPresence");
				const isPresent = (await presence.value()) as boolean;

				const now = Date.now();
				if (DEBUG && now - lastHeartbeat >= 2000) {
					debugLog(
						"objectPresence:",
						isPresent,
						"blueCubeDetected:",
						blueCubeDetected,
					);
					lastHeartbeat = now;
				}

				if (isPresent && !blueCubeDetected) {
					const colorValue = await colorSensor.readProperty("color");
					const rgb = (await colorValue.value()) as number[];
					const [r, g, b] = rgb;

					// Detect blue cube
					if (
						b > COLOR_THRESHOLD &&
						r < COLOR_THRESHOLD &&
						g < COLOR_THRESHOLD
					) {
						console.log("🔵 Blue cube detected! Triggering blue light...");

						// Turn on virtual blue light
						await blueLight.writeProperty("lightState", true);
						await blueLight.writeProperty("lightColor", [0, 0, 255]);

						console.log("✓ Virtual blue light activated");

						// TODO: Add Philips Hue integration here
						// This would require Philips Hue Bridge credentials and API calls
						console.log(
							"Note: Physical Philips Hue light control would be triggered here",
						);

						blueCubeDetected = true;

						// Keep running to maintain light state
						console.log("Blue light control active. Press Ctrl+C to exit.");
					}
				}
			} catch (error) {
				console.error("Error in monitoring loop:", error);
			}
		}, 500);

		// Keep the script running
		process.on("SIGINT", async () => {
			console.log("\nShutting down blue light control...");
			clearInterval(checkInterval);
			await blueLight.writeProperty("lightState", false);
			await servient.shutdown();
			process.exit(0);
		});
	} catch (error) {
		console.error("Error:", error);
		await servient.shutdown();
		process.exit(1);
	}
}

main();
